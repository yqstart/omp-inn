//! 工作区提交 / 推送的任务编排（V19 两轨）。
//!
//! 两条轨道共用一套「任务表 + 事件流 + 取消」骨架：
//! - **快速轨（默认）**：`generate_commit_message`（壳侧单轮生成，见 `commit_msg.rs`）+
//!   `commit_selected`（`git commit`）/ `push_workspace`（`git push`）——秒级，但**不动
//!   CHANGELOG.md**、不拆分提交；
//! - **完整轨（可选入口）**：`start_full_commit` 走上游 `omp commit`（AI 生成信息 + changelog
//!   维护 + 校验器），慢但功能全。
//!
//! 与 V14 的差别：git 的写操作（staging / commit / push）由壳侧 git CLI 直接执行（见
//! `git_ops.rs`），只有「完整轨」才 spawn `omp commit`。上游那条流水线每次都要刷新模型
//! 注册表 + 多轮 agent，实测 16–35s，正是本次重构要绕开的东西。
//!
//! 并发模型不变：任务按 **cwd** 建表——不同工作区可并行，同一工作区拒绝重入
//! （前端按钮态 + 这里的 BUSY 双保险）。取消走 [`CancelToken`] → 杀当前子进程的进程组，
//! 一次任务可能跑多个子进程（stage → commit → push），所以用「标志位 + 通知」而不是
//! oneshot：oneshot 只能被 await 一次，多步之间会失效。

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::commands::{cmd_err, AppState, CmdError};
use crate::commit_msg;
use crate::git_info::{dir_exists, git_bin, run_git};
use crate::git_ops;
use crate::proc::{force_kill_group, login_path, ManagedChild};

// ---------- 任务表与取消 ----------

/// 一次任务的取消信号：多步任务（stage → commit → push）的每一步都要能看见它，
/// 所以是「标志位 + 通知」而不是 oneshot（oneshot 被 await 一次后就失效了）。
pub struct CancelToken {
    flag: AtomicBool,
    notify: tokio::sync::Notify,
    launch: Mutex<()>,
}

impl CancelToken {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { flag: AtomicBool::new(false), notify: tokio::sync::Notify::new(), launch: Mutex::new(()) })
    }

    pub fn cancel(&self) {
        let _guard = self.launch.lock().unwrap_or_else(|e| e.into_inner());
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_canceled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// 启动与取消串行；取消先发生时不再创建新的子进程。
    fn spawn_if_active<T>(&self, spawn: impl FnOnce() -> std::io::Result<T>) -> std::io::Result<Option<T>> {
        let _guard = self.launch.lock().unwrap_or_else(|e| e.into_inner());
        if self.is_canceled() { return Ok(None); }
        spawn().map(Some)
    }

    async fn wait(&self) {
        // 先创建通知等待对象再检查标志，避免取消发生在检查和订阅之间时漏掉唤醒。
        let notified = self.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.is_canceled() {
            return;
        }
        notified.await;
    }
}

/// 一个工作区的提交任务句柄。
pub struct CommitTask {
    seq: u64,
    /// 当前正在跑的子进程（取消 / 退出时打它的进程组）。
    pid: Option<u32>,
    cancel: Arc<CancelToken>,
}

/// 任务表：cwd → 句柄。
pub type CommitMap = Arc<Mutex<HashMap<String, CommitTask>>>;

/// 每次 spawn 的内部序号：收尾时用它确认「表里的还是我这一次任务」，
/// 防止「失败后立刻重跑」时旧任务误删新任务的槽位（与更新任务的 `UPDATE_SEQ` 同口径）。
static TASK_SEQ: AtomicU64 = AtomicU64::new(1);

/// 首流 EOF 后等另一流的宽限：omp 的 stdout 收尾后 stderr 可能还差几行。
const STREAM_GRACE: Duration = Duration::from_millis(400);
/// 错误摘要的尾部行数上限（stdout / stderr 各一份）。
const TAIL_MAX: usize = 8;
/// 各步的硬超时（omp 自带 `--max-time 2m`，这里再兜一层，防上游忽略参数时挂死）。
const GEN_TIMEOUT: Duration = Duration::from_secs(180);
const COMMIT_TIMEOUT: Duration = Duration::from_secs(120);
const PUSH_TIMEOUT: Duration = Duration::from_secs(120);
const FULL_TIMEOUT: Duration = Duration::from_secs(600);

// ---------- 前后端事件协议 ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommitPhase {
    /// 前端本地态：面板已打开、没有任务在跑（后端**从不**发这个值；枚举与前端保持同构）。
    #[allow(dead_code)]
    Idle,
    /// 预检（命令内同步做完，前端本地也先落一帧）。
    Checking,
    /// 快路径：正在生成提交信息。
    Generating,
    /// 快路径：信息已生成，等用户确认 / 编辑。
    Generated,
    /// 完整路径或提交中。
    Committing,
    Pushing,
    Committed,
    Pushed,
    /// 完整路径下「omp commit 跑完但没有产生提交」。
    Noop,
    Failed,
    Canceled,
}

/// 子进程的哪一路输出（快路径只把 stdout 当提交信息，stderr 只进日志）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OutStream {
    Stdout,
    Stderr,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CommitEvent {
    /// 输出行（已去 ANSI；stdout / stderr 混流，供完整轨的日志区）。
    Line { text: String },
    /// 快路径生成流：模型 stdout 的增量，前端直接追加进编辑框。
    Delta { text: String },
    /// 快路径生成结束：解析后的提交信息。
    Message { text: String },
    /// 阶段推进（Checking 由前端本地先落，后端从 Generating / Committing 起发）。
    Phase { phase: CommitPhase },
    /// 任务结束：终态与结果都在这条里。
    Exit { outcome: CommitOutcome },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitEntry {
    pub sha: String,
    pub subject: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutcome {
    pub phase: CommitPhase,
    /// 本次任务新建的提交（运行前后 HEAD 对比 + `git log` 读得）。
    /// 失败时也可能非空——commit 成功但 push 失败（部分成功）。
    pub commits: Vec<CommitEntry>,
    /// 快路径生成的信息（`generated` 终态里带回来，前端用它填编辑框）。
    pub message: Option<String>,
    pub error: Option<String>,
    pub hint: Option<String>,
}

impl CommitOutcome {
    fn new(phase: CommitPhase) -> Self {
        Self { phase, commits: vec![], message: None, error: None, hint: None }
    }
}

// ---------- 工作区 git 状态（行徽章用，只读） ----------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitState {
    pub path: String,
    pub is_repo: bool,
    /// 有未提交改动（含未跟踪文件——提交走 `add -A`，语义一致）。
    pub dirty: bool,
    /// 本地领先上游的提交数（无上游 / detached 时为 0）。
    pub ahead: u32,
    /// 本地落后上游的提交数（无上游 / detached 时为 0）。
    pub behind: u32,
    pub upstream: Option<String>,
    /// 上游分支已在远程被删除（`[gone]`）：upstream 名仍在，但没有可比较的远程分支。
    pub upstream_gone: bool,
}

impl WorkspaceGitState {
    fn unknown(path: String) -> Self {
        Self { path, is_repo: false, dirty: false, ahead: 0, behind: 0, upstream: None, upstream_gone: false }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StatusSummary {
    pub dirty: bool,
    pub ahead: u32,
    pub behind: u32,
    pub upstream: Option<String>,
    pub upstream_gone: bool,
}

/// 解析 `git status --porcelain` 的**头段**（`## …`，不含前导 `## ` 之外的空白）：
/// - `## main...origin/main [ahead 1, behind 2]` / `## feature` / `## HEAD (no branch)` /
///   `## main...origin/main [gone]`（上游被删除）。
///
/// 返回 `(upstream, ahead, behind, upstream_gone)`。
/// 独立成函数是因为 `git status --porcelain -b -z` 的头段是**第一个 NUL 段**（不是行），
/// `git_ops::get_change_set` 要用同一套语义解析它。
pub(crate) fn parse_status_header(head: &str) -> (Option<String>, u32, u32, bool) {
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut upstream = None;
    let mut upstream_gone = false;
    let head = head.strip_prefix("## ").unwrap_or(head);
    if head.starts_with("HEAD (no branch)") {
        return (None, 0, 0, false);
    }
    if let Some((_, rest)) = head.split_once("...") {
        let (name, bracket) = match rest.split_once(" [") {
            Some((n, b)) => (n, Some(b)),
            None => (rest, None),
        };
        if !name.trim().is_empty() {
            upstream = Some(name.trim().to_string());
        }
        if let Some(b) = bracket {
            for part in b.trim_end_matches(']').split(',') {
                let part = part.trim();
                if let Some(n) = part.strip_prefix("ahead ") {
                    ahead = n.trim().parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix("behind ") {
                    behind = n.trim().parse().unwrap_or(0);
                } else if part == "gone" {
                    upstream_gone = true;
                }
            }
        }
    }
    (upstream, ahead, behind, upstream_gone)
}

/// 解析 `git status --porcelain -b`：
/// - 头部交给 [`parse_status_header`]；
/// - 其余非空行 = 变更条目（含 `??` 未跟踪），有任意一条即 dirty。
pub fn parse_status_porcelain_b(out: &str) -> StatusSummary {
    let mut dirty = false;
    let mut summary = StatusSummary {
        dirty: false,
        ahead: 0,
        behind: 0,
        upstream: None,
        upstream_gone: false,
    };
    for (i, line) in out.lines().enumerate() {
        if i == 0 && line.starts_with("## ") {
            let (upstream, ahead, behind, gone) = parse_status_header(line);
            summary.upstream = upstream;
            summary.ahead = ahead;
            summary.behind = behind;
            summary.upstream_gone = gone;
            continue;
        }
        if !line.trim().is_empty() {
            dirty = true;
        }
    }
    summary.dirty = dirty;
    summary
}

/// 剥掉 ANSI 控制序列（CSI / OSC / 两字节转义）：omp 输出带少量颜色码，日志区只渲染纯文本。
pub fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            // CSI：ESC [ … 终止字节（0x40–0x7E）
            Some('[') => {
                chars.next();
                for c2 in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&c2) {
                        break;
                    }
                }
            }
            // OSC：ESC ] … BEL 或 ST（ESC \）
            Some(']') => {
                chars.next();
                while let Some(c2) = chars.next() {
                    if c2 == '\u{7}' {
                        break;
                    }
                    if c2 == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            // 其它两字节转义（ESC c 等）：吞掉
            Some(_) => {
                chars.next();
            }
            None => {}
        }
    }
    out
}

/// 失败摘要 → 人话 hint（只认几个高频 git / omp 报错，其余透传原文）。
pub fn failure_hint(error: &str) -> Option<&'static str> {
    let e = error.to_lowercase();
    if e.contains("no upstream branch") {
        Some("分支还没有上游：在终端里执行 git push -u <remote> <branch> 设置一次（或开启 git 的 push.autoSetupRemote）")
    } else if e.contains("could not read from remote repository")
        || e.contains("permission denied")
        || e.contains("authentication failed")
        || e.contains("could not read username")
    {
        Some("远端拒绝访问：检查仓库权限与本机 git 凭证（终端里先手动 push 一次即可写入系统凭证）")
    } else if e.contains("non-fast-forward") || e.contains("fetch first") || e.contains("failed to push some refs")
        || e.contains("rejected")
    {
        Some("远端有新提交或拒绝了这次推送：先在终端里 git pull --rebase 再推")
    } else if e.contains("hook declined") || e.contains("pre-commit") || e.contains("pre-push") {
        Some("被 git hook 拒绝：按上面的输出修掉再试")
    } else if e.contains("not fully merged") {
        Some("这个分支还没合并，删除需要强制")
    } else if e.contains("nothing to commit") {
        Some("暂存区是空的：确认勾选了文件、且文件确实有改动")
    } else {
        None
    }
}

// ---------- 子进程：spawn + 流式 + 收尾 ----------

/// 一次子进程运行的终局信号（退出码 / 是否被取消 / 两路输出的尾行摘要）。
pub(crate) struct RunSignals {
    pub canceled: bool,
    pub code: Option<i32>,
    pub out_tail: Vec<String>,
    pub err_tail: Vec<String>,
}

impl RunSignals {
    /// 失败摘要：stderr 优先，其次 stdout（git 的错误在 stderr，omp 的进度在 stdout）。
    /// `pub(crate)`：omp 更新任务（`omp_update.rs`）复用同一套摘要口径。
    pub(crate) fn error_text(&self) -> String {
        let mut parts: Vec<String> = vec![];
        if !self.err_tail.is_empty() {
            parts.push(self.err_tail.join("\n"));
        }
        if !self.out_tail.is_empty() {
            parts.push(self.out_tail.join("\n"));
        }
        if parts.is_empty() {
            match self.code {
                Some(c) => format!("进程异常结束（退出码 {c}）"),
                None => "进程被信号终止".to_string(),
            }
        } else {
            parts.join("\n\n")
        }
    }
}

fn push_tail(tail: &mut Vec<String>, text: &str) {
    // 保留行首缩进（omp 输出有树形缩进），只对整行空白做跳过。
    let t = text.trim_end();
    if t.trim().is_empty() {
        return;
    }
    tail.push(t.to_string());
    if tail.len() > TAIL_MAX {
        tail.remove(0);
    }
}

/// 读两路子进程输出直到收尾：每行去 ANSI 后回调（带流标记）；
/// 首流 EOF 后给另一流 `STREAM_GRACE` 宽限；取消令牌触发时杀直接子进程并打整个进程组。
pub(crate) async fn pump_child(
    child: impl Into<ManagedChild>,
    pid: Option<u32>,
    cancel: Option<&CancelToken>,
    on_line: impl FnMut(&str, OutStream),
) -> RunSignals {
    let mut child = child.into();
    let (signals, _) = pump_child_inner(&mut child, pid, cancel, on_line).await;
    if signals.canceled {
        let _ = child.wait_tree().await;
    }
    signals
}

async fn pump_child_inner(
    child: &mut ManagedChild,
    pid: Option<u32>,
    cancel: Option<&CancelToken>,
    mut on_line: impl FnMut(&str, OutStream),
) -> (RunSignals, bool) {
    let mut stdout = BufReader::new(child.stdout().take().expect("stdout piped")).lines();
    let mut stderr = BufReader::new(child.stderr().take().expect("stderr piped")).lines();
    let mut canceled = false;
    let mut tree_signaled = false;
    let mut out_tail: Vec<String> = vec![];
    let mut err_tail: Vec<String> = vec![];
    let mut stdout_open = true;
    let mut stderr_open = true;
    let mut grace: Option<tokio::time::Instant> = None;
    loop {
        let grace_sleep = async {
            match grace {
                Some(t) => tokio::time::sleep_until(t).await,
                None => std::future::pending::<()>().await,
            }
        };
        let cancel_wait = async {
            match cancel {
                Some(t) => t.wait().await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            _ = cancel_wait, if !canceled => {
                canceled = true;
                // 先停止进程树；Windows 提交任务通过作业对象覆盖父进程已退出的情况。
                tree_signaled = child.stop_tree(pid);
                break;
            }
            line = stdout.next_line(), if stdout_open => match line {
                Ok(Some(l)) => {
                    let text = strip_ansi(&l);
                    push_tail(&mut out_tail, &text);
                    on_line(&text, OutStream::Stdout);
                }
                _ => {
                    stdout_open = false;
                    if grace.is_none() && stderr_open {
                        grace = Some(tokio::time::Instant::now() + STREAM_GRACE);
                    }
                }
            },
            line = stderr.next_line(), if stderr_open => match line {
                Ok(Some(l)) => {
                    let text = strip_ansi(&l);
                    push_tail(&mut err_tail, &text);
                    on_line(&text, OutStream::Stderr);
                }
                _ => {
                    stderr_open = false;
                    if grace.is_none() && stdout_open {
                        grace = Some(tokio::time::Instant::now() + STREAM_GRACE);
                    }
                }
            },
            _ = grace_sleep => break,
        }
        if !stdout_open && !stderr_open {
            break;
        }
    }
    // 输出管道关闭并不代表进程已经退出，等待退出期间仍需响应取消。
    let code = if canceled {
        None
    } else if let Some(cancel) = cancel {
        tokio::select! {
            status = child.wait_parent() => status.ok().and_then(|s| s.code()),
            _ = cancel.wait() => {
                canceled = true;
                tree_signaled = child.stop_tree(pid);
                None
            }
        }
    } else {
        child.wait_parent().await.ok().and_then(|s| s.code())
    };
    (RunSignals { canceled, code, out_tail, err_tail }, tree_signaled)
}

enum PumpFailure {
    Timeout(&'static str),
    CancelCleanup,
}

impl PumpFailure {
    fn cleanup_confirmed(&self) -> bool {
        matches!(self, Self::Timeout(""))
    }

    fn message(self, timeout: &str) -> String {
        match self {
            Self::Timeout(detail) => format!("{timeout}{detail}"),
            Self::CancelCleanup => "取消后无法确认进程树已退出".into(),
        }
    }
}

/// 超时后仍持有子进程句柄，先停止进程树，再等待回收。
async fn pump_child_with_timeout(
    mut child: ManagedChild,
    pid: Option<u32>,
    cancel: Option<&CancelToken>,
    timeout: Duration,
    on_line: impl FnMut(&str, OutStream),
) -> Result<RunSignals, PumpFailure> {
    match tokio::time::timeout(timeout, pump_child_inner(&mut child, pid, cancel, on_line)).await {
        Ok((signals, tree_signaled)) if signals.canceled => {
            // 作业等待只调用一次：底层实现被中断后可能缓存父进程状态，不能重试当作确认。
            match tokio::time::timeout(Duration::from_secs(5), child.wait_tree()).await {
                Ok(Ok(_)) if tree_signaled => Ok(signals),
                _ => Err(PumpFailure::CancelCleanup),
            }
        }
        Ok((signals, _)) => Ok(signals),
        Err(_) => {
            let tree_signaled = child.stop_tree(pid);
            match tokio::time::timeout(Duration::from_secs(5), child.wait_tree()).await {
                Ok(Ok(_)) if tree_signaled => Err(PumpFailure::Timeout("")),
                Ok(Ok(_)) => Err(PumpFailure::Timeout("；无法确认进程树已退出")),
                _ => Err(PumpFailure::Timeout("；无法确认进程树已退出")),
            }
        }
    }
}

/// 起一个 git 子进程：新进程组（取消打 `-pid`）、登录 PATH、`kill_on_drop`、
/// `GIT_TERMINAL_PROMPT=0`（没有 TTY 时让 git 直接失败而不是等一个永远不来的输入）。
pub(crate) fn spawn_git(
    git: &str,
    cwd: &str,
    args: &[&str],
    stdin_text: Option<&str>,
) -> std::io::Result<ManagedChild> {
    let mut cmd = tokio::process::Command::new(git);
    cmd.args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(if stdin_text.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(path) = login_path() {
        cmd.env("PATH", path);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.as_std_mut().process_group(0);
    }
    let mut child = ManagedChild::spawn(cmd)?;
    if let Some(text) = stdin_text {
        if let Some(mut si) = child.stdin().take() {
            let data = text.to_string();
            // 与读流并发写（消息可能有几十 KB，串行写满管道会死锁）
            tokio::spawn(async move {
                let _ = si.write_all(data.as_bytes()).await;
                let _ = si.shutdown().await;
            });
        }
    }
    Ok(child)
}

/// 可取消的暂存写入；已取消时不启动进程，取消后先停止进程树再返回。
pub(crate) async fn run_git_stage(
    git: &str,
    cwd: &str,
    args: &[&str],
    cancel: &CancelToken,
    timeout: Duration,
) -> Result<(), CmdError> {
    let mut child = match cancel.spawn_if_active(|| spawn_git(git, cwd, args, None))
        .map_err(|e| cmd_err("STAGE_FAILED", format!("启动 git 失败：{e}"), None))? {
        Some(child) => child,
        None => return Err(stage_canceled()),
    };
    let pid = child.id();
    let mut stdout = child.stdout().take().ok_or_else(|| cmd_err("STAGE_FAILED", "无法读取 git 标准输出".into(), None))?;
    let mut stderr = child.stderr().take().ok_or_else(|| cmd_err("STAGE_FAILED", "无法读取 git 错误输出".into(), None))?;
    let mut out = Vec::new();
    let mut err = Vec::new();
    // 两路管道都读到结束，避免提前关闭错误输出影响仍在运行的 git。
    let result = tokio::select! {
        result = tokio::time::timeout(timeout, async {
            tokio::try_join!(child.wait_parent(), stdout.read_to_end(&mut out), stderr.read_to_end(&mut err))
        }) => Some(result),
        _ = cancel.wait() => None,
    };
    match result {
        Some(Ok(Ok((status, _, _)))) if status.success() => {
            if cancel.is_canceled() { Err(stage_canceled()) } else { Ok(()) }
        }
        Some(Ok(Ok(_))) => {
            let detail = String::from_utf8_lossy(&err).trim().to_string();
            Err(cmd_err("STAGE_FAILED", if detail.is_empty() { "git 命令失败".into() } else { detail }, None))
        }
        failure => {
            let canceled = failure.is_none();
            let reason = match failure {
                None => "暂存同步已取消".to_string(),
                Some(Err(_)) => "暂存同步超时".to_string(),
                Some(Ok(Err(e))) => format!("暂存同步失败：{e}"),
                Some(Ok(Ok(_))) => unreachable!(),
            };
            let signaled = child.stop_tree(pid);
            let waited = tokio::time::timeout(Duration::from_secs(5), async {
                tokio::try_join!(child.wait_tree(), stdout.read_to_end(&mut out), stderr.read_to_end(&mut err))
            }).await;
            if signaled && matches!(waited, Ok(Ok(_))) {
                if canceled { return Err(stage_canceled()); }
                Err(cmd_err("STAGE_FAILED", reason, None))
            } else {
                Err(cmd_err("STAGE_FAILED", format!("{reason}；无法确认进程树已退出，暂存状态可能已更改"), None))
            }
        }
    }
}

pub(crate) fn stage_canceled() -> CmdError {
    cmd_err("CANCELED", "暂存同步已取消，部分暂存状态可能已更改，请检查后重试".into(), None)
}

/// 暂存同步期间取消时仍发送终态，让前端刷新实际变更。
fn finish_selection_error(error: CmdError, on_event: &Channel<CommitEvent>) -> Result<(), CmdError> {
    if error.code != "CANCELED" { return Err(error); }
    let mut outcome = CommitOutcome::new(CommitPhase::Canceled);
    outcome.error = Some(error.message);
    let _ = on_event.send(CommitEvent::Exit { outcome });
    Ok(())
}

// ---------- 任务表小工具（只依赖 `CommitMap`，便于随后台任务一起 move） ----------

fn acquire(tasks: &CommitMap, cwd: &str) -> Result<(u64, Arc<CancelToken>), CmdError> {
    let mut map = tasks.lock().unwrap_or_else(|e| e.into_inner());
    if map.contains_key(cwd) {
        return Err(cmd_err("BUSY", "这个工作区已有提交任务在进行".into(), None));
    }
    let seq = TASK_SEQ.fetch_add(1, Ordering::Relaxed);
    let cancel = CancelToken::new();
    map.insert(cwd.to_string(), CommitTask { seq, pid: None, cancel: cancel.clone() });
    Ok((seq, cancel))
}

fn set_pid(tasks: &CommitMap, cwd: &str, seq: u64, pid: Option<u32>) {
    let mut map = tasks.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(t) = map.get_mut(cwd) {
        if t.seq == seq {
            t.pid = pid;
        }
    }
}

fn release(tasks: &CommitMap, cwd: &str, seq: u64) {
    let mut map = tasks.lock().unwrap_or_else(|e| e.into_inner());
    if map.get(cwd).map(|t| t.seq) == Some(seq) {
        map.remove(cwd);
    }
}

/// 预检：git 可用 + 目录存在 + 是仓库。返回 git 可执行文件路径。
async fn preflight(cwd: &str) -> Result<String, CmdError> {
    let git = git_bin()
        .await
        .ok_or_else(|| cmd_err("GIT_MISSING", "未找到 git".into(), Some("请安装 git 或在终端里确认 PATH".into())))?;
    if !dir_exists(cwd) {
        return Err(cmd_err("DIR_MISSING", "工作目录不存在".into(), None));
    }
    match run_git(&git, cwd, &["rev-parse", "--is-inside-work-tree"]).await {
        Ok(out) if out.trim() == "true" => Ok(git),
        Ok(_) => Err(cmd_err("NOT_REPO", "这个目录不是 git 仓库".into(), None)),
        Err(e) => Err(cmd_err("PREFLIGHT", e, None)),
    }
}

async fn head_sha(git: &str, dir: &str) -> Option<String> {
    run_git(git, dir, &["rev-parse", "HEAD"])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 读 `before..HEAD` 的提交（短 sha + subject）；空仓库 / 无 HEAD 时返回空表。
async fn commits_in_range(git: &str, dir: &str, before: Option<&str>) -> Vec<CommitEntry> {
    let range = before.map(|b| format!("{b}..HEAD")).unwrap_or_else(|| "-n 50".to_string());
    let out = match run_git(git, dir, &["log", "--format=%h%x1f%s", &range]).await {
        Ok(o) => o,
        Err(_) => return vec![],
    };
    out.lines()
        .filter_map(|l| {
            let (sha, subject) = l.split_once('\u{1f}')?;
            Some(CommitEntry { sha: sha.trim().to_string(), subject: subject.trim().to_string() })
        })
        .collect()
}

// ---------- git 步骤（可独立测试） ----------

/// `git commit`（消息走 stdin，避开 argv 长度与转义问题）。
pub(crate) async fn run_git_commit(
    git: &str,
    cwd: &str,
    message: &str,
    cancel: &CancelToken,
    on_line: &mut (impl FnMut(&str, OutStream) + Send),
) -> Result<RunSignals, String> {
    let args = ["commit", "--cleanup=strip", "-F", "-"];
    let child = match cancel.spawn_if_active(|| spawn_git(git, cwd, &args, Some(message)))
        .map_err(|e| format!("启动 git commit 失败：{e}"))? {
        Some(child) => child,
        None => return Ok(RunSignals { canceled: true, code: None, out_tail: vec![], err_tail: vec![] }),
    };
    let pid = child.id();
    match pump_child_with_timeout(child, pid, Some(cancel), COMMIT_TIMEOUT, |l, s| on_line(l, s)).await {
        Ok(signals) => Ok(signals),
        Err(failure) => Err(failure.message("git commit 超时（120s）")),
    }
}

/// `git push`（有上游直接推；没有上游时 `-u <remote> <branch>` 建立跟踪）。
/// 失败返回 `(错误文本, hint, 取消分支已完成)`。
pub(crate) async fn run_git_push(
    git: &str,
    cwd: &str,
    cancel: &CancelToken,
    on_line: &mut (impl FnMut(&str, OutStream) + Send),
) -> Result<(), (String, Option<String>, bool)> {
    if cancel.is_canceled() { return Err(("推送已取消".to_string(), None, true)); }
    // 分支：detached HEAD / 无提交时无法推送
    let head_out = run_git(git, cwd, &["status", "--porcelain=v1", "-b", "-z"])
        .await
        .map_err(|e| (e, None, false))?;
    let (header, _) = git_ops::split_status_header_z(&head_out);
    let (upstream, _, _, upstream_gone) = parse_status_header(header);
    let branch = run_git(git, cwd, &["symbolic-ref", "-q", "--short", "HEAD"])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ("游离 HEAD 不能推送，请先切换到分支".to_string(), None, false))?;
    // 上游被远程删掉（`[gone]`）时重新建立跟踪，而不是拿一个不存在的上游去推
    let has_upstream = upstream.is_some() && !upstream_gone;
    let remotes: Vec<String> = run_git(git, cwd, &["remote"])
        .await
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    let args = git_ops::push_args(&branch, has_upstream, &remotes).map_err(|e| {
        (e, Some("在终端里执行 git remote add origin <url>".to_string()), false)
    })?;
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let child = match cancel.spawn_if_active(|| spawn_git(git, cwd, &refs, None))
        .map_err(|e| (format!("启动 git push 失败：{e}"), None, false))? {
        Some(child) => child,
        None => return Err(("推送已取消".to_string(), None, true)),
    };
    let pid = child.id();
    let signals = match pump_child_with_timeout(child, pid, Some(cancel), PUSH_TIMEOUT, |l, s| on_line(l, s)).await {
        Ok(s) => s,
        Err(failure) => return Err((failure.message("git push 超时（120s）"), None, false)),
    };
    if signals.canceled {
        return Err(("推送已取消".to_string(), None, true));
    }
    if signals.code == Some(0) {
        return Ok(());
    }
    let error = signals.error_text();
    let hint = failure_hint(&error).map(str::to_string);
    Err((error, hint, false))
}

// ---------- 完整轨：omp commit ----------

/// `omp commit` 的命令行参数（纯函数，便于单测）：只有提交信息语言要求。
///
/// `context` = 前端按项目偏好给的语言要求，走 `--context=<值>`（等号形式，值里的空格与中文
/// 不经 shell 解析，原样传给上游）；`None` / 空白 = 「系统默认」档，不干预 omp 自身行为。
/// 推送不在这里做（V19 起推送由壳侧 `git push` 负责）。
fn commit_args(context: Option<&str>) -> Vec<String> {
    let mut args = vec!["commit".to_string()];
    if let Some(text) = context.map(str::trim).filter(|t| !t.is_empty()) {
        args.push(format!("--context={text}"));
    }
    args
}

/// spawn `omp commit [--context=…]`：新进程组（取消时打 `-pid` 覆盖内部的 git 子进程）、
/// 继承登录 shell 的 PATH（GUI .app 的 PATH 缺 Homebrew）、三路管道、kill_on_drop。
/// 命令层与真实仓库慢测试共用（见文末 `#[ignore]` 测试）。
pub(crate) fn spawn_omp_commit(bin: &str, cwd: &str, context: Option<&str>) -> std::io::Result<ManagedChild> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(commit_args(context));
    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(path) = login_path() {
        cmd.env("PATH", path);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.as_std_mut().process_group(0);
    }
    ManagedChild::spawn(cmd)
}

/// 完整轨的终态判定（纯函数）：退出码分不出「commit 失败」与「没东西可提交」，
/// 判据 = 退出码 / HEAD 是否变化；错误摘要取两路输出的尾行。
pub(crate) fn classify_full(signals: &RunSignals, head_changed: bool) -> (CommitPhase, Option<String>, Option<String>) {
    if signals.canceled {
        return (CommitPhase::Canceled, None, None);
    }
    if signals.code == Some(0) {
        return if head_changed { (CommitPhase::Committed, None, None) } else { (CommitPhase::Noop, None, None) };
    }
    let error = signals.error_text();
    let hint = failure_hint(&error).map(str::to_string);
    (CommitPhase::Failed, Some(error), hint)
}

async fn read_status(git: &str, dir: &str) -> Result<StatusSummary, String> {
    match run_git(git, dir, &["rev-parse", "--is-inside-work-tree"]).await {
        Ok(out) if out.trim() == "true" => {}
        Ok(_) => return Err("这个目录不是 git 仓库".into()),
        Err(e) => return Err(e),
    }
    let out = run_git(git, dir, &["status", "--porcelain", "-b"]).await?;
    Ok(parse_status_porcelain_b(&out))
}

// ---------- 命令 ----------

/// 批量读取工作区 git 状态（左栏行徽章）：每行一次 `status --porcelain -b`，并发跑。
/// git 不可用 / 目录不存在 / 非仓库都降级为 `isRepo:false`，不抛错。
#[tauri::command]
pub async fn get_workspace_git_state(paths: Vec<String>) -> Result<Vec<WorkspaceGitState>, CmdError> {
    let git = git_bin().await;
    let mut set = tokio::task::JoinSet::new();
    for (i, path) in paths.into_iter().enumerate() {
        let git = git.clone();
        set.spawn(async move {
            let state = match &git {
                Some(g) if dir_exists(&path) => match read_status(g, &path).await {
                    Ok(s) => WorkspaceGitState {
                        path: path.clone(),
                        is_repo: true,
                        dirty: s.dirty,
                        ahead: s.ahead,
                        behind: s.behind,
                        upstream: s.upstream,
                        upstream_gone: s.upstream_gone,
                    },
                    Err(_) => WorkspaceGitState::unknown(path.clone()),
                },
                _ => WorkspaceGitState::unknown(path.clone()),
            };
            (i, state)
        });
    }
    let mut out: Vec<(usize, WorkspaceGitState)> = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok((i, state)) = joined {
            out.push((i, state));
        }
    }
    out.sort_by_key(|(i, _)| *i);
    Ok(out.into_iter().map(|(_, s)| s).collect())
}

/// 快路径第一步：把勾选同步进暂存区 → 一次 `omp -p` 单轮生成提交信息。
/// **不提交**：信息回给前端（`generated` 终态 + `message`），由用户编辑后再点提交。
#[tauri::command]
pub async fn generate_commit_message(
    state: State<'_, AppState>,
    cwd: String,
    paths: Vec<String>,
    language: Option<String>,
    on_event: Channel<CommitEvent>,
) -> Result<(), CmdError> {
    let git = preflight(&cwd).await?;
    let _ = on_event.send(CommitEvent::Phase { phase: CommitPhase::Checking });
    let bin = resolve_omp(&state)?;
    let tasks = state.commit_tasks.clone();
    let (seq, cancel) = acquire(&tasks, &cwd)?;
    // 生成用的是「暂存区里将要提交的那份内容」，所以先按勾选同步暂存区
    if let Err(e) = git_ops::apply_selection_cancellable(&git, &cwd, &paths, &cancel).await {
        release(&tasks, &cwd, seq);
        return finish_selection_error(e, &on_event);
    }
    let cwd_key = cwd.clone();
    tokio::spawn(async move {
        let _ = on_event.send(CommitEvent::Phase { phase: CommitPhase::Generating });
        let role = commit_msg::read_commit_role(&bin, &cwd_key).await;
        let (model, thinking) = git_ops::commit_model_args(role.as_deref());
        let stat = commit_msg::staged_stat(&git, &cwd_key).await;
        let diff_raw = commit_msg::staged_diff(&git, &cwd_key).await;
        let (diff, truncated) = commit_msg::truncate_diff(&diff_raw, commit_msg::DIFF_LIMIT);
        if cancel.is_canceled() {
            let _ = on_event.send(CommitEvent::Exit { outcome: CommitOutcome::new(CommitPhase::Canceled) });
            release(&tasks, &cwd_key, seq);
            return;
        }
        if diff.trim().is_empty() {
            let mut outcome = CommitOutcome::new(CommitPhase::Failed);
            outcome.error = Some("暂存区里没有可提交的改动".into());
            outcome.hint = failure_hint("nothing to commit").map(str::to_string);
            let _ = on_event.send(CommitEvent::Exit { outcome });
            release(&tasks, &cwd_key, seq);
            return;
        }
        let prompt = commit_msg::build_commit_prompt(language.as_deref(), &stat, &diff, truncated);
        let args = commit_msg::generate_args(model.as_deref(), thinking.as_deref(), &cwd_key, &prompt);
        let child = match cancel.spawn_if_active(|| commit_msg::spawn_generate(&bin, &args, &cwd_key)) {
            Ok(Some(c)) => c,
            Ok(None) => {
                let _ = on_event.send(CommitEvent::Exit { outcome: CommitOutcome::new(CommitPhase::Canceled) });
                release(&tasks, &cwd_key, seq);
                return;
            }
            Err(e) => {
                let mut outcome = CommitOutcome::new(CommitPhase::Failed);
                outcome.error = Some(format!("启动 omp 失败：{e}"));
                let _ = on_event.send(CommitEvent::Exit { outcome });
                release(&tasks, &cwd_key, seq);
                return;
            }
        };
        let pid = child.id();
        set_pid(&tasks, &cwd_key, seq, pid);
        let mut buf = String::new();
        let mut log = |text: &str, stream: OutStream| match stream {
            OutStream::Stdout => {
                buf.push_str(text);
                buf.push('\n');
                let _ = on_event.send(CommitEvent::Delta { text: format!("{text}\n") });
            }
            OutStream::Stderr => {
                let _ = on_event.send(CommitEvent::Line { text: text.to_string() });
            }
        };
        let signals = match pump_child_with_timeout(child, pid, Some(&cancel), GEN_TIMEOUT, &mut log).await {
            Ok(s) => s,
            Err(failure) => {
                let mut outcome = CommitOutcome::new(CommitPhase::Failed);
                let cleanup_confirmed = failure.cleanup_confirmed();
                outcome.error = Some(failure.message("生成提交信息超时（180s）"));
                if cleanup_confirmed { outcome.hint = Some("可以改用「完整提交（含 CHANGELOG）」".into()); }
                let _ = on_event.send(CommitEvent::Exit { outcome });
                release(&tasks, &cwd_key, seq);
                return;
            }
        };
        let outcome = if signals.canceled {
            CommitOutcome::new(CommitPhase::Canceled)
        } else if signals.code != Some(0) {
            let error = signals.error_text();
            let mut outcome = CommitOutcome::new(CommitPhase::Failed);
            outcome.hint = failure_hint(&error).map(str::to_string);
            outcome.error = Some(error);
            outcome
        } else {
            let message = commit_msg::parse_commit_message(&buf);
            if message.is_empty() {
                let mut outcome = CommitOutcome::new(CommitPhase::Failed);
                outcome.error = Some("模型没有输出可用的提交信息".into());
                outcome.hint = Some("可以改用「完整提交（含 CHANGELOG）」".into());
                outcome
            } else {
                let mut outcome = CommitOutcome::new(CommitPhase::Generated);
                outcome.message = Some(message.clone());
                let _ = on_event.send(CommitEvent::Message { text: message });
                outcome
            }
        };
        let _ = on_event.send(CommitEvent::Exit { outcome });
        release(&tasks, &cwd_key, seq);
    });
    Ok(())
}

/// 快路径第二步：再同步一次勾选 → `git commit` →（可选）`git push`。
/// 消息由前端给（生成结果或用户手改）。
#[tauri::command]
pub async fn commit_selected(
    state: State<'_, AppState>,
    cwd: String,
    paths: Vec<String>,
    message: String,
    push: bool,
    on_event: Channel<CommitEvent>,
) -> Result<(), CmdError> {
    let git = preflight(&cwd).await?;
    let _ = on_event.send(CommitEvent::Phase { phase: CommitPhase::Checking });
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err(cmd_err("MESSAGE_EMPTY", "提交信息不能为空".into(), Some("先生成或填写提交信息".into())));
    }
    let tasks = state.commit_tasks.clone();
    let (seq, cancel) = acquire(&tasks, &cwd)?;
    if let Err(e) = git_ops::apply_selection_cancellable(&git, &cwd, &paths, &cancel).await {
        release(&tasks, &cwd, seq);
        return finish_selection_error(e, &on_event);
    }
    let cwd_key = cwd.clone();
    tokio::spawn(async move {
        let mut outcome = CommitOutcome::new(CommitPhase::Committing);
        let _ = on_event.send(CommitEvent::Phase { phase: CommitPhase::Committing });
        let before = head_sha(&git, &cwd_key).await;
        let mut log = |text: &str, _s: OutStream| {
            let _ = on_event.send(CommitEvent::Line { text: text.to_string() });
        };
        match run_git_commit(&git, &cwd_key, &message, &cancel, &mut log).await {
            Err(e) => {
                outcome.phase = CommitPhase::Failed;
                outcome.error = Some(e);
            }
            Ok(signals) if signals.canceled => outcome.phase = CommitPhase::Canceled,
            Ok(signals) if signals.code != Some(0) => {
                let error = signals.error_text();
                outcome.phase = CommitPhase::Failed;
                outcome.hint = failure_hint(&error).map(str::to_string);
                outcome.error = Some(error);
            }
            Ok(_) => {
                let after = head_sha(&git, &cwd_key).await;
                if after.is_some() && after != before {
                    outcome.commits = commits_in_range(&git, &cwd_key, before.as_deref()).await;
                    outcome.phase = CommitPhase::Committed;
                    if push {
                        let _ = on_event.send(CommitEvent::Phase { phase: CommitPhase::Pushing });
                        match run_git_push(&git, &cwd_key, &cancel, &mut log).await {
                            Ok(()) => outcome.phase = CommitPhase::Pushed,
                            Err((error, hint, _)) => {
                                // 部分成功：提交已成立，只有推送失败
                                outcome.phase = CommitPhase::Failed;
                                outcome.error = Some(error);
                                outcome.hint = hint;
                            }
                        }
                    }
                } else {
                    outcome.phase = CommitPhase::Failed;
                    outcome.error = Some("git commit 结束但没有产生新提交".into());
                    outcome.hint = failure_hint("nothing to commit").map(str::to_string);
                }
            }
        }
        let _ = on_event.send(CommitEvent::Exit { outcome });
        release(&tasks, &cwd_key, seq);
    });
    Ok(())
}

/// 完整轨：先把勾选同步进暂存区（上游见到非空暂存区就不会再 `add -A`），
/// 再跑 `omp commit`（AI 信息 + changelog 维护 + 校验器）。慢但功能全。
#[tauri::command]
pub async fn start_full_commit(
    state: State<'_, AppState>,
    cwd: String,
    paths: Vec<String>,
    language: Option<String>,
    on_event: Channel<CommitEvent>,
) -> Result<(), CmdError> {
    let git = preflight(&cwd).await?;
    let _ = on_event.send(CommitEvent::Phase { phase: CommitPhase::Checking });
    let bin = resolve_omp(&state)?;
    let tasks = state.commit_tasks.clone();
    let (seq, cancel) = acquire(&tasks, &cwd)?;
    if let Err(e) = git_ops::apply_selection_cancellable(&git, &cwd, &paths, &cancel).await {
        release(&tasks, &cwd, seq);
        return finish_selection_error(e, &on_event);
    }
    let cwd_key = cwd.clone();
    tokio::spawn(async move {
        let mut outcome = CommitOutcome::new(CommitPhase::Committing);
        let _ = on_event.send(CommitEvent::Phase { phase: CommitPhase::Committing });
        let before = head_sha(&git, &cwd_key).await;
        let child = match cancel.spawn_if_active(|| spawn_omp_commit(&bin, &cwd_key, language.as_deref())) {
            Ok(Some(c)) => c,
            Ok(None) => {
                outcome.phase = CommitPhase::Canceled;
                let _ = on_event.send(CommitEvent::Exit { outcome });
                release(&tasks, &cwd_key, seq);
                return;
            }
            Err(e) => {
                outcome.phase = CommitPhase::Failed;
                outcome.error = Some(format!("启动 omp commit 失败：{e}"));
                let _ = on_event.send(CommitEvent::Exit { outcome });
                release(&tasks, &cwd_key, seq);
                return;
            }
        };
        let pid = child.id();
        set_pid(&tasks, &cwd_key, seq, pid);
        let mut log = |text: &str, _s: OutStream| {
            let _ = on_event.send(CommitEvent::Line { text: text.to_string() });
        };
        let signals = match pump_child_with_timeout(child, pid, Some(&cancel), FULL_TIMEOUT, &mut log).await {
            Ok(s) => s,
            Err(failure) => {
                outcome.phase = CommitPhase::Failed;
                let cleanup_confirmed = failure.cleanup_confirmed();
                outcome.error = Some(failure.message("omp commit 超时（600s）"));
                if cleanup_confirmed { outcome.hint = Some("可以改用快速提交".into()); }
                let _ = on_event.send(CommitEvent::Exit { outcome });
                release(&tasks, &cwd_key, seq);
                return;
            }
        };
        let after = head_sha(&git, &cwd_key).await;
        let head_changed = after.is_some() && after != before;
        let (phase, error, hint) = classify_full(&signals, head_changed);
        outcome.phase = phase;
        outcome.error = error;
        outcome.hint = hint;
        if head_changed {
            outcome.commits = commits_in_range(&git, &cwd_key, before.as_deref()).await;
        }
        let _ = on_event.send(CommitEvent::Exit { outcome });
        release(&tasks, &cwd_key, seq);
    });
    Ok(())
}

/// 只推送（行徽章的「待推送」点击、失败后的重试都走它）。
#[tauri::command]
pub async fn push_workspace(state: State<'_, AppState>, cwd: String, on_event: Channel<CommitEvent>) -> Result<(), CmdError> {
    let git = preflight(&cwd).await?;
    let _ = on_event.send(CommitEvent::Phase { phase: CommitPhase::Checking });
    let tasks = state.commit_tasks.clone();
    let (seq, cancel) = acquire(&tasks, &cwd)?;
    let cwd_key = cwd.clone();
    tokio::spawn(async move {
        let _ = on_event.send(CommitEvent::Phase { phase: CommitPhase::Pushing });
        let mut log = |text: &str, _s: OutStream| {
            let _ = on_event.send(CommitEvent::Line { text: text.to_string() });
        };
        let mut outcome = CommitOutcome::new(CommitPhase::Pushing);
        match run_git_push(&git, &cwd_key, &cancel, &mut log).await {
            Ok(()) => outcome.phase = CommitPhase::Pushed,
            Err((error, hint, canceled)) => {
                outcome.phase = if canceled { CommitPhase::Canceled } else { CommitPhase::Failed };
                outcome.error = Some(error);
                outcome.hint = hint;
            }
        }
        let _ = on_event.send(CommitEvent::Exit { outcome });
        release(&tasks, &cwd_key, seq);
    });
    Ok(())
}

/// 取消运行中的任务：通知执行方停止进程树并确认清理结果。
#[tauri::command]
pub async fn cancel_commit_task(state: State<'_, AppState>, cwd: String) -> Result<(), CmdError> {
    let cancel = {
        let map = state.commit_tasks.lock().unwrap_or_else(|e| e.into_inner());
        match map.get(&cwd) {
            Some(t) => t.cancel.clone(),
            None => return Err(cmd_err("NOT_RUNNING", "当前没有进行中的提交任务".into(), None)),
        }
    };
    cancel.cancel();
    Ok(())
}

/// omp 可执行文件：缓存优先，其次探测（与 `git_commit::run` 同口径）。
fn resolve_omp(state: &State<'_, AppState>) -> Result<String, CmdError> {
    let cached = state.omp_path.try_lock().ok().and_then(|g| g.clone());
    cached.or_else(|| crate::commands::discover_omp_path(state)).ok_or_else(|| {
        cmd_err(
            "OMP_MISSING",
            "未找到 omp，无法生成提交信息".into(),
            Some("请先安装 oh-my-pi 或在设置中指定路径".into()),
        )
    })
}

/// 应用退出前的收尾：取消全部提交任务（正常退出路径；崩溃残留接受为已知边界）。
pub fn kill_all(tasks: &CommitMap) {
    let mut guard = tasks.lock().unwrap_or_else(|e| e.into_inner());
    for (_, t) in guard.drain() {
        t.cancel.cancel();
        if let Some(pid) = t.pid {
            force_kill_group(pid);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_removes_csi_osc_and_bare_escapes() {
        assert_eq!(strip_ansi("\u{1b}[38;2;245;224;220mchore: hi\u{1b}[39m"), "chore: hi");
        assert_eq!(strip_ansi("前\u{1b}[1m中\u{1b}[0m后"), "前中后");
        assert_eq!(strip_ansi("\u{1b}]8;;https://x\u{7}link\u{1b}]8;;\u{7}"), "link");
        assert_eq!(strip_ansi("\u{1b}]8;;https://x\u{1b}\\link\u{1b}]8;;\u{1b}\\"), "link");
        assert_eq!(strip_ansi("plain 文本"), "plain 文本");
        // 未终止的 CSI：吞到结尾，不 panic
        assert_eq!(strip_ansi("abc\u{1b}[38;2"), "abc");
    }

    #[test]
    fn header_parser_matches_line_and_z_inputs() {
        // 头段解析是 `-b`（行）与 `-b -z`（第一个 NUL 段）共用的语义
        assert_eq!(
            parse_status_header("## main...origin/main [ahead 1, behind 2]"),
            (Some("origin/main".into()), 1, 2, false)
        );
        assert_eq!(parse_status_header("## feature"), (None, 0, 0, false));
        assert_eq!(parse_status_header("## HEAD (no branch)"), (None, 0, 0, false));
        assert_eq!(
            parse_status_header("## main...origin/main [gone]"),
            (Some("origin/main".into()), 0, 0, true)
        );
    }

    #[test]
    fn status_parses_dirty_ahead_and_upstream() {
        let s = parse_status_porcelain_b("## main...origin/main [ahead 2]\n M a.txt\n?? b.txt\n");
        assert!(s.dirty);
        assert_eq!(s.ahead, 2);
        assert_eq!(s.behind, 0);
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert!(!s.upstream_gone);
    }

    #[test]
    fn status_parses_clean_synced_and_behind_only() {
        let s = parse_status_porcelain_b("## main...origin/main\n");
        assert!(!s.dirty);
        assert_eq!(s.ahead, 0);
        assert_eq!(s.behind, 0);
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));

        let s = parse_status_porcelain_b("## main...origin/main [behind 3]\n");
        assert_eq!(s.ahead, 0);
        assert_eq!(s.behind, 3);

        // ahead 与 behind 同时存在（分叉）
        let s = parse_status_porcelain_b("## main...origin/main [ahead 1, behind 2]\n");
        assert_eq!((s.ahead, s.behind), (1, 2));
    }

    #[test]
    fn status_parses_no_upstream_and_detached() {
        let s = parse_status_porcelain_b("## feature\n M x\n");
        assert!(s.dirty);
        assert_eq!(s.ahead, 0);
        assert_eq!(s.upstream, None);
        assert!(!s.upstream_gone);

        let s = parse_status_porcelain_b("## HEAD (no branch)\n");
        assert!(!s.dirty);
        assert_eq!(s.upstream, None);
    }

    #[test]
    fn status_parses_gone_upstream() {
        // 上游名仍在，但远程分支已被删除：ahead / behind 都无法比较
        let s = parse_status_porcelain_b("## main...origin/main [gone]\n");
        assert!(!s.dirty);
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert!(s.upstream_gone);
        assert_eq!((s.ahead, s.behind), (0, 0));
    }

    #[test]
    fn commit_args_carries_context_only() {
        assert_eq!(commit_args(None), ["commit"]);
        assert_eq!(commit_args(Some(" 用中文写 ")), ["commit", "--context=用中文写"]);
        // 空白要求视作不传（「系统默认」档就是 None，这里防前端误传空串）
        assert_eq!(commit_args(Some("   ")), ["commit"]);
    }

    #[test]
    fn failure_hint_recognizes_common_git_errors() {
        assert!(failure_hint("fatal: The current branch feature has no upstream branch.").is_some());
        assert!(failure_hint("fatal: Could not read from remote repository.").is_some());
        assert!(failure_hint("! [rejected] main -> main (non-fast-forward)").is_some());
        assert!(failure_hint("error: failed to push some refs to 'origin'").is_some());
        assert!(failure_hint("remote: error: hook declined").is_some());
        assert!(failure_hint("fatal: could not read Username for 'https://x': terminal prompts disabled").is_some());
        assert!(failure_hint("some other failure").is_none());
    }

    #[test]
    fn classify_full_covers_noop_failure_and_cancel() {
        let ok = RunSignals { canceled: false, code: Some(0), out_tail: vec![], err_tail: vec![] };
        assert_eq!(classify_full(&ok, true).0, CommitPhase::Committed);
        // omp commit 跑完但没产生提交（无改动 / 上游自己判断无需提交）
        assert_eq!(classify_full(&ok, false).0, CommitPhase::Noop);

        let canceled = RunSignals { canceled: true, code: Some(-1), out_tail: vec![], err_tail: vec![] };
        assert_eq!(classify_full(&canceled, false).0, CommitPhase::Canceled);

        let failed = RunSignals {
            canceled: false,
            code: Some(1),
            out_tail: vec!["● Commit created.".into()],
            err_tail: vec!["fatal: The current branch feature has no upstream branch.".into()],
        };
        let (phase, error, hint) = classify_full(&failed, true);
        assert_eq!(phase, CommitPhase::Failed);
        assert!(error.as_deref().unwrap_or_default().contains("no upstream"));
        assert!(hint.is_some());
    }

    // ---------- 真实仓库（快；只用 git，不消耗 AI） ----------

    /// 建一个临时仓库（含 bare 远端），返回 `(root, work, remote)` 字符串路径。
    async fn temp_repo(tag: &str) -> (std::path::PathBuf, String, String) {
        let Some(git) = git_bin().await else { panic!("未找到 git") };
        let root = std::env::temp_dir().join(format!("omp-inn-v19-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let work = root.join("work");
        let remote = root.join("remote");
        std::fs::create_dir_all(&work).unwrap();
        for (dir, extra) in [(&work, None), (&remote, Some("--bare"))] {
            let mut cmd = std::process::Command::new(&git);
            cmd.args(["init", "--initial-branch=main"]).arg(dir);
            if let Some(e) = extra {
                cmd.arg(e);
            }
            assert!(cmd.output().unwrap().status.success());
        }
        let g = |dir: &str, args: &[&str]| {
            let out = std::process::Command::new(&git).arg("-C").arg(dir).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?} 失败：{}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let w = work.to_string_lossy().to_string();
        let r = remote.to_string_lossy().to_string();
        g(&w, &["config", "user.email", "e2e@test.local"]);
        g(&w, &["config", "user.name", "omp e2e"]);
        (root, w, r)
    }

    #[tokio::test]
    async fn real_repo_selection_stages_only_picked_files() {
        let (root, work, _remote) = temp_repo("select").await;
        let Some(git) = git_bin().await else { panic!("未找到 git") };
        let g = |args: &[&str]| {
            let out = std::process::Command::new(&git).arg("-C").arg(&work).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?} 失败：{}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        g(&["commit", "--allow-empty", "-m", "chore: init"]);
        std::fs::write(format!("{work}/a.txt"), "a\n").unwrap();
        std::fs::write(format!("{work}/b.txt"), "b\n").unwrap();
        g(&["add", "a.txt"]);
        g(&["commit", "-m", "chore: a"]);
        // a.txt 改动（已跟踪）+ b.txt 改动 + c.txt 未跟踪
        std::fs::write(format!("{work}/a.txt"), "a2\n").unwrap();
        std::fs::write(format!("{work}/b.txt"), "b2\n").unwrap();
        std::fs::write(format!("{work}/c.txt"), "c\n").unwrap();

        // 只勾 c.txt：a/b 都不能进暂存区
        git_ops::apply_selection(&git, &work, &["c.txt".to_string()]).await.unwrap();
        let staged = git_ops::staged_paths(&git, &work).await.unwrap();
        assert_eq!(staged, vec!["c.txt"]);

        let cancel = CancelToken::new();
        let mut lines: Vec<String> = vec![];
        let signals = run_git_commit(&git, &work, "feat: Added c.txt\n\n- 新增 c\n", &cancel, &mut |l, _| {
            lines.push(l.to_string())
        })
        .await
        .expect("git commit 启动失败");
        assert_eq!(signals.code, Some(0), "提交失败：{lines:?}");
        assert_eq!(
            g(&["show", "--name-only", "--format=%s", "HEAD"])
                .lines()
                .filter(|l| !l.trim().is_empty())
                .collect::<Vec<_>>(),
            ["feat: Added c.txt", "c.txt"]
        );
        // 正文原样保留（`--cleanup=strip` 只去首尾空行）
        assert_eq!(g(&["log", "-1", "--format=%B"]), "feat: Added c.txt\n\n- 新增 c");
        // 另外两个文件仍是未提交状态
        let rest = g(&["status", "--porcelain", "-uall"]);
        assert!(rest.contains("a.txt") && rest.contains("b.txt"), "{rest}");

        // 再勾 a.txt：c 已提交，暂存区应当只剩 a
        git_ops::apply_selection(&git, &work, &["a.txt".to_string()]).await.unwrap();
        assert_eq!(git_ops::staged_paths(&git, &work).await.unwrap(), vec!["a.txt"]);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn real_repo_selection_skips_vanished_and_ignored_paths() {
        let (root, work, _remote) = temp_repo("skip-dead").await;
        let Some(git) = git_bin().await else { panic!("未找到 git") };
        let g = |args: &[&str]| {
            let out = std::process::Command::new(&git).arg("-C").arg(&work).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?} 失败：{}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        g(&["commit", "--allow-empty", "-m", "chore: init"]);
        std::fs::write(format!("{work}/kept.txt"), "k\n").unwrap();
        // 面板打开后消失的未跟踪文件（曾经的坑：整批 `git add` 报
        // `fatal: pathspec 'ghost.txt' did not match any files`）
        std::fs::write(format!("{work}/ghost.txt"), "g\n").unwrap();
        std::fs::remove_file(format!("{work}/ghost.txt")).unwrap();
        // 面板打开后新被 .gitignore 覆盖的未跟踪文件（旧实现在 add 时报 ignored 错误）
        std::fs::write(format!("{work}/.gitignore"), "*.log\n").unwrap();
        std::fs::write(format!("{work}/trace.log"), "l\n").unwrap();
        // 未跟踪目录（porcelain 给 `docs/`）：按其下文件前缀保留
        std::fs::create_dir_all(format!("{work}/docs")).unwrap();
        std::fs::write(format!("{work}/docs/a.md"), "d\n").unwrap();

        git_ops::apply_selection(
            &git,
            &work,
            &["kept.txt".into(), "ghost.txt".into(), "trace.log".into(), "docs/".into()],
        )
        .await
        .expect("消失 / 被忽略的路径不该拖垮整批暂存");
        assert_eq!(
            git_ops::staged_paths(&git, &work).await.unwrap(),
            vec!["docs/a.md", "kept.txt"]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn real_repo_selection_keeps_staged_deletion() {
        let (root, work, _remote) = temp_repo("staged-delete").await;
        let Some(git) = git_bin().await else { panic!("未找到 git") };
        let g = |args: &[&str]| {
            let out = std::process::Command::new(&git).arg("-C").arg(&work).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?} 失败：{}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        g(&["commit", "--allow-empty", "-m", "chore: init"]);
        std::fs::write(format!("{work}/gone.txt"), "g\n").unwrap();
        g(&["add", "gone.txt"]);
        g(&["commit", "-m", "chore: add gone"]);
        // 已暂存的删除条目（porcelain `D `，面板默认勾选就包含它）：该路径在索引与工作区
        // 都已不存在，旧实现 `git add -A -- gone.txt` 报 pathspec 并拖垮整批（用户实测：
        // 改名后的 `src/lib/ompSettings.test.ts`）
        std::fs::remove_file(format!("{work}/gone.txt")).unwrap();
        g(&["add", "-A", "--", "gone.txt"]);
        std::fs::write(format!("{work}/kept.txt"), "k\n").unwrap();

        git_ops::apply_selection(&git, &work, &["gone.txt".into(), "kept.txt".into()])
            .await
            .expect("已暂存的删除条目不该让暂存同步失败");
        assert_eq!(
            git_ops::staged_paths(&git, &work).await.unwrap(),
            vec!["gone.txt", "kept.txt"],
            "删除保留在暂存区、别的文件照常暂存"
        );
        // 再跑一次（幂等）：仍成功且暂停的删除没被退回
        git_ops::apply_selection(&git, &work, &["gone.txt".into(), "kept.txt".into()])
            .await
            .unwrap();
        assert_eq!(git_ops::staged_paths(&git, &work).await.unwrap(), vec!["gone.txt", "kept.txt"]);
        // 取消勾选它：删除退回未暂存（`restore --staged` 对 `D ` 条目正常）
        git_ops::apply_selection(&git, &work, &["kept.txt".into()]).await.unwrap();
        assert_eq!(git_ops::staged_paths(&git, &work).await.unwrap(), vec!["kept.txt"]);
        assert_eq!(g(&["diff", "--name-only", "--", "gone.txt"]), "gone.txt", "删除应退回未暂存");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn real_repo_selection_stages_from_repo_root_base_in_subdir() {
        let (root, work, _remote) = temp_repo("subdir-base").await;
        let Some(git) = git_bin().await else { panic!("未找到 git") };
        let g = |args: &[&str]| {
            let out = std::process::Command::new(&git).arg("-C").arg(&work).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?} 失败：{}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        g(&["commit", "--allow-empty", "-m", "chore: init"]);
        let sub = format!("{work}/sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(format!("{sub}/n.txt"), "n\n").unwrap();
        // 项目目录是仓库子目录：勾选路径是根基准（porcelain 口径），git 的 pathspec 却
        // 相对 cwd——旧实现把它当子目录相对路径解析，整批 add 失配
        git_ops::apply_selection(&git, &sub, &["sub/n.txt".into()])
            .await
            .expect("子目录 cwd 不该让 pathspec 失配");
        assert_eq!(git_ops::staged_paths(&git, &work).await.unwrap(), vec!["sub/n.txt"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn real_repo_unstage_removes_previously_staged_files() {
        let (root, work, _remote) = temp_repo("unstage").await;
        let Some(git) = git_bin().await else { panic!("未找到 git") };
        let g = |args: &[&str]| {
            let out = std::process::Command::new(&git).arg("-C").arg(&work).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?} 失败：{}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        g(&["commit", "--allow-empty", "-m", "chore: init"]);
        std::fs::write(format!("{work}/a.txt"), "a\n").unwrap();
        std::fs::write(format!("{work}/b.txt"), "b\n").unwrap();
        g(&["add", "-A"]);
        assert_eq!(git_ops::staged_paths(&git, &work).await.unwrap().len(), 2);
        // 只留 b：a 必须从暂存区退回未跟踪
        git_ops::apply_selection(&git, &work, &["b.txt".to_string()]).await.unwrap();
        assert_eq!(git_ops::staged_paths(&git, &work).await.unwrap(), vec!["b.txt"]);
        assert!(g(&["status", "--porcelain"]).contains("?? a.txt"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn real_repo_push_sets_upstream_then_rejects_non_fast_forward() {
        let (root, work, remote) = temp_repo("push").await;
        let Some(git) = git_bin().await else { panic!("未找到 git") };
        let g = |args: &[&str]| {
            let out = std::process::Command::new(&git).arg("-C").arg(&work).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?} 失败：{}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        g(&["commit", "--allow-empty", "-m", "chore: init"]);
        g(&["remote", "add", "origin", &remote]);

        // 无上游 → 自动 `-u origin main`
        let cancel = CancelToken::new();
        run_git_push(&git, &work, &cancel, &mut |_, _| {}).await.expect("首次推送应成功");
        assert_eq!(g(&["rev-parse", "--abbrev-ref", "main@{u}"]), "origin/main");

        // 远端被另一个克隆推了新提交 → 本地推送应当被拒 + 给 hint
        let other = root.join("other");
        std::process::Command::new(&git)
            .args(["clone", "-q", &remote])
            .arg(&other)
            .output()
            .unwrap();
        let o = other.to_string_lossy().to_string();
        for args in [["config", "user.email", "x@y.z"], ["config", "user.name", "x"]] {
            std::process::Command::new(&git).arg("-C").arg(&o).args(args).output().unwrap();
        }
        std::fs::write(other.join("z.txt"), "z\n").unwrap();
        for args in [
            vec!["add", "-A"],
            vec!["commit", "-m", "chore: remote side"],
            vec!["push", "origin", "main"],
        ] {
            std::process::Command::new(&git).arg("-C").arg(&o).args(args).output().unwrap();
        }
        g(&["commit", "--allow-empty", "-m", "chore: local side"]);
        let err = run_git_push(&git, &work, &cancel, &mut |_, _| {}).await.expect_err("应被拒绝");
        assert!(err.1.is_some(), "应给出 hint：{err:?}");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 真实 `omp commit`（慢；手动跑：`cargo test --manifest-path src-tauri/Cargo.toml -- --ignored`）。
    ///
    /// 完整轨全链路：把**勾选**同步进暂存区 → `omp commit`（AI 信息 + changelog 维护）→ 读到新提交。
    /// 顺带实测「上游是否尊重预置的暂存区」：未勾选的文件不能进这次提交。
    /// 需要本机有 git 与 omp（含可用模型凭证）；临时目录自建自清。
    #[tokio::test]
    #[ignore = "会 spawn 真实 omp commit（消耗一次 AI 调用，~30-60s）"]
    async fn real_repo_full_commit_honors_selection() {
        let (root, work, _remote) = temp_repo("fullcommit").await;
        let Some(git) = git_bin().await else { panic!("未找到 git") };
        let Some(omp) = ["omp", "/opt/homebrew/bin/omp", "/usr/local/bin/omp"].into_iter().find(|c| {
            std::process::Command::new(c)
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        }) else {
            eprintln!("skip: 未找到 omp");
            return;
        };
        let g = |args: &[&str]| {
            let out = std::process::Command::new(&git).arg("-C").arg(&work).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?} 失败：{}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        g(&["commit", "--allow-empty", "-m", "chore: init"]);
        std::fs::write(format!("{work}/picked.txt"), "picked\n").unwrap();
        std::fs::write(format!("{work}/left.txt"), "left\n").unwrap();

        git_ops::apply_selection(&git, &work, &["picked.txt".to_string()]).await.expect("暂存失败");
        let before = head_sha(&git, &work).await;
        let child = spawn_omp_commit(&omp, &work, Some("请用简体中文撰写提交信息的正文。"))
            .expect("spawn omp commit 失败");
        let pid = child.id();
        let cancel = CancelToken::new();
        let mut lines: Vec<String> = vec![];
        let signals = pump_child(child, pid, Some(&cancel), |line, _| lines.push(line.to_string())).await;
        let after = head_sha(&git, &work).await;
        let changed = after.is_some() && after != before;
        let (phase, error, _) = classify_full(&signals, changed);
        assert_eq!(
            phase,
            CommitPhase::Committed,
            "code={:?} error={:?}\n日志：\n{}",
            signals.code,
            error,
            lines.join("\n")
        );
        let committed = g(&["show", "--name-only", "--format=", "HEAD"]);
        assert!(committed.contains("picked.txt"), "勾选的文件应在本次提交里：{committed}");
        assert!(
            !committed.contains("left.txt") || committed.contains("CHANGELOG.md"),
            "未勾选的文件不该被顺带提交（除非 omp 自己改了 changelog）：{committed}"
        );
        eprintln!("完整轨提交内容：{committed}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 真实 `omp -p` 快路径（慢；手动跑：`cargo test --manifest-path src-tauri/Cargo.toml -- --ignored`）。
    ///
    /// 跑 3 次生成并各打印一次耗时（每次换一点改动），用于验收「p50 ≤ 6s」；
    /// 需要本机有 omp 与可用模型凭证；临时目录自建自清。
    #[tokio::test]
    #[ignore = "会 spawn 真实 omp -p（消耗 3 次 AI 调用，~15-30s）"]
    async fn real_repo_fast_commit_message() {
        let (root, work, _remote) = temp_repo("fastmsg").await;
        let Some(git) = git_bin().await else { panic!("未找到 git") };
        let Some(omp) = ["omp", "/opt/homebrew/bin/omp", "/usr/local/bin/omp"].into_iter().find(|c| {
            std::process::Command::new(c)
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        }) else {
            eprintln!("skip: 未找到 omp");
            return;
        };
        let g = |args: &[&str]| {
            let out = std::process::Command::new(&git).arg("-C").arg(&work).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?} 失败：{}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        g(&["commit", "--allow-empty", "-m", "chore: init"]);

        let mut times: Vec<f64> = vec![];
        for i in 0..3 {
            let name = format!("f{i}.txt");
            std::fs::write(format!("{work}/{name}"), format!("内容 {i}\n第二行\n")).unwrap();
            git_ops::apply_selection(&git, &work, &[name.clone()]).await.expect("暂存失败");
            let stat = commit_msg::staged_stat(&git, &work).await;
            let raw = commit_msg::staged_diff(&git, &work).await;
            let (diff, truncated) = commit_msg::truncate_diff(&raw, commit_msg::DIFF_LIMIT);
            let prompt = commit_msg::build_commit_prompt(
                Some("请用简体中文撰写提交信息的正文；摘要首词用英文过去式动词。"),
                &stat,
                &diff,
                truncated,
            );
            let role = commit_msg::read_commit_role(&omp, &work).await;
            let (model, thinking) = git_ops::commit_model_args(role.as_deref());
            let args = commit_msg::generate_args(model.as_deref(), thinking.as_deref(), &work, &prompt);
            let started = std::time::Instant::now();
            let child = commit_msg::spawn_generate(&omp, &args, &work).expect("spawn omp -p 失败");
            let pid = child.id();
            let cancel = CancelToken::new();
            let mut buf = String::new();
            let signals = pump_child(child, pid, Some(&cancel), |line, stream| {
                if stream == OutStream::Stdout {
                    buf.push_str(line);
                    buf.push('\n');
                }
            })
            .await;
            let elapsed = started.elapsed().as_secs_f64();
            times.push(elapsed);
            let message = commit_msg::parse_commit_message(&buf);
            eprintln!("第 {} 次：{:.2}s → {}", i + 1, elapsed, message.replace('\n', " / "));
            assert_eq!(signals.code, Some(0), "omp -p 退出码异常：{:?}", signals.err_tail);
            assert!(!message.is_empty(), "生成的提交信息不能为空");
            // 生成用的暂存区内容不该被生成过程改动
            let staged = git_ops::staged_paths(&git, &work).await.unwrap();
            assert_eq!(staged, vec![name.clone()]);
        }
        let mut sorted = times.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        eprintln!("三次耗时：{times:?}；中位数 {:.2}s", sorted[1]);
        assert!(sorted[1] <= 6.0, "快路径中位耗时应 ≤ 6s，实测 {sorted:?}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
