//! 进程与环境工具（登录 shell PATH 探测、进程组强杀），复用方 = git_commit / commit_msg / omp_update。

#[cfg(not(windows))]
use std::io::Read;
#[cfg(not(windows))]
use std::sync::LazyLock;
#[cfg(not(windows))]
use std::time::Duration;

/// 提交任务使用的子进程；Windows 启动前关联作业对象以保留后代进程控制权。
pub(crate) struct ManagedChild {
    #[cfg(windows)]
    child: Box<dyn process_wrap::tokio::ChildWrapper>,
    #[cfg(windows)]
    has_job: bool,
    #[cfg(not(windows))]
    child: tokio::process::Child,
}

impl From<tokio::process::Child> for ManagedChild {
    fn from(child: tokio::process::Child) -> Self {
        #[cfg(windows)]
        { Self { child: Box::new(child), has_job: false } }
        #[cfg(not(windows))]
        { Self { child } }
    }
}

impl ManagedChild {
    pub(crate) fn spawn(cmd: tokio::process::Command) -> std::io::Result<Self> {
        #[cfg(windows)]
        {
            use process_wrap::tokio::{CommandWrap, JobObject, KillOnDrop};
            let mut wrapped = CommandWrap::from(cmd);
            wrapped.wrap(JobObject).wrap(KillOnDrop);
            Ok(Self { child: wrapped.spawn()?, has_job: true })
        }
        #[cfg(not(windows))]
        {
            let mut cmd = cmd;
            Ok(Self { child: cmd.spawn()? })
        }
    }

    pub(crate) fn id(&self) -> Option<u32> { self.child.id() }

    pub(crate) fn stdin(&mut self) -> &mut Option<tokio::process::ChildStdin> {
        #[cfg(windows)] { self.child.stdin() }
        #[cfg(not(windows))] { &mut self.child.stdin }
    }
    pub(crate) fn stdout(&mut self) -> &mut Option<tokio::process::ChildStdout> {
        #[cfg(windows)] { self.child.stdout() }
        #[cfg(not(windows))] { &mut self.child.stdout }
    }
    pub(crate) fn stderr(&mut self) -> &mut Option<tokio::process::ChildStderr> {
        #[cfg(windows)] { self.child.stderr() }
        #[cfg(not(windows))] { &mut self.child.stderr }
    }

    /// 普通结束只等待主进程；超时或取消时改为等待整个作业。
    pub(crate) async fn wait_parent(&mut self) -> std::io::Result<std::process::ExitStatus> {
        #[cfg(windows)]
        if self.has_job {
            // 安全：只等待原生子进程，不拆除作业对象；后续仍可终止作业。
            let child = unsafe { self.child.try_inner_child_mut() }
                .ok_or_else(|| std::io::Error::other("无法读取子进程"))?;
            return child.wait().await;
        }
        self.child.wait().await
    }

    pub(crate) async fn wait_tree(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.child.wait().await
    }

    pub(crate) fn stop_tree(&mut self, pid: Option<u32>) -> bool {
        #[cfg(windows)]
        if self.has_job {
            return self.child.start_kill().is_ok();
        }
        let signaled = pid.is_some_and(force_kill_group_checked);
        let _ = self.child.start_kill();
        signaled
    }
}

/// SIGKILL 进程组（负 pid）；组不存在（不是组长）时退回单进程。
#[cfg(unix)]
pub(crate) fn force_kill_group(pid: u32) {
    let _ = force_kill_group_checked(pid);
}

/// 尝试停止进程组；返回值只表示进程组信号是否发送成功。
#[cfg(unix)]
pub(crate) fn force_kill_group_checked(pid: u32) -> bool {
    unsafe {
        if libc::kill(-(pid as i32), libc::SIGKILL) == 0 { return true; }
        libc::kill(pid as i32, libc::SIGKILL);
        false
    }
}

/// Windows 没有进程组信号：用系统自带的 `taskkill /T /F` 连子孙进程一起收掉。
///
/// 为什么不是 `child.kill()`：PTY 里的 shell 只是父进程，脚本 / omp / 子代理
/// 都是它的子孙；只杀父进程会留下孤儿（关终端后构建进程还在跑）。
/// `taskkill` 是 Windows 自带命令，不额外引 windows crate；隐藏控制台窗口。
#[cfg(windows)]
pub(crate) fn force_kill_group(pid: u32) {
    let _ = force_kill_group_checked(pid);
}

#[cfg(windows)]
pub(crate) fn force_kill_group_checked(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    /// 不弹黑色控制台窗口（GUI 进程里 spawn 控制台程序时的默认行为）。
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    if pid == 0 {
        return false;
    }
    std::process::Command::new("taskkill")
        .arg("/PID")
        .arg(pid.to_string())
        .arg("/T")
        .arg("/F")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status().is_ok_and(|status| status.success())
}

#[cfg(all(not(unix), not(windows)))]
pub(crate) fn force_kill_group(pid: u32) {
    let _ = pid;
}

#[cfg(all(not(unix), not(windows)))]
pub(crate) fn force_kill_group_checked(_pid: u32) -> bool {
    false
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
