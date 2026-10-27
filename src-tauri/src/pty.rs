//! 右栏「终端」页签的后端（v4 右栏改造）：一个终端 = 一个 PTY 里的**登录 shell**。
//!
//! 与终端会话形态无关——这里不拼 omp 启动参数、不注入覆盖层、不解析 OSC 标题、
//! 没有标签栏与目录行：工作目录由前端按当前会话给出，进程表按前端给的 id 寻址，
//! 前端关闭终端即 kill，应用退出走 [`kill_all`]。
//!
//! 读写口径与聊天 runtime 一致：读线程阻塞读 master → 增量 UTF-8 解码 → 推 Channel；
//! EOF（shell 退出）收尾并回报退出码。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::commands::{cmd_err, AppState, CmdError};
use crate::proc::{force_kill_group, login_path};

/// 单个 UTF-8 字符最多 4 字节；残留超过它就是坏数据，不用再等。
const UTF8_MAX_SEQ: usize = 4;

/// spawn 序号：读线程收尾时用它确认「map 里的句柄还是我这一次 spawn 的」，
/// 防止「杀掉后立刻以同一 id 重启」时旧读线程误删新句柄。
static SPAWN_SEQ: AtomicU64 = AtomicU64::new(1);

/// 一个终端的存活句柄。读线程独立持有 `Child`（`wait` 需要所有权），
/// 这里保留 writer / master / killer / pid 供写、resize、kill 三路使用。
///
/// `pid` 是子进程的进程号；PTY 里它就是**进程组长**（portable-pty spawn 时建了新会话），
/// 所以强杀可以打 `-pid` 覆盖它 fork 出来的工具子进程。
pub struct TerminalHandle {
    seq: u64,
    pid: Option<u32>,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// 最近一次 PTY 输出的时刻（Windows 的就绪判据用：ConPTY 没有 termios，
    /// 只能按「提示符画完、安静下来」判断；Unix 走 raw 模式检测，不读它）。
    #[cfg(windows)]
    last_output: Arc<Mutex<Option<std::time::Instant>>>,
}

/// 终端进程表（前端 id → 句柄）。
pub type TerminalMap = Arc<Mutex<HashMap<String, TerminalHandle>>>;

/// 发往前端的终端事件（Channel 序列化，tag 区分）。
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TerminalEvent {
    /// PTY 输出（已是完整 UTF-8 前缀）。
    Data { data: String },
    /// shell 退出；`code` 为 None = 拿不到退出码（被信号杀掉等）。
    Exit { code: Option<i32> },
}

/// spawn 入参：id 由前端生成（写 / resize / kill 都用它寻址）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSpawnOpts {
    pub id: String,
    /// 工作目录（当前会话的 cwd）。
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    /// 指定 shell 可执行文件；None = 用户登录 shell（`$SHELL`，退回 /bin/zsh）。
    #[serde(default)]
    pub shell: Option<String>,
}

/// 优雅终止 + 强制兜底：先发 portable-pty 的 kill（Unix 上是 SIGHUP），
/// 1 秒后仍在则 SIGKILL 整个进程组。
///
/// 为什么需要兜底：shell 不理会 SIGHUP 时（有后台任务 / 挂了前台程序）`wait` 会永久挂住，
/// 读线程永不收尾，进程表里留下僵尸句柄。
fn terminate(pid: Option<u32>, killer: &mut dyn ChildKiller) {
    let _ = killer.kill();
    let Some(pid) = pid else { return };
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1000));
        force_kill_group(pid);
    });
}

/// 读线程收尾用：等子进程退出（最多 `grace`），超时则强杀进程组。
fn wait_with_grace(child: &mut Box<dyn Child + Send + Sync>, pid: Option<u32>, grace: Duration) -> Option<i32> {
    let deadline = std::time::Instant::now() + grace;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.exit_code() as i32),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50))
            }
            _ => break,
        }
    }
    if let Some(pid) = pid {
        force_kill_group(pid);
    }
    child.wait().ok().map(|s| s.exit_code() as i32)
}

/// 从缓冲里取出「完整的 UTF-8 前缀」，不完整的尾部留在缓冲里等下一个读块。
///
/// 边界行为：
/// - 多字节字符被读块切开：前半留待拼接，不产出「�」（终端输出的常见情况）；
/// - 真的出现非法字节（或残留超过一个字符的最大长度仍拼不成）：按 lossy 摄入并清出，
///   否则坏数据会把后续所有输出永久卡在 pending 里。
pub fn drain_utf8(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_string();
            pending.clear();
            out
        }
        Err(e) => {
            let valid = e.valid_up_to();
            // valid_up_to 保证前缀合法；用 get 而不是 unwrap，防御性写法不该有 panic 面。
            let mut out = std::str::from_utf8(&pending[..valid]).unwrap_or_default().to_string();
            pending.drain(..valid);
            if e.error_len().is_some() || pending.len() > UTF8_MAX_SEQ {
                out.push_str(&String::from_utf8_lossy(pending));
                pending.clear();
            }
            out
        }
    }
}

/// PTY 已建立、子进程已启动的原始句柄组（尚未登记进进程表）。
pub struct SpawnedTerminal {
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    pub master: Box<dyn MasterPty + Send>,
    pub killer: Box<dyn ChildKiller + Send + Sync>,
    pub child: Box<dyn Child + Send + Sync>,
}

/// Windows 默认 shell：pwsh 7 → Windows PowerShell 5.1 → cmd.exe。
///
/// 为什么不是 WSL 的 bash：终端打开的是**当前项目目录**。项目在 Windows 盘上时，
/// WSL 看不到用户期望的路径映射，反而多一层 `wslpath`；项目在 WSL 里时由
/// [`wsl_shell`] 单独接管（见 P1）。这里只负责原生 Windows。
#[cfg(windows)]
fn windows_shell() -> String {
    let mut candidates: Vec<String> = Vec::new();
    for key in ["ProgramFiles", "ProgramW6432"] {
        if let Ok(dir) = std::env::var(key) {
            candidates.push(Path::new(&dir).join("PowerShell/7/pwsh.exe").to_string_lossy().into_owned());
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join("pwsh.exe").to_string_lossy().into_owned());
        }
    }
    if let Ok(root) = std::env::var("SystemRoot") {
        candidates.push(
            Path::new(&root)
                .join("System32/WindowsPowerShell/v1.0/powershell.exe")
                .to_string_lossy()
                .into_owned(),
        );
    }
    if let Ok(comspec) = std::env::var("ComSpec") {
        candidates.push(comspec);
    }
    candidates
        .into_iter()
        .find(|p| Path::new(p).is_file())
        .unwrap_or_else(|| "cmd.exe".into())
}

/// 终端默认 shell：POSIX 用登录 shell（`$SHELL`）；Windows 见 [`windows_shell`]。
pub fn login_shell() -> String {
    #[cfg(windows)]
    {
        windows_shell()
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        if Path::new(&shell).is_file() {
            shell
        } else {
            "/bin/zsh".into()
        }
    }
}

/// 每种 shell 的启动参数：只有 POSIX 登录 shell 吃 `-l`。
///
/// `cmd.exe` 不认 `-l`（会把它当命令名）；PowerShell 用 `-NoLogo` 少打版权横幅。
/// Git Bash / zsh / fish 仍然 `-l`，与用户真实终端一致。
pub fn shell_args(shell: &str) -> Vec<String> {
    let name = Path::new(shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name == "cmd" || name == "cmd.exe" {
        return Vec::new();
    }
    if name == "pwsh" || name == "pwsh.exe" || name == "powershell" || name == "powershell.exe" {
        return vec!["-NoLogo".into()];
    }
    vec!["-l".into()]
}

/// shell 是否可启动：POSIX 必须是真实文件；Windows 允许裸名字（`cmd.exe` 由
/// CreateProcess 按 PATH / 系统目录解析，`Path::is_file()` 对它不成立）。
fn shell_exists(shell: &str) -> bool {
    Path::new(shell).is_file() || (cfg!(windows) && !shell.contains('\\') && !shell.contains('/'))
}

/// WSL 项目：终端直接进该发行版（bash 登录 shell）。
///
/// 只用于**终端**——聊天会话不跨发行版启动 omp（`create_session` 会明确拒绝），
/// 所以这里不需要关心 omp 的 PATH / 会话文件落点。命令的构造见
/// [`crate::wsl::bash_launch`]（`cd` 到 Linux 路径后 `exec bash -l`）。
fn wsl_shell(cwd: &str) -> Option<(String, Vec<String>)> {
    let w = crate::wsl::parse_unc(cwd)?;
    Some(crate::wsl::bash_launch(&w.distro, &w.linux, "bash", &["-l".to_string()]))
}

/// 建 PTY 并启动一个子进程。抽成纯函数以便在真实 PTY 上做单测（见文末）。
pub fn spawn_terminal(bin: &str, args: &[String], cwd: &str, size: PtySize) -> Result<SpawnedTerminal, String> {
    let mut cmd = CommandBuilder::new(bin);
    for a in args {
        cmd.arg(a);
    }
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "omp-inn");
    // GUI 启动的 .app 只继承 launchd 的贫瘠 PATH（没有 /opt/homebrew/bin）：
    // 终端里 `git` / `node` 都要能找到，继承登录 shell 的 PATH（见 `proc.rs`）。
    if let Some(path) = login_path() {
        cmd.env("PATH", path);
    }

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(size).map_err(|e| format!("创建 PTY 失败：{e}"))?;
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("启动终端失败：{e}"))?;
    // slave 在本进程里不再使用：必须尽早 drop，否则子进程退出后 master 读不到 EOF。
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| format!("PTY 读取端创建失败：{e}"))?;
    let writer = pair.master.take_writer().map_err(|e| format!("PTY 写入端创建失败：{e}"))?;
    let killer = child.clone_killer();
    Ok(SpawnedTerminal { reader, writer, master: pair.master, killer, child })
}

/// 打开一个终端（右栏「终端」页签首次显示某目录时调用）。
///
/// 启动参数按 shell 分叉（见 [`shell_args`]）：POSIX 登录 shell 用 `-l`，
/// Windows 的 PowerShell 用 `-NoLogo`、cmd 不带参数。
#[tauri::command]
pub async fn terminal_spawn(
    state: State<'_, AppState>,
    opts: TerminalSpawnOpts,
    on_event: Channel<TerminalEvent>,
) -> Result<(), CmdError> {
    if !Path::new(&opts.cwd).is_dir() {
        return Err(cmd_err("DIR_MISSING", "工作目录不存在".into(), Some(opts.cwd.clone())));
    }
    {
        let map = state.terminals.lock().unwrap_or_else(|e| e.into_inner());
        if map.contains_key(&opts.id) {
            return Err(cmd_err("ALREADY_EXISTS", "终端已存在".into(), None));
        }
    }
    // shell 选择顺序：显式指定 → WSL 项目（进发行版）→ 平台默认。
    // WSL 判定只看 cwd：`\\wsl$\<distro>\...` 是 Windows 能看到的 UNC 路径。
    let (shell, args, process_cwd) = if let Some(s) = opts.shell.clone() {
        let a = shell_args(&s);
        (s, a, opts.cwd.clone())
    } else if let Some((bin, wsl_args)) = wsl_shell(&opts.cwd) {
        // 不要把 `\\wsl$\...` 设成 wsl.exe 的 Windows 工作目录（WSL 映射不回去）；
        // 用系统临时目录，真正的 `cd` 在 bash 脚本里按 Linux 路径执行。
        let tmp = std::env::temp_dir().to_string_lossy().into_owned();
        (bin, wsl_args, tmp)
    } else {
        let s = login_shell();
        let a = shell_args(&s);
        (s, a, opts.cwd.clone())
    };
    if !shell_exists(&shell) {
        return Err(cmd_err("SHELL_MISSING", format!("找不到 shell：{shell}"), None));
    }
    let size = PtySize { rows: opts.rows.max(2), cols: opts.cols.max(2), pixel_width: 0, pixel_height: 0 };
    let spawned = spawn_terminal(&shell, &args, &process_cwd, size)
        .map_err(|e| cmd_err("TERMINAL_SPAWN", e, None))?;
    let SpawnedTerminal { reader, writer, master, killer, mut child } = spawned;
    let pid = child.process_id();

    let seq = SPAWN_SEQ.fetch_add(1, Ordering::Relaxed);
    #[cfg(windows)]
    let last_output: Arc<Mutex<Option<std::time::Instant>>> = Arc::new(Mutex::new(None));
    {
        let mut map = state.terminals.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(
            opts.id.clone(),
            TerminalHandle {
                seq,
                pid,
                writer,
                master,
                killer,
                #[cfg(windows)]
                last_output: last_output.clone(),
            },
        );
    }

    // 读线程：阻塞读 → 增量解码 → 推 Channel；EOF（shell 退出）或前端断开后收尾。
    let id = opts.id.clone();
    let map_handle = state.terminals.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 65536];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let text = drain_utf8(&mut pending);
                    if text.is_empty() {
                        continue;
                    }
                    if on_event.send(TerminalEvent::Data { data: text }).is_err() {
                        break;
                    }
                    #[cfg(windows)]
                    {
                        *last_output.lock().unwrap_or_else(|e| e.into_inner()) = Some(std::time::Instant::now());
                    }
                }
                Err(_) => break,
            }
        }
        // 收尾：EOF（用户 exit / 前端断开）。先 SIGHUP，给 1 秒优雅窗口；
        // 仍活着（后台任务挂着）则强杀进程组——否则 wait 永久挂住。
        let _ = child.kill();
        let code = wait_with_grace(&mut child, pid, Duration::from_millis(1000));
        let _ = on_event.send(TerminalEvent::Exit { code });
        // 只摘除「还是我这一次 spawn」的句柄：同 id 快速重启时不许误删新句柄。
        let mut map = map_handle.lock().unwrap_or_else(|e| e.into_inner());
        if map.get(&id).map(|h| h.seq) == Some(seq) {
            map.remove(&id);
        }
    });

    Ok(())
}

/// 等 shell 就绪的上限：超时就照写（命令晚跑总比永远不跑好）。
/// 行编辑器正常几百毫秒内就切 raw；没有行编辑的 shell 只能靠这个上限兜底。
const SHELL_READY_WAIT: Duration = Duration::from_secs(8);

/// PTY 的行编辑器是否已经把终端切到 raw 模式（ICANON、ECHO 全关）。
///
/// zsh 的 zle / bash 的 readline / fish 都在提示符出来前做这次切换。**早于这个时刻写命令**，
/// 字符先被 tty 行规程回显一遍，行编辑器起来后又把输入缓冲连提示符一起重画一次——界面上就是
/// 「命令出现两遍」（2026-10-22 用户实测：点脚本后终端里两行同样的命令，实际只执行一次）。
/// raw 之后写入不再回显，行编辑器只会把命令画进正在编辑的那一行。
#[cfg(unix)]
fn termios_is_raw(master: &dyn MasterPty) -> bool {
    let Some(fd) = master.as_raw_fd() else { return true };
    let mut t: libc::termios = unsafe { std::mem::zeroed() };
    // 拿不到 termios（非 tty / 平台差异）时不挡写入：宁可按旧行为执行，也不要让命令永远不跑
    if unsafe { libc::tcgetattr(fd, &mut t) } != 0 {
        return true;
    }
    t.c_lflag & (libc::ICANON | libc::ECHO) == 0
}

/// 终端是否可以喂命令：Unix 等行编辑器 raw（见 [`termios_is_raw`]）；Windows（ConPTY 没有
/// termios）退回「出过输出、并且安静了 250ms」——提示符画完 shell 就在等输入，此时写只会被
/// 控制台回显一次。
#[cfg(unix)]
fn shell_ready(handle: &TerminalHandle) -> bool {
    termios_is_raw(handle.master.as_ref())
}

#[cfg(windows)]
fn shell_ready(handle: &TerminalHandle) -> bool {
    let last = *handle.last_output.lock().unwrap_or_else(|e| e.into_inner());
    matches!(last, Some(at) if at.elapsed() >= Duration::from_millis(250))
}

/// 轮询等终端可写（见 [`shell_ready`]）；等待期间终端被关掉 = NOT_FOUND。
async fn wait_shell_ready(map: &TerminalMap, id: &str) -> Result<(), CmdError> {
    let deadline = std::time::Instant::now() + SHELL_READY_WAIT;
    loop {
        {
            let map = map.lock().unwrap_or_else(|e| e.into_inner());
            let Some(h) = map.get(id) else {
                return Err(cmd_err("NOT_FOUND", "终端不存在".into(), None));
            };
            if shell_ready(h) {
                return Ok(());
            }
        }
        if std::time::Instant::now() >= deadline {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// 写入 PTY（键盘输入，立刻透传；用户打什么就写什么，不许排队等提示符）。
#[tauri::command]
pub fn terminal_write(state: State<'_, AppState>, id: String, data: String) -> Result<(), CmdError> {
    write_now(&state.terminals, &id, &data)
}

/// 脚本注入：等 shell 进入可输入状态再写（见 [`shell_ready`]）。
///
/// 单独一条命令而不是给 `terminal_write` 加参数：键盘输入必须保持同步、按调用顺序落进 PTY，
/// 只有脚本注入需要等待。等待期间终端被关掉 = NOT_FOUND。
#[tauri::command]
pub async fn terminal_write_ready(state: State<'_, AppState>, id: String, data: String) -> Result<(), CmdError> {
    let map = state.terminals.clone();
    wait_shell_ready(&map, &id).await?;
    write_now(&map, &id, &data)
}

fn write_now(map: &TerminalMap, id: &str, data: &str) -> Result<(), CmdError> {
    let mut map = map.lock().unwrap_or_else(|e| e.into_inner());
    let Some(h) = map.get_mut(id) else {
        return Err(cmd_err("NOT_FOUND", "终端不存在".into(), None));
    };
    h.writer.write_all(data.as_bytes()).map_err(|e| cmd_err("TERMINAL_WRITE", e.to_string(), None))?;
    h.writer.flush().map_err(|e| cmd_err("TERMINAL_WRITE", e.to_string(), None))
}

/// 面板尺寸变化 → PTY 行列数（shell 的换行与全屏程序都靠它）。
#[tauri::command]
pub fn terminal_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<(), CmdError> {
    let map = state.terminals.lock().unwrap_or_else(|e| e.into_inner());
    let Some(h) = map.get(&id) else {
        return Err(cmd_err("NOT_FOUND", "终端不存在".into(), None));
    };
    h.master
        .resize(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| cmd_err("TERMINAL_RESIZE", e.to_string(), None))
}

/// 关闭终端（已退出时是 no-op）。
#[tauri::command]
pub fn terminal_kill(state: State<'_, AppState>, id: String) -> Result<(), CmdError> {
    let mut map = state.terminals.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut h) = map.remove(&id) {
        terminate(h.pid, h.killer.as_mut());
    }
    Ok(())
}

/// 应用退出前的收尾：杀掉全部终端进程（正常退出路径；崩溃残留接受为已知边界）。
/// 退出路径不等优雅窗口（进程马上没了，延迟补刀跑不到）——SIGHUP 之后直接 SIGKILL。
pub fn kill_all(map: &TerminalMap) {
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    for (_, mut h) in guard.drain() {
        let _ = h.killer.kill();
        if let Some(pid) = h.pid {
            force_kill_group(pid);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drain(chunks: &[&[u8]]) -> String {
        let mut pending = Vec::new();
        let mut out = String::new();
        for c in chunks {
            pending.extend_from_slice(c);
            out.push_str(&drain_utf8(&mut pending));
        }
        out
    }

    #[test]
    fn drain_utf8_keeps_split_multibyte() {
        // 「中」= E4 B8 AD，切成两段读入：第一段不许产出替换字符
        let first = drain(&[&[0xE4, 0xB8]]);
        assert_eq!(first, "");
        let mut pending = vec![0xE4, 0xB8];
        pending.extend_from_slice(&[0xAD]);
        assert_eq!(drain_utf8(&mut pending), "中");
        assert!(pending.is_empty());
    }

    #[test]
    fn drain_utf8_flushes_invalid_prefix() {
        // 非法字节不许把后续输出永久卡住：先出合法前缀，坏数据 lossy 摄入
        let mut pending = vec![b'a', 0xFF, b'b'];
        let out = drain_utf8(&mut pending);
        assert!(out.starts_with('a'));
        assert!(out.ends_with('b'));
        assert!(pending.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn spawn_terminal_roundtrip() {
        // 真 PTY 回环：输出可读 + 退出码透传（不依赖 omp / 用户 shell）
        let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
        let args = vec!["-c".to_string(), "printf READY; exit 3".to_string()];
        let spawned = spawn_terminal("/bin/sh", &args, "/tmp", size).expect("spawn");
        let SpawnedTerminal { mut reader, mut child, .. } = spawned;
        let mut out = String::new();
        let mut buf = [0u8; 1024];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    out.push_str(&drain_utf8(&mut pending));
                }
                Err(_) => break,
            }
        }
        assert!(out.contains("READY"), "PTY 输出不含 READY：{out:?}");
        let status = child.wait().expect("wait");
        assert_eq!(status.exit_code(), 3);
    }

    #[cfg(unix)]
    #[test]
    fn shell_ready_tracks_line_editor_raw_mode() {
        // 复现行编辑器的终端模式切换：启动期是 cooked（写命令会被 tty 回显两遍），
        // 提示符出来前切 `stty raw -echo`（= zle / readline 的动作）后才算可写。
        let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
        let args = vec!["-c".to_string(), "sleep 1; stty raw -echo; sleep 1".to_string()];
        let spawned = spawn_terminal("/bin/sh", &args, "/tmp", size).expect("spawn");
        let SpawnedTerminal { master, mut child, .. } = spawned;
        assert!(!termios_is_raw(master.as_ref()), "shell 行编辑器起来之前不该判为可写");
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        let mut ready = false;
        while std::time::Instant::now() < deadline {
            if termios_is_raw(master.as_ref()) {
                ready = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(ready, "`stty raw -echo` 之后应判为可写");
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(unix)]
    #[test]
    fn ready_gate_prevents_double_command_line() {
        // 回归（2026-10-22 用户实测「点脚本后终端里命令出现两遍」）：
        // cooked 期（shell 还没把终端交给行编辑器）写命令，tty 先回显一遍，zle 起来后又把
        // 输入缓冲连提示符重画一遍 → 两行；等 `termios_is_raw` 再写只剩 zle 自己那一行。
        if !Path::new("/bin/zsh").is_file() {
            return; // 没有 zsh 的平台跳过（本测试用 zsh 的 zle 做基准）
        }
        fn command_lines(wait_ready: bool) -> usize {
            let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
            let args = vec!["-f".to_string(), "-l".to_string()];
            let spawned = spawn_terminal("/bin/zsh", &args, "/tmp", size).expect("spawn");
            let SpawnedTerminal { mut reader, mut writer, master, mut child, .. } = spawned;
            // 输出必须被持续读走：行编辑器的 tcsetattr 会等输出队列清空，不读就永远进不了 raw
            let out = Arc::new(Mutex::new(Vec::new()));
            let sink = out.clone();
            let reader_thread = std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => sink.lock().unwrap().extend_from_slice(&buf[..n]),
                    }
                }
            });
            if wait_ready {
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                while std::time::Instant::now() < deadline && !termios_is_raw(master.as_ref()) {
                    std::thread::sleep(Duration::from_millis(5));
                }
                assert!(termios_is_raw(master.as_ref()), "zsh 的 zle 未进入 raw 模式");
            }
            writer.write_all(b"echo MARK\r").expect("write");
            std::thread::sleep(Duration::from_millis(700));
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader_thread.join();
            let bytes = out.lock().unwrap();
            bytes.windows(b"echo MARK".len()).filter(|w| *w == b"echo MARK").count()
        }

        let immediate = command_lines(false);
        let ready = command_lines(true);
        assert!(immediate > 1, "cooked 期写入应复现两行命令（tty 回显 + zle 重画）：{immediate}");
        assert_eq!(ready, 1, "等行编辑器 raw 再写，命令只应出现一次：{ready}");
    }
}
