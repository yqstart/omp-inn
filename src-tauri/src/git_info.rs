//! git 子命令执行与 worktree 列表解析（左栏工作区树与会话归属共用）。
//!
//! 为什么走 git CLI 而不是自己解析 `.git`：worktree、packed-refs、submodule 的
//! 指针文件细节太多。CLI 缺失、目录不是仓库、命令超时一律降级（空表 / 错误原文），
//! 不阻断界面。
//!
//! 解析逻辑是纯函数（见文末单测），进程调用只负责喂字符串。

use serde::Serialize;
use std::path::Path;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::io::AsyncReadExt;

/// 单条 git 查询超时：大仓库 `status` 可能很慢，超时按未知降级，不卡 UI。
const GIT_TIMEOUT: Duration = Duration::from_secs(4);
/// 登录 shell 探测超时（-ilc 要跑一遍 rc，单独给宽一点）。
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);
/// 跑一条 git 子命令：失败返回 stderr 文本（调用方决定是降级还是当作正常分支缺失）。
pub(crate) async fn run_git(git: &str, dir: &str, args: &[&str]) -> Result<String, String> {
    run_git_timeout(git, dir, args, GIT_TIMEOUT).await
}

/// 同 [`run_git`]，但可指定超时：大仓库的 `status` / `add` / `commit` 这类天然可能
/// 超过 4s 的命令要用更宽的超时（否则好的操作被误判成失败）。
pub(crate) async fn run_git_timeout(
    git: &str,
    dir: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new(git);
    cmd.arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.as_std_mut().process_group(0);
    }
    #[cfg(windows)]
    let mut child = {
        // 先挂起进程，加入作业对象后才恢复；即使 Git 先退出，作业仍能停止其后代。
        use process_wrap::tokio::{CommandWrap, JobObject, KillOnDrop};
        let mut wrapped = CommandWrap::from(cmd);
        wrapped.wrap(JobObject).wrap(KillOnDrop);
        wrapped.spawn().map_err(|e| e.to_string())?
    };
    #[cfg(not(windows))]
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    let pid = child.id();
    #[cfg(windows)]
    let mut stdout = child.stdout().take().ok_or("无法读取 git 标准输出")?;
    #[cfg(not(windows))]
    let mut stdout = child.stdout.take().ok_or("无法读取 git 标准输出")?;
    #[cfg(windows)]
    let mut stderr = child.stderr().take().ok_or("无法读取 git 错误输出")?;
    #[cfg(not(windows))]
    let mut stderr = child.stderr.take().ok_or("无法读取 git 错误输出")?;
    let mut out = Vec::new();
    let mut err = Vec::new();
    // 同时读取两条管道，避免 git 输出填满管道而无法退出；限时覆盖子进程和管道读取。
    #[cfg(windows)]
    let result = tokio::time::timeout(timeout, async {
        // 首次只等直接子进程；超时后的作业对象 wait 要能等待全部后代退出。
        // 安全：这里只等待原生子进程，不改变作业对象；Tokio 会缓存退出状态，包装层仍可再次等待。
        let native = unsafe { child.try_inner_child_mut() }
            .ok_or_else(|| std::io::Error::other("无法读取 git 子进程"))?;
        tokio::try_join!(native.wait(), stdout.read_to_end(&mut out), stderr.read_to_end(&mut err))
    }).await;
    #[cfg(not(windows))]
    let result = tokio::time::timeout(timeout, async {
        tokio::try_join!(child.wait(), stdout.read_to_end(&mut out), stderr.read_to_end(&mut err))
    }).await;
    match result {
        Ok(Ok((status, _, _))) if status.success() => Ok(String::from_utf8_lossy(&out).to_string()),
        Ok(Ok(_)) => {
            let err = String::from_utf8_lossy(&err).trim().to_string();
            Err(if err.is_empty() { "git 命令失败".into() } else { err })
        }
        failure => {
            // 超时或读管道失败时先停止整个进程树，再回收 git，避免返回后继续修改仓库。
            #[cfg(not(windows))]
            if let Some(pid) = pid {
                if child.id().is_some() {
                    crate::proc::force_kill_group(pid);
                } else {
                    // 父进程可能已退出但后代仍持有管道；只对原进程组发信号，不回退到单 PID。
                    #[cfg(unix)]
                    unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
                }
            }
            let killed = child.start_kill();
            // 管道也必须关闭：父进程先退出时，后代仍可能持有输出句柄。
            let waited = tokio::time::timeout(Duration::from_secs(5), async {
                tokio::try_join!(child.wait(), stdout.read_to_end(&mut out), stderr.read_to_end(&mut err))
            }).await;
            let reason = match failure {
                Err(_) => "git 命令超时".to_string(),
                Ok(Err(e)) => e.to_string(),
                Ok(Ok(_)) => unreachable!(),
            };
            match (killed, waited) {
                (Ok(()), Ok(Ok(_))) => Err(reason),
                _ => Err(format!("{reason}；无法确认 git 进程已退出")),
            }
        }
    }
}

/// 探测结果缓存：git 路径一次解析，后续命令零开销（首次可能要走登录 shell，约百毫秒）。
static GIT_BIN: OnceLock<Option<String>> = OnceLock::new();

async fn probe_git(candidate: &str) -> bool {
    let fut = tokio::process::Command::new(candidate)
        .arg("--version")
        .stdin(Stdio::null())
        .output();
    matches!(tokio::time::timeout(SHELL_TIMEOUT, fut).await, Ok(Ok(o)) if o.status.success())
}

/// 解析 git 可执行文件：PATH → 登录 shell `command -v git` → 常见绝对路径（含 Homebrew）。
/// GUI 应用（macOS .app）的 PATH 只有 launchd 默认值，必须带 shell 兜底。
pub async fn git_bin() -> Option<String> {
    if let Some(hit) = GIT_BIN.get() {
        return hit.clone();
    }
    let mut candidates: Vec<String> = vec!["git".into()];
    // Windows 的 GUI 进程从 Explorer 继承注册表 PATH，直接探 `git` 即可；
    // 不要跑 `$SHELL -ilc`（系统默认没有 SHELL，Git Bash 的输出还是 MSYS 路径）。
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let fut = tokio::process::Command::new(&shell)
            .args(["-ilc", "command -v git"])
            .stdin(Stdio::null())
            .output();
        if let Ok(Ok(out)) = tokio::time::timeout(SHELL_TIMEOUT, fut).await {
            if out.status.success() {
                if let Some(found) = String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .map(str::trim)
                    .filter(|l| l.starts_with('/'))
                    .next_back()
                {
                    candidates.push(found.to_string());
                }
            }
        }
        for c in ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"] {
            candidates.push(c.to_string());
        }
    }
    #[cfg(windows)]
    if let Ok(pf) = std::env::var("ProgramFiles") {
        candidates.push(std::path::Path::new(&pf).join("Git/cmd/git.exe").to_string_lossy().into_owned());
    }
    let mut found = None;
    for c in candidates {
        if probe_git(&c).await {
            found = Some(c);
            break;
        }
    }
    let _ = GIT_BIN.set(found.clone());
    found
}

/// 目录存在性预检：不存在直接降级，不白跑 5 条 git 命令。
pub fn dir_exists(dir: &str) -> bool {
    Path::new(dir).is_dir()
}

// ---------- git 上下文只读读取（聊天形态输入框上方上下文条用；V32 恢复自 V1–V10） ----------

/// 本地分支清单上限：只读展示，不做无限清单。
const MAX_BRANCHES: usize = 200;

#[derive(Debug, Clone, Serialize)]
pub struct GitInfo {
    /// 是否在 git 工作区内（false = 非仓库 / git 不可用，前端据此隐藏分支展示）。
    #[serde(rename = "isRepo")]
    pub is_repo: bool,
    /// 当前分支名；detached HEAD 时为短 sha；未知为 null。
    pub branch: Option<String>,
    /// 是否 detached HEAD（前端追加「游离」提示）。
    pub detached: bool,
    /// 本地分支清单（当前分支置顶，其余按最近提交倒序）。
    pub branches: Vec<String>,
    /// 工作区是否有已跟踪文件的改动；null = 未检测 / 超时。
    pub dirty: Option<bool>,
    /// 未提交改动的行级统计（`git diff HEAD --numstat` 汇总，v2 右栏「变更」区块用）。
    /// null = 未检测 / 超时 / 首次提交前无 HEAD。
    pub added: Option<u64>,
    pub removed: Option<u64>,
    /// 非仓库 / 命令失败的原因（只用于 tooltip 与日志，不弹窗）。
    pub error: Option<String>,
}

impl GitInfo {
    /// 降级值：非仓库、目录缺失、找不到 git 都走这里。
    pub fn not_repo(error: Option<String>) -> Self {
        Self {
            is_repo: false,
            branch: None,
            detached: false,
            branches: vec![],
            dirty: None,
            added: None,
            removed: None,
            error,
        }
    }
}

/// 解析 `git symbolic-ref -q --short HEAD`：detached HEAD 时无输出 → None。
pub fn parse_branch_name(out: &str) -> Option<String> {
    let t = out.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// 解析 `git for-each-ref --format=%(refname:short) refs/heads`：
/// 去空行、去重（保序）、当前分支置顶、截断到 [`MAX_BRANCHES`]。
pub fn parse_branches(out: &str, current: Option<&str>) -> Vec<String> {
    let mut list: Vec<String> = vec![];
    for line in out.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let name = line.to_string();
        if !list.contains(&name) {
            list.push(name);
        }
    }
    if let Some(cur) = current {
        if let Some(pos) = list.iter().position(|b| b == cur) {
            let head = list.remove(pos);
            list.insert(0, head);
        }
    }
    list.truncate(MAX_BRANCHES);
    list
}

/// 解析 `git status --porcelain --untracked-files=no`：任一行非空即有改动。
/// 只统计已跟踪文件，未跟踪文件不扫（大仓库里这步最慢）。
pub fn parse_dirty(out: &str) -> bool {
    out.lines().any(|l| !l.trim().is_empty())
}

/// 解析 `git rev-parse --short HEAD`（detached HEAD 的展示名）。
pub fn parse_short_sha(out: &str) -> Option<String> {
    let t = out.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// 解析 `git diff HEAD --numstat`：`<added>\t<removed>\t<path>` 逐行累加。
/// 二进制文件的数字段是 `-`（跳过）；路径含改名时是 `old => new`，不解析路径本身。
pub fn parse_numstat(out: &str) -> (u64, u64) {
    let mut added = 0u64;
    let mut removed = 0u64;
    for line in out.lines() {
        let mut parts = line.split('\t');
        let (Some(a), Some(r)) = (parts.next(), parts.next()) else { continue };
        added += a.trim().parse::<u64>().unwrap_or(0);
        removed += r.trim().parse::<u64>().unwrap_or(0);
    }
    (added, removed)
}

/// 读取一个目录的 git 上下文。目录不存在 / 非仓库 / git 不可用都返回降级值，不抛错。
pub async fn read_git_info(git: &str, dir: &str) -> GitInfo {
    // 1) 是不是工作区：`rev-parse --is-inside-work-tree` 输出 true 才算
    match run_git(git, dir, &["rev-parse", "--is-inside-work-tree"]).await {
        Ok(out) if out.trim() == "true" => {}
        Ok(_) => return GitInfo::not_repo(None),
        Err(e) => return GitInfo::not_repo(Some(e)),
    }
    // 2) 当前分支：detached HEAD 时 symbolic-ref 退出码非 0，属正常情况
    let mut branch = match run_git(git, dir, &["symbolic-ref", "-q", "--short", "HEAD"]).await {
        Ok(out) => parse_branch_name(&out),
        Err(_) => None,
    };
    // 3) detached（或无提交）时用短 sha 顶替分支名，拿不到就只留「游离」标记
    let detached = branch.is_none();
    if detached {
        branch = run_git(git, dir, &["rev-parse", "--short", "HEAD"])
            .await
            .ok()
            .and_then(|out| parse_short_sha(&out));
    }
    // 4) 本地分支清单：按最近提交倒序，当前分支由 parse_branches 置顶
    let branches = run_git(
        git,
        dir,
        &["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"],
    )
    .await
    .map(|out| parse_branches(&out, branch.as_deref()))
    .unwrap_or_default();
    // 5) 脏工作区标记（只读提示：有未提交改动时切分支会带着改动走）
    let dirty = run_git(git, dir, &["status", "--porcelain", "--untracked-files=no"])
        .await
        .ok()
        .map(|out| parse_dirty(&out));
    // 6) 未提交改动的行级统计（v2 右栏「变更」区块的 `+X −Y`）：
    //    与 dirty 同口径只看已跟踪文件；首次提交前没有 HEAD，失败即降级为 null。
    let (added, removed) = match run_git(git, dir, &["diff", "HEAD", "--numstat"]).await {
        Ok(out) => {
            let (a, r) = parse_numstat(&out);
            (Some(a), Some(r))
        }
        Err(_) => (None, None),
    };
    GitInfo { is_repo: true, branch, detached, branches, dirty, added, removed, error: None }
}

/// 一个 git worktree（`git worktree list --porcelain` 的解析结果）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    /// 主 worktree（= 仓库主目录；porcelain 输出第一块，git 的约定）。
    pub main: bool,
}

/// 解析 `git worktree list --porcelain`：
/// 每块以 `worktree <path>` 开头，随后 `HEAD <sha>`、`branch refs/heads/<name>`
/// （detached 时无 branch 行）、可选 `bare` / `locked` / `prunable`；块间空行。
pub fn parse_worktrees(out: &str) -> Vec<WorktreeEntry> {
    let mut list: Vec<WorktreeEntry> = vec![];
    for line in out.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        if let Some(p) = line.strip_prefix("worktree ") {
            list.push(WorktreeEntry {
                path: p.trim().to_string(),
                branch: None,
                head: None,
                main: list.is_empty(),
            });
            continue;
        }
        let Some(last) = list.last_mut() else { continue };
        if let Some(h) = line.strip_prefix("HEAD ") {
            last.head = Some(h.trim().to_string());
        } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
            last.branch = Some(b.trim().to_string());
        }
    }
    list
}

/// 列出一个仓库的全部 worktree（含主目录）。非仓库 / git 不可用返回空表——
/// 调用方按「只有主目录」处理，不做特殊错误态。
pub async fn list_worktrees(git: &str, dir: &str) -> Vec<WorktreeEntry> {
    match run_git(git, dir, &["worktree", "list", "--porcelain"]).await {
        Ok(out) => parse_worktrees(&out),
        Err(_) => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_exists_matches_filesystem() {
        assert!(dir_exists("."));
        assert!(!dir_exists("/no/such/dir/omp-inn"));
    }

    #[test]
    fn parse_worktrees_reads_blocks() {
        let out = "\
worktree /repo
HEAD 1a2b3c4d
branch refs/heads/main

worktree /repo.wt/feat
HEAD 5e6f7a8b
branch refs/heads/feat/x

";
        let list = parse_worktrees(out);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].path, "/repo");
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert!(list[0].main, "第一块是主 worktree");
        assert_eq!(list[1].path, "/repo.wt/feat");
        assert_eq!(list[1].branch.as_deref(), Some("feat/x"), "分支名保留斜杠");
        assert!(!list[1].main);
    }

    #[test]
    fn parse_worktrees_detached_and_extras() {
        let out = "\
worktree /repo
HEAD 1a2b3c4d
branch refs/heads/main
locked reason

worktree /repo.wt/det
HEAD 5e6f7a8b
detached
prunable gitdir file points to non-existent location

";
        let list = parse_worktrees(out);
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].branch, None, "detached 块没有分支行");
        assert_eq!(list[1].head.as_deref(), Some("5e6f7a8b"));
        assert_eq!(parse_worktrees(""), vec![]);
        assert_eq!(parse_worktrees("garbage line\n").len(), 0, "没有 worktree 块就不产出行");
    }

    #[test]
    fn parse_numstat_sums_lines() {
        let out = "12\t3\tsrc/a.ts\n0\t7\tsrc/b.ts\n-\t-\tassets/logo.png\n";
        assert_eq!(parse_numstat(out), (12, 10), "二进制行跳过、其余按列累加");
        assert_eq!(parse_numstat(""), (0, 0));
        assert_eq!(parse_numstat("garbage\n"), (0, 0), "非法行不 panic、不计入");
    }

    /// 真实仓库：`git worktree add` 后 list 能同时看到主目录与新增 worktree。
    /// CI 上没装 git 时静默跳过。
    #[tokio::test]
    async fn list_worktrees_reads_a_real_repository() {
        let Some(git) = git_bin().await else { return };
        let base = std::env::temp_dir().join(format!("omp-inn-wt-{}", std::process::id()));
        let dir = base.join("repo");
        let wt = base.join("repo.wt");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&dir).unwrap();
        let d = dir.to_string_lossy().to_string();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "omp-inn-test"],
        ] {
            run_git(&git, &d, &args).await.unwrap();
        }
        std::fs::write(dir.join("a.txt"), "a").unwrap();
        run_git(&git, &d, &["add", "a.txt"]).await.unwrap();
        run_git(&git, &d, &["commit", "-qm", "init"]).await.unwrap();

        // 非仓库目录：空表而不是报错
        let plain = base.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(list_worktrees(&git, &plain.to_string_lossy()).await.is_empty());

        let wt_s = wt.to_string_lossy().to_string();
        run_git(&git, &d, &["worktree", "add", "-q", "-b", "feat-wt", &wt_s]).await.unwrap();
        let list = list_worktrees(&git, &d).await;
        assert_eq!(list.len(), 2, "主目录 + 新 worktree：{list:?}");
        assert!(list[0].main);
        assert_eq!(list[1].branch.as_deref(), Some("feat-wt"));
        assert!(list[1].path.ends_with("repo.wt"), "worktree 路径：{:?}", list[1].path);

        let _ = std::fs::remove_dir_all(&base);
    }
}
