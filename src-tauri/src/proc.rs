//! 进程与环境工具（登录 shell PATH 探测、进程组强杀），复用方 = git_commit / commit_msg / omp_update。

#[cfg(not(windows))]
use std::io::Read;
#[cfg(not(windows))]
use std::sync::LazyLock;
#[cfg(not(windows))]
use std::time::Duration;

/// SIGKILL 进程组（负 pid）；组不存在（不是组长）时退回单进程。
#[cfg(unix)]
pub(crate) fn force_kill_group(pid: u32) {
    unsafe {
        if libc::kill(-(pid as i32), libc::SIGKILL) != 0 {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
}

/// Windows 没有进程组信号：用系统自带的 `taskkill /T /F` 连子孙进程一起收掉。
///
/// 为什么不是 `child.kill()`：PTY 里的 shell 只是父进程，脚本 / omp / 子代理
/// 都是它的子孙；只杀父进程会留下孤儿（关终端后构建进程还在跑）。
/// `taskkill` 是 Windows 自带命令，不额外引 windows crate；隐藏控制台窗口。
#[cfg(windows)]
pub(crate) fn force_kill_group(pid: u32) {
    use std::os::windows::process::CommandExt;
    /// 不弹黑色控制台窗口（GUI 进程里 spawn 控制台程序时的默认行为）。
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    if pid == 0 {
        return;
    }
    let _ = std::process::Command::new("taskkill")
        .arg("/PID")
        .arg(pid.to_string())
        .arg("/T")
        .arg("/F")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(all(not(unix), not(windows)))]
pub(crate) fn force_kill_group(pid: u32) {
    let _ = pid;
}

/// 登录 shell 的 PATH（一次性探测 + 缓存）。
///
/// GUI 启动的 .app 只继承 launchd 的贫瘠 PATH（没有 /opt/homebrew/bin），
/// 壳内子进程（omp 会话 / git / 提交与更新任务）连 git / node 都可能找不到。
/// 让它们继承登录 shell 的 PATH，与用户在真实终端里跑 omp 的环境对齐；
/// 探测失败（无 SHELL / 超时）就退回继承 env，不阻断启动。
///
/// **Windows 不做这件事**：Explorer 启动的进程已经继承注册表环境（系统 + 用户
/// PATH 都已展开）；若用户装过 Git Bash，`SHELL` 会给出一份 MSYS 风格的 PATH
/// （`/usr/bin:/c/...`），覆盖上去会让原生 `git.exe` / `omp.exe` 反而找不到。
#[cfg(not(windows))]
static LOGIN_PATH: LazyLock<Option<String>> = LazyLock::new(|| {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = std::process::Command::new(&shell)
        .args(["-ilc", "printf %s \"$PATH\""])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    // 登录 shell 要跑一遍 rc，给 5s；超时直接放弃并杀掉探测进程。
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50))
            }
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let path = out.trim().to_string();
    (!path.is_empty()).then_some(path)
});

pub(crate) fn login_path() -> Option<&'static str> {
    #[cfg(windows)]
    {
        None
    }
    #[cfg(not(windows))]
    {
        LOGIN_PATH.as_deref()
    }
}
