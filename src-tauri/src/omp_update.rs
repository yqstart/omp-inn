//! omp 运行时的三条链路：**安装**（omp 缺失时跑官方安装脚本）、**检查**（`omp update --check`）
//! 与**执行**（`omp update`）。界面入口 = 左栏字标行上的版本 chip + 它的详情弹窗；omp 缺失时
//! 同一位置换成「安装 omp」chip + 安装弹窗（本地识别由 `get_health` 完成，识别不到才给安装入口）。
//!
//! **安装**走官方脚本（`https://omp.sh/install`，Windows 为 `install.ps1`）——壳侧不自己拼
//! brew / npm 命令：bun 可用时装 bun 版、否则装预编译二进制（带 sha256 校验），装完的路径
//! 落在 `~/.local/bin/omp` 或 `~/.bun/bin/omp`，两种都在 `discover_omp_path` 的兜底里。
//!
//! 上游事实（omp 18.3.5 实测）：
//!
//! **检查**（`omp update --check`，只检查不安装）——成功时退出码 0，结论写在 stdout 的行标签里：
//! - 有新版本 → `Current version: 18.3.5` + `New version available: 18.4.2`
//! - 已是最新 → `Current version: 18.3.5` + `<✔> Already up to date`
//! - canary 渠道多一行 `Current channel: canary`（stable 档不打印）
//! - 失败（网络不可达 / 镜像超时）退出码 1、stderr 一行 `Failed to check for updates: <原因>`
//! - 查的是 **npm registry 的 `dist-tags`**（按 `.npmrc` / 环境变量解析出的 registry），
//!   不是 GitHub releases；本机实测 0.27s，慢网络会撞上游自己的 30s 超时。
//!
//! **执行**（`omp update`，真安装）——上游先识别安装方式（brew / npm / bun / mise / nix /
//! 独立二进制）再选路，所以壳侧**不自己拼 brew / npm 命令**：那是上游的职责，也是唯一能
//! 覆盖全部安装方式的写法。这条路要调 `brew` / `npm` 等外部命令，必须继承**登录 shell 的
//! PATH**（GUI 启动的 .app 只有 launchd 的贫瘠 PATH）。
//!
//! 并发模型：更新是**机器级**操作（一份 omp 安装），所以只有**一个全局单槽**
//! （[`UpdateSlot`]）——重复发起返回 BUSY。取消走 `CancelToken` → 杀进程组
//! （brew / npm 是它派生的子进程，`process_group(0)` 保证一起收掉）。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::commands::{cmd_err, discover_omp_path, AppState, CmdError};
use crate::git_commit::{pump_child, strip_ansi, CancelToken, OutStream, RunSignals};
use crate::proc::{force_kill_group, login_path};
use crate::providers::run_omp_capture;

/// `omp update --check` 的硬超时：正常 0.2–2s（有 registry 缓存），网络差时兜底 30s。
/// 超时按「检查失败」上报，不留挂死。
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// 探一次 `omp --version` 的超时（更新前后各一次，只用来给界面标「从 X 到 Y」）。
const VERSION_TIMEOUT: Duration = Duration::from_secs(30);
/// `omp update` 的硬超时。**给足六小时**——这只是「防任务永久占住单槽」的最后一根保险，
/// 真正的逃生口是界面上的「取消更新」（杀进程组）。为什么这么大：这条路会下载并安装整个 omp
/// （bottle ≈ 210MB），**实测本机 2026-09-28 从 `can1357/tap` 拉这个 bottle 用了约 2.5 小时**
/// （`brew upgrade` 全程 9303s）——壳侧的截止时间不该比包管理器自己更紧。
const UPDATE_TIMEOUT: Duration = Duration::from_secs(6 * 3600);

// ==================== 检查 ====================

/// 一次检查的结论（原样透传给界面）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OmpUpdateStatus {
    /// 当前安装的版本（上游总是先打印它；解析不到才是 None）。
    pub current: Option<String>,
    /// 新版本号；None = 已是最新。
    pub latest: Option<String>,
    /// `stable` / `canary`——上游只在 canary 档打标签，缺省即 stable。
    pub channel: String,
}

/// 取 `<标签><值>` 形式的行值（剥色后逐行 trim，前缀要严格对上）。
fn tagged_value(out: &str, tag: &str) -> Option<String> {
    out.lines()
        .find_map(|l| l.trim().strip_prefix(tag).map(|v| v.trim().to_string()).filter(|v| !v.is_empty()))
}

/// 解析一次 `omp update --check` 的结果（纯函数，单测锁着）。
///
/// 退出码非 0 一律算失败（原因取 stderr 首行，剥掉上游的 `Failed to check for updates: ` 前缀）；
/// 退出码 0 但既没有新版本行、也没有「已是最新」/当前版本行，则视为未知输出（宁可报「检查失败」，
/// 也不把空输出说成「已是最新」）。
///
/// 解析前剥 ANSI：壳侧子进程没有 TTY（上游默认不上色），但 `FORCE_COLOR` 之类环境变量
/// 仍可能让它上色，颜色码夹在行标签里会打断前缀匹配（`git_commit::strip_ansi` 与本模块共用）。
fn parse_check_output(stdout: &str, stderr: &str, code: Option<i32>) -> Result<OmpUpdateStatus, String> {
    let out = strip_ansi(stdout);
    let current = tagged_value(&out, "Current version:");
    let latest = tagged_value(&out, "New version available:");
    if code != Some(0) {
        let err = strip_ansi(stderr);
        let why = err
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .map(|l| l.strip_prefix("Failed to check for updates:").map(str::trim).unwrap_or(l).to_string())
            .unwrap_or_else(|| match code {
                Some(c) => format!("omp update --check 退出码 {c}"),
                None => "omp update --check 被信号终止".into(),
            });
        return Err(why);
    }
    if latest.is_none() && current.is_none() && !out.contains("Already up to date") {
        return Err("omp update --check 的输出无法解析".into());
    }
    Ok(OmpUpdateStatus {
        current,
        latest,
        channel: if out.contains("Current channel: canary") { "canary".into() } else { "stable".into() },
    })
}

/// 检查 omp 是否有新版本（`omp update --check`；只读、不安装）。
#[tauri::command]
pub async fn check_omp_update(state: State<'_, AppState>) -> Result<OmpUpdateStatus, CmdError> {
    let bin = discover_omp_path(&state).ok_or_else(omp_missing)?;
    // 钉在 agentDir（与设置页读配置同层）：`update.channel` 是 omp 配置键，从项目目录里跑
    // 会读到该项目的覆盖值——这里要的是「全局生效的那一档」。
    let dir = agent_dir_of(&state).await;
    let (stdout, stderr, code) = run_omp_capture(dir.as_deref(), &bin, &["update", "--check"], CHECK_TIMEOUT)
        .await
        .map_err(|e| cmd_err("OMP_UPDATE_SPAWN", format!("无法运行 omp update --check：{e}"), None))?;
    // 不带 hint：界面自己会给本地化的排查提示（`ompUpdateErrorHint`），
    // 这里只把上游的原因原文交出去（`api.call` 会把 hint 拼进错误文案，双语混排很难看）。
    parse_check_output(&stdout, &stderr, code).map_err(|e| cmd_err("OMP_UPDATE_CHECK", e, None))
}

fn omp_missing() -> CmdError {
    cmd_err(
        "OMP_MISSING",
        "未找到 omp，无法检查更新".into(),
        Some("请先安装 oh-my-pi 或在设置 ›「关于」里指定 omp 路径".into()),
    )
}

/// 这次命令要钉的工作目录（agentDir；不存在就给 None = 继承 app 的工作目录）。
async fn agent_dir_of(state: &State<'_, AppState>) -> Option<PathBuf> {
    let dir = state.agent_dir.lock().await.clone();
    dir.is_dir().then_some(dir)
}

// ==================== 执行更新（`omp update`） ====================

/// 更新任务的终局阶段（与前端 `OmpUpdatePhase` 同构）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OmpUpdatePhase {
    /// 前端本地态：任务已起、还没收到终局事件（后端**从不**发这个值；枚举与前端保持同构）。
    #[allow(dead_code)]
    Running,
    Done,
    Failed,
    Canceled,
}

/// 更新过程的事件流（经 Tauri Channel 推送）。
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum OmpUpdateEvent {
    /// 输出行（已去 ANSI；stdout / stderr 混流进弹窗的日志区）。
    Line { text: String },
    /// 任务结束：终态与结果都在这条里。
    Exit { outcome: OmpUpdateOutcome },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpUpdateOutcome {
    pub phase: OmpUpdatePhase,
    /// 更新前的版本（跑更新前探一次 `omp --version`；探不到为 None）。
    pub from: Option<String>,
    /// 失败原因（两路输出的尾行摘要；成功 / 取消时为 None）。
    pub error: Option<String>,
}

/// 进行中的更新任务句柄。杀进程组不在这里做：取消令牌一响，读流循环（`pump_child`）就会
/// 杀直接子进程 + 打整个进程组——收口在一条路径上，命令层只负责发信号。
pub struct UpdateTask {
    seq: u64,
    cancel: Arc<CancelToken>,
}

/// 更新任务的**全局单槽**：一台机器只有一份 omp 安装，两次更新必须互斥。
pub type UpdateSlot = Arc<Mutex<Option<UpdateTask>>>;

/// 每次 spawn 的内部序号：收尾时用它确认「槽里还是我这一次任务」，
/// 防止「取消后立刻重跑」时旧任务误清新任务的槽位（与提交任务的 `TASK_SEQ` 同口径）。
static UPDATE_SEQ: AtomicU64 = AtomicU64::new(1);

fn acquire(slot: &UpdateSlot) -> Result<(u64, Arc<CancelToken>), CmdError> {
    let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_some() {
        return Err(cmd_err("BUSY", "已有 omp 安装或更新在进行".into(), None));
    }
    let seq = UPDATE_SEQ.fetch_add(1, Ordering::Relaxed);
    let cancel = CancelToken::new();
    *guard = Some(UpdateTask { seq, cancel: cancel.clone() });
    Ok((seq, cancel))
}

fn release(slot: &UpdateSlot, seq: u64) {
    let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
    if guard.as_ref().map(|t| t.seq) == Some(seq) {
        *guard = None;
    }
}

/// 应用退出前的收尾：取消进行中的更新（`kill_on_drop` 收掉子进程；正常退出路径，
/// 崩溃残留接受为已知边界）。
pub fn kill_update(slot: &UpdateSlot) {
    let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(t) = guard.take() {
        t.cancel.cancel();
    }
}

/// spawn `omp update`：新进程组（取消时打 `-pid`，连带收掉它派生的 brew / npm 子进程）、
/// 继承登录 shell 的 PATH（这条路要调 `brew` / `npm`）、两路管道、kill_on_drop。
///
/// 不给参数：壳侧不替上游选渠道 / 不 `--force`——`omp update` 自己读配置、自己识别安装方式。
pub(crate) fn spawn_update(bin: &str, dir: Option<&Path>) -> std::io::Result<tokio::process::Child> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("update")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(d) = dir {
        cmd.current_dir(d);
    }
    if let Some(path) = login_path() {
        cmd.env("PATH", path);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.as_std_mut().process_group(0);
    }
    cmd.spawn()
}

/// 跑一次 `omp update` 并读流（假 omp 脚本可测：成功 / 失败 / 取消三条路径都锁着）。
/// `Err` = 进程起不来 / 超时；正常结束（含非零退出与取消）回 [`RunSignals`]。
pub(crate) async fn run_update(
    bin: &str,
    dir: Option<&Path>,
    cancel: Arc<CancelToken>,
    on_line: &mut (impl FnMut(&str) + Send),
) -> Result<RunSignals, String> {
    let child = spawn_update(bin, dir).map_err(|e| format!("启动 omp update 失败：{e}"))?;
    let pid = child.id();
    let pump = pump_child(child, pid, Some(cancel.as_ref()), |l, _s: OutStream| on_line(l));
    match tokio::time::timeout(UPDATE_TIMEOUT, pump).await {
        Ok(signals) => Ok(signals),
        Err(_) => {
            if let Some(pid) = pid {
                force_kill_group(pid);
            }
            Err(format!("omp update 超时（{} 分钟）", UPDATE_TIMEOUT.as_secs() / 60))
        }
    }
}

/// 终态判定（纯函数，单测锁着）：先看取消（取消时退出码没有意义），再看退出码。
pub(crate) fn classify_update(signals: &RunSignals) -> (OmpUpdatePhase, Option<String>) {
    if signals.canceled {
        return (OmpUpdatePhase::Canceled, None);
    }
    match signals.code {
        Some(0) => (OmpUpdatePhase::Done, None),
        _ => (OmpUpdatePhase::Failed, Some(signals.error_text())),
    }
}

/// 探一次 `omp --version`（`omp/18.3.5` → `18.3.5`）；失败给 None（不阻断更新流程）。
async fn probe_version(bin: &str, dir: Option<&Path>) -> Option<String> {
    let (out, _err, code) = run_omp_capture(dir, bin, &["--version"], VERSION_TIMEOUT).await.ok()?;
    if code != Some(0) {
        return None;
    }
    out.split_whitespace().next().map(|s| s.trim_start_matches("omp/").to_string())
}

/// 执行更新（`omp update`）：流式日志经 Channel 回流，结束发一条 `Exit`。
///
/// 命令本身**立刻返回**（任务在后台跑）：起不来的错误也走 `Exit`，前端在同一个日志区里
/// 就能看到原因，不必区分「命令失败」与「任务失败」两种展示路径。
#[tauri::command]
pub async fn start_omp_update(
    state: State<'_, AppState>,
    on_event: Channel<OmpUpdateEvent>,
) -> Result<(), CmdError> {
    let bin = discover_omp_path(&state).ok_or_else(omp_missing)?;
    let dir = agent_dir_of(&state).await;
    let slot = state.omp_update_task.clone();
    let (seq, cancel) = acquire(&slot)?;
    tokio::spawn(async move {
        let from = probe_version(&bin, dir.as_deref()).await;
        let _ = on_event.send(OmpUpdateEvent::Line { text: format!("$ {bin} update") });
        let mut emit = |line: &str| {
            let _ = on_event.send(OmpUpdateEvent::Line { text: line.to_string() });
        };
        let outcome = match run_update(&bin, dir.as_deref(), cancel, &mut emit).await {
            Err(e) => OmpUpdateOutcome { phase: OmpUpdatePhase::Failed, from, error: Some(e) },
            Ok(signals) => {
                let (phase, error) = classify_update(&signals);
                OmpUpdateOutcome { phase, from, error }
            }
        };
        // 先放槽再发终局事件：前端收到 canceled / failed 后立刻重试不会撞上 BUSY
        release(&slot, seq);
        let _ = on_event.send(OmpUpdateEvent::Exit { outcome });
    });
    Ok(())
}

/// 取消进行中的更新：发取消信号（杀进程组由读流循环做，见 [`UpdateTask`]）。
///
/// 安装与更新共用同一个单槽，所以这条命令也负责取消安装。
#[tauri::command]
pub async fn cancel_omp_update(state: State<'_, AppState>) -> Result<(), CmdError> {
    let cancel = {
        let guard = state.omp_update_task.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(t) => t.cancel.clone(),
            None => return Err(cmd_err("NOT_RUNNING", "当前没有进行中的 omp 安装或更新".into(), None)),
        }
    };
    cancel.cancel();
    Ok(())
}

// ==================== 安装（omp 缺失时的首次安装） ====================

/// omp 官方安装脚本的**唯一来源**（`https://omp.sh/install`，见上游 README 的 Install 段）。
/// 壳侧不自己拼 brew / npm 命令：安装方式（bun / 预编译二进制）由官方脚本识别，
/// 与 `omp update` 同一条原则。
#[cfg(not(windows))]
pub(crate) const INSTALL_SCRIPT: &str = "curl -fsSL https://omp.sh/install | sh";
/// Windows 走官方的 PowerShell 脚本（上游 README：`irm https://omp.sh/install.ps1 | iex`）。
#[cfg(windows)]
pub(crate) const INSTALL_SCRIPT: &str = "irm https://omp.sh/install.ps1 | iex";

/// 安装脚本的硬超时。官方脚本在 bun 可用时走 `bun install -g`、否则下载预编译二进制
/// （约 200MB，带 sha256 校验）——给足一小时，真正的逃生口是界面上的「取消安装」。
const INSTALL_TIMEOUT: Duration = Duration::from_secs(3600);

/// spawn 官方安装脚本：`/bin/sh -c "<脚本命令>"`（Windows 走 PowerShell）、新进程组
/// （取消时连带收掉脚本派生的 curl / bun 子进程）、继承登录 shell 的 PATH（脚本要用
/// curl / bun / git）、两路管道、kill_on_drop。
pub(crate) fn spawn_install_script(script: &str) -> std::io::Result<tokio::process::Child> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = tokio::process::Command::new("powershell");
        c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("/bin/sh");
        c.arg("-c").arg(script);
        c
    };
    cmd.stdin(Stdio::null())
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
    cmd.spawn()
}

/// 跑一次安装脚本并读流（假脚本可测：成功 / 失败 / 取消三条路径都锁着）。
/// `Err` = 进程起不来 / 超时；正常结束（含非零退出与取消）回 [`RunSignals`]。
pub(crate) async fn run_install_script(
    script: &str,
    cancel: Arc<CancelToken>,
    on_line: &mut (impl FnMut(&str) + Send),
) -> Result<RunSignals, String> {
    let child = spawn_install_script(script).map_err(|e| format!("启动 omp 安装脚本失败：{e}"))?;
    let pid = child.id();
    let pump = pump_child(child, pid, Some(cancel.as_ref()), |l, _s: OutStream| on_line(l));
    match tokio::time::timeout(INSTALL_TIMEOUT, pump).await {
        Ok(signals) => Ok(signals),
        Err(_) => {
            if let Some(pid) = pid {
                force_kill_group(pid);
            }
            Err(format!("omp 安装超时（{} 分钟）", INSTALL_TIMEOUT.as_secs() / 60))
        }
    }
}

/// 安装 omp（官方安装脚本）：omp 缺失时左栏版本处的「安装 omp」入口。
///
/// 与 `start_omp_update` 同一套口径：命令立刻返回，输出行与终局走 Channel；
/// 与更新**共用一个全局单槽**（机器级操作，同一时刻只能有一个）；成功后的路径 / 版本
/// 不在这里探——由前端调用 `get_health` 重新识别（`~/.local/bin`、`~/.bun/bin` 都在
/// `discover_omp_path` 的兜底里）。
#[tauri::command]
pub async fn install_omp(state: State<'_, AppState>, on_event: Channel<OmpUpdateEvent>) -> Result<(), CmdError> {
    let slot = state.omp_update_task.clone();
    let (seq, cancel) = acquire(&slot)?;
    tokio::spawn(async move {
        let _ = on_event.send(OmpUpdateEvent::Line { text: format!("$ {INSTALL_SCRIPT}") });
        let mut emit = |line: &str| {
            let _ = on_event.send(OmpUpdateEvent::Line { text: line.to_string() });
        };
        let outcome = match run_install_script(INSTALL_SCRIPT, cancel, &mut emit).await {
            Err(e) => OmpUpdateOutcome { phase: OmpUpdatePhase::Failed, from: None, error: Some(e) },
            Ok(signals) => {
                let (phase, error) = classify_update(&signals);
                OmpUpdateOutcome { phase, from: None, error }
            }
        };
        // 先放槽再发终局事件（与更新同口径：前端收到失败后立刻重试不会撞 BUSY）
        release(&slot, seq);
        let _ = on_event.send(OmpUpdateEvent::Exit { outcome });
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本机实测输出（omp 18.3.5 → 18.4.2）。
    #[test]
    fn parses_available_output() {
        let s = parse_check_output("Current version: 18.3.5\nNew version available: 18.4.2\n", "", Some(0)).unwrap();
        assert_eq!(s.current.as_deref(), Some("18.3.5"));
        assert_eq!(s.latest.as_deref(), Some("18.4.2"));
        assert_eq!(s.channel, "stable");
    }

    /// 已是最新（上游成功输出之二；`✔` 是上游的符号，剥色后原样保留）。
    #[test]
    fn parses_up_to_date_output() {
        let s = parse_check_output("Current version: 18.3.5\n✔ Already up to date\n", "", Some(0)).unwrap();
        assert_eq!(s.current.as_deref(), Some("18.3.5"));
        assert_eq!(s.latest, None);
        assert_eq!(s.channel, "stable");
    }

    /// canary 档多一行渠道标签（上游只在 canary 时打印）。
    #[test]
    fn parses_canary_channel() {
        let s = parse_check_output("Current version: 18.4.1-canary.3\nCurrent channel: canary\nNew version available: 18.4.2-canary.1\n", "", Some(0)).unwrap();
        assert_eq!(s.channel, "canary");
        assert_eq!(s.latest.as_deref(), Some("18.4.2-canary.1"));
    }

    /// 上色输出（`FORCE_COLOR` 下的形态）与素色等价。
    #[test]
    fn strips_ansi_before_parsing() {
        let colored = "\u{1b}[2mCurrent version: 18.3.5\u{1b}[22m\n\u{1b}[36mNew version available: 18.4.2\u{1b}[39m\n";
        let s = parse_check_output(colored, "", Some(0)).unwrap();
        assert_eq!(s.current.as_deref(), Some("18.3.5"));
        assert_eq!(s.latest.as_deref(), Some("18.4.2"));
    }

    /// 失败：退出码 1 + stderr 一行（实测原文），原因剥掉上游前缀给界面。
    #[test]
    fn surfaces_failure_reason() {
        let e = parse_check_output(
            "Current version: 18.3.5\n",
            "Failed to check for updates: TypeError: Unable to connect. Is the computer able to access the url?\n",
            Some(1),
        )
        .unwrap_err();
        assert!(e.starts_with("TypeError: Unable to connect"), "{e}");
    }

    /// 空输出（退出码 0）不当作「已是最新」——宁可报检查失败。
    #[test]
    fn rejects_unparseable_output() {
        assert!(parse_check_output("", "", Some(0)).is_err());
        assert!(parse_check_output("Current version: 18.3.5\n", "", Some(1)).is_err());
    }

    /// 慢测试（`cargo test -- --ignored`）：真的跑一次 `omp update --check`（要联网打 registry，
    /// 只检查不安装）。离线 / 限流时走失败分支——两条路径都必须是可解析的形状。
    #[test]
    #[ignore]
    fn real_omp_update_check_parses() {
        let out = std::process::Command::new("omp")
            .args(["update", "--check"])
            .output()
            .expect("omp 不在 PATH 上");
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let code = out.status.code();
        println!("omp update --check 退出码 {code:?}\nstdout:\n{stdout}stderr:\n{stderr}");
        match parse_check_output(&stdout, &stderr, code) {
            Ok(s) => {
                assert!(s.current.is_some(), "成功输出应带当前版本");
                println!("当前 {} → 最新 {}", s.current.as_deref().unwrap_or("?"), s.latest.as_deref().unwrap_or("（已是最新）"));
            }
            Err(e) => assert!(!e.trim().is_empty(), "失败原因不该为空"),
        }
    }
}

/// 更新执行路径的测试：用**假 omp 脚本**当被测程序（不碰真实安装、不联网）。
#[cfg(test)]
mod update_tests {
    use super::*;

    /// 造一个假 omp（可执行 shell 脚本）。返回它的路径。
    fn fake_omp(tag: &str, body: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("omp-update-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("omp");
        std::fs::write(&bin, format!("#!/bin/sh\n{body}\n")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        (dir, bin)
    }

    /// 成功路径：两路输出都进 `on_line`（stderr 也在，日志区要看得见安装进度），退出码 0 → Done。
    #[tokio::test]
    async fn run_update_streams_lines_and_reports_success() {
        let (dir, bin) = fake_omp(
            "ok",
            "echo 'Current version: 18.3.5'\necho 'Downloading omp…'\necho 'warning: 来自 stderr 的一行' >&2\necho 'Restart omp to use the new version'\nexit 0",
        );
        let mut lines: Vec<String> = vec![];
        let signals = run_update(bin.to_str().unwrap(), Some(&dir), CancelToken::new(), &mut |l| lines.push(l.to_string()))
            .await
            .unwrap();
        assert_eq!(signals.code, Some(0));
        assert!(lines.iter().any(|l| l.contains("Downloading omp")), "{lines:?}");
        assert!(lines.iter().any(|l| l.contains("来自 stderr")), "{lines:?}");
        let (phase, error) = classify_update(&signals);
        assert_eq!(phase, OmpUpdatePhase::Done);
        assert!(error.is_none());
    }

    /// 失败路径：非零退出 → Failed，错误摘要取输出尾行（上游把安装失败写在 stderr）。
    #[tokio::test]
    async fn run_update_reports_failure_tail() {
        let (dir, bin) = fake_omp("fail", "echo 'Updating via npm...'\necho 'npm install failed with exit code 1' >&2\nexit 2");
        let signals = run_update(bin.to_str().unwrap(), Some(&dir), CancelToken::new(), &mut |_| {}).await.unwrap();
        assert_eq!(signals.code, Some(2));
        let (phase, error) = classify_update(&signals);
        assert_eq!(phase, OmpUpdatePhase::Failed);
        assert!(error.unwrap().contains("npm install failed"), "错误摘要应带 stderr 尾行");
    }

    /// 取消路径：脚本长睡，200ms 后取消——进程组被杀、`run_update` 秒级返回、终态是 Canceled
    /// （装到一半被取消不该被误报成失败）。
    #[tokio::test]
    async fn run_update_cancel_kills_process_group() {
        let (dir, bin) = fake_omp("cancel", "echo '开始安装'\nsleep 30\necho '不该走到这里'");
        let cancel = CancelToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            trigger.cancel();
        });
        let started = std::time::Instant::now();
        let signals = run_update(bin.to_str().unwrap(), Some(&dir), cancel, &mut |_| {}).await.unwrap();
        assert!(signals.canceled, "取消标志必须落到 RunSignals");
        assert!(started.elapsed() < Duration::from_secs(10), "取消后应立刻返回，实际 {:?}", started.elapsed());
        assert_eq!(classify_update(&signals).0, OmpUpdatePhase::Canceled);
    }

    // ---------- 安装（官方安装脚本，用假脚本代替、不联网） ----------

    /// 成功路径：脚本两路输出都进日志，退出码 0 → Done（与更新共用终态判定）。
    #[tokio::test]
    async fn install_script_streams_lines_and_reports_success() {
        let mut lines: Vec<String> = vec![];
        let signals = run_install_script(
            "echo 'Installing via bun...'\necho '✓ Installed omp via bun'\necho 'warning: 来自 stderr 的一行' >&2",
            CancelToken::new(),
            &mut |l| lines.push(l.to_string()),
        )
        .await
        .unwrap();
        assert_eq!(signals.code, Some(0));
        assert!(lines.iter().any(|l| l.contains("Installing via bun")), "{lines:?}");
        assert!(lines.iter().any(|l| l.contains("来自 stderr")), "{lines:?}");
        let (phase, error) = classify_update(&signals);
        assert_eq!(phase, OmpUpdatePhase::Done);
        assert!(error.is_none());
    }

    /// 失败路径：非零退出 → Failed，错误摘要取输出尾行（脚本的报错在 stderr）。
    #[tokio::test]
    async fn install_script_reports_failure_tail() {
        let signals = run_install_script(
            "echo 'Fetching latest release...'\necho 'Failed to resolve an omp build' >&2\nexit 1",
            CancelToken::new(),
            &mut |_| {},
        )
        .await
        .unwrap();
        assert_eq!(signals.code, Some(1));
        let (phase, error) = classify_update(&signals);
        assert_eq!(phase, OmpUpdatePhase::Failed);
        assert!(error.unwrap().contains("Failed to resolve an omp build"), "错误摘要应带 stderr 尾行");
    }

    /// 取消路径：安装脚本长睡，200ms 后取消——进程组被杀、终态是 Canceled。
    #[tokio::test]
    async fn install_script_cancel_kills_process_group() {
        let cancel = CancelToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            trigger.cancel();
        });
        let started = std::time::Instant::now();
        let signals = run_install_script("echo '开始安装'\nsleep 30", cancel, &mut |_| {}).await.unwrap();
        assert!(signals.canceled, "取消标志必须落到 RunSignals");
        assert!(started.elapsed() < Duration::from_secs(10), "取消后应立刻返回，实际 {:?}", started.elapsed());
        assert_eq!(classify_update(&signals).0, OmpUpdatePhase::Canceled);
    }
}
