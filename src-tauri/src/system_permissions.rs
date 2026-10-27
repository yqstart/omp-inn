//! 设置 ›「系统授权」：检测 macOS TCC 授权并跳到对应系统设置面板。
//!
//! 为什么需要它：computer use（omp 的截图 / AX 操作）走的是**本进程**的 TCC 归因——
//! omp 是壳 spawn 的子进程，责任进程（responsible process）就是 omp-inn 自己。
//! 用户在系统设置里「给了权限」不等于真的生效：ad-hoc 签名或证书轮换会让库里的旧记录
//! 与当前签名身份对不上（tccd 日志 `Failed to match existing code requirement`），
//! 界面上的开关却仍是开的。这里把四项授权做成可读的读数，并提供一键跳转。
//!
//! 四项与各自的可观测判据：
//! - 完全磁盘访问（Full Disk Access）：没有公开 API，用「能否读 TCC 库」探测（社区通行做法）；
//! - 辅助功能（Accessibility）：`AXIsProcessTrusted()`；
//! - 屏幕录制（Screen Capture）：`CGPreflightScreenCaptureAccess()`（macOS 10.15+）；
//! - 自动化（AppleEvents）：`AEDeterminePermissionToAutomateTarget` 以 System Events 为
//!   目标、`askUserIfNeeded = false`（**不会弹窗**；-1744 = 尚未询问，按未授权显示）。
//!   这个 API 按 bundle id 寻址时**要求目标进程正在运行**（否则 -600 `procNotFound`），
//!   而 System Events 是 launchd 按需拉起的 agent、平时不常驻——所以 -600 时先启动它再查
//!   （启动 app 不发 Apple Event、不触发授权框）。
//!
//! 非 macOS（Windows）返回 `supported: false`，界面据此只显示一句「仅 macOS 可用」。

use serde::Serialize;

/// 四项授权的快照（wire 上 camelCase，与前端类型一致）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPermissions {
    /// 平台是否支持这组检测（当前只有 macOS）。
    pub supported: bool,
    pub disk_access: bool,
    pub accessibility: bool,
    pub screen_capture: bool,
    pub automation: bool,
}

/// 读四项授权。纯本地查询（无网络），可随面板高频轮询。
///
/// 唯一的子进程例外：自动化检测发现 System Events 没在运行时，会 `open -b` 拉起它一次
/// （见 `launch_system_events` 的限流），否则那个 API 只会返回 -600、把已授权读成未授权。
#[tauri::command]
pub fn get_system_permissions() -> SystemPermissions {
    platform::detect()
}

/// 打开系统设置里对应的授权面板（`kind` = `disk` / `accessibility` / `screenCapture` / `automation`）。
#[tauri::command]
pub fn open_system_permission(kind: String) -> Result<(), String> {
    platform::open(&kind)
}

/// 授权类型 → 系统设置锚点（纯映射，单测覆盖；未知类型不猜）。
fn settings_anchor(kind: &str) -> Option<&'static str> {
    match kind {
        "disk" => Some("Privacy_AllFiles"),
        "accessibility" => Some("Privacy_Accessibility"),
        "screenCapture" => Some("Privacy_ScreenCapture"),
        "automation" => Some("Privacy_Automation"),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{settings_anchor, SystemPermissions};
    use std::ffi::c_void;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::time::Instant;

    // ApplicationServices: Boolean AXIsProcessTrusted(void)
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
    }

    // CoreGraphics: bool CGPreflightScreenCaptureAccess(void)（10.15+，显式查询不弹窗）
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
    }

    // Carbon / AE：自动化授权查询（只读，不触发系统确认框）
    #[repr(C)]
    struct AEDesc {
        descriptor_type: u32,
        data_handle: *mut c_void,
    }

    const TYPE_APPLICATION_BUNDLE_ID: u32 = 0x6275_6E64; // 'bund'
    const CORE_SUITE: u32 = 0x636F_7265; // 'core'
    const GET_DATA: u32 = 0x6765_7464; // 'getd'

    // `AEDeterminePermissionToAutomateTarget` 的返回码（其余非 0 值一律按未授权）。
    const NO_ERR: i32 = 0;
    pub(super) const PROC_NOT_FOUND: i32 = -600; // 目标进程没在运行，与授权无关

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn AECreateDesc(
            type_code: u32,
            data_ptr: *const c_void,
            data_size: isize,
            result: *mut AEDesc,
        ) -> i32;
        fn AEDisposeDesc(desc: *mut AEDesc) -> i32;
        fn AEDeterminePermissionToAutomateTarget(
            target: *const AEDesc,
            the_ae_event_class: u32,
            the_ae_event_id: u32,
            ask_user_if_needed: u8,
        ) -> i32;
    }

    pub fn detect() -> SystemPermissions {
        SystemPermissions {
            supported: true,
            disk_access: has_full_disk_access(),
            // SAFETY: 两个函数只读 TCC 状态，无参数、无所有权转移。
            accessibility: unsafe { AXIsProcessTrusted() != 0 },
            screen_capture: unsafe { CGPreflightScreenCaptureAccess() },
            automation: automation_allowed(),
        }
    }

    pub fn open(kind: &str) -> Result<(), String> {
        let anchor = settings_anchor(kind).ok_or_else(|| format!("未知的授权类型：{kind}"))?;
        let url = format!("x-apple.systempreferences:com.apple.preference.security?{anchor}");
        // 不等待：`open` 只把 URL 交给 LaunchServices，系统设置窗口的启动与本命令无关。
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("打开系统设置失败：{e}"))
    }

    /// 完全磁盘访问没有公开 API：受 TCC 保护的文件能读 = 已授权。
    ///
    /// TCC 库是最直接的判据；再兜一个 Safari 历史库（TCC 库不存在或被系统额外限制时）。
    /// 两个都读不到就是未授权——宁可显示「未授权」让用户去确认，也不假装已授权。
    fn has_full_disk_access() -> bool {
        let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
            return false;
        };
        [
            "Library/Application Support/com.apple.TCC/TCC.db",
            "Library/Safari/History.db",
        ]
        .iter()
        .any(|rel| std::fs::File::open(home.join(rel)).is_ok())
    }

    /// 自动化（AppleEvents）以 System Events 为探针：omp 的 osascript 路径第一个碰的就是它。
    ///
    /// `AEDeterminePermissionToAutomateTarget(.., false)` 只查不弹（0 = 已允许，-1743 = 已拒绝，
    /// -1744 = 尚未询问）。但 bundle id 寻址**要求目标进程正在运行**——System Events 由 launchd
    /// 按需拉起、平时不常驻，不在跑时一律返回 -600，直接查会把「已授权」读成未授权。所以
    /// -600 时先启动它再查一次。
    fn automation_allowed() -> bool {
        match query_automation() {
            NO_ERR => true,
            PROC_NOT_FOUND => recover_by_launching(),
            _ => false,
        }
    }

    /// -600 的恢复路径：拉起 System Events 再查。
    ///
    /// 限流只针对**拉起无效**的情形（`open` 失败 / 拉起后仍解析不到）：那种情况下每 2s 轮询都
    /// spawn 一个 `open` 是白费，30s 内不再重试。拉起有效时不留门槛——用户手动退出 System
    /// Events 后，下一轮轮询就能把它拉回来，不必等 30s、也不会闪过「未授权」。
    fn recover_by_launching() -> bool {
        static LAST_FAILURE: Mutex<Option<Instant>> = Mutex::new(None);
        let Ok(mut last_failure) = LAST_FAILURE.lock() else { return false };
        if last_failure.is_some_and(|at| at.elapsed().as_secs() < 30) {
            return false;
        }
        launch_system_events();
        // `open` 返回时通常已能解析到进程；没赶上就短暂等待（最多 250ms）——
        // 等的是「进程出现」，-1743 / -1744 这类授权结论等待也不会变。
        for attempt in 0..6 {
            if attempt > 0 {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            match query_automation() {
                NO_ERR => {
                    *last_failure = None;
                    return true;
                }
                PROC_NOT_FOUND => continue,
                _ => {
                    // 进程起来了：结论是授权本身（已拒绝 / 尚未询问），与拉起无关。
                    *last_failure = None;
                    return false;
                }
            }
        }
        *last_failure = Some(Instant::now());
        false
    }

    /// 查一次授权状态（纯查询：不发 Apple Event、不弹系统确认框）。
    pub(super) fn query_automation() -> i32 {
        const BUNDLE: &[u8] = b"com.apple.systemevents";
        let mut target = AEDesc { descriptor_type: 0, data_handle: std::ptr::null_mut() };
        // SAFETY: 只读传入 bundle id 字节，desc 由 AECreateDesc 填充、随后由本函数释放。
        let created = unsafe {
            AECreateDesc(
                TYPE_APPLICATION_BUNDLE_ID,
                BUNDLE.as_ptr() as *const c_void,
                BUNDLE.len() as isize,
                &mut target,
            )
        };
        if created != 0 {
            return i32::from(created);
        }
        // SAFETY: target 是上面创建的有效 AEDesc。
        let status = unsafe {
            AEDeterminePermissionToAutomateTarget(&target, CORE_SUITE, GET_DATA, 0)
        };
        // SAFETY: 与 AECreateDesc 配对释放；失败也必须在同一条路径上释放。
        unsafe {
            AEDisposeDesc(&mut target);
        }
        status
    }

    /// 启动 System Events（agent，无窗口、发事件前本来也要由系统拉起）。
    /// 启动 app 不涉及 Apple Event，不会触发授权框。
    ///
    /// 只在 `-600`（目标没在跑）时调用；重复调用的闸门在 `recover_by_launching`。
    fn launch_system_events() {
        // `-g` 不把任何窗口提到前台；`open` 返回时 LaunchServices 已登记进程，
        // 紧接着的查询就能解析到它（实测无需额外等待）。
        let _ = std::process::Command::new("open")
            .args(["-g", "-b", "com.apple.systemevents"])
            .status();
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::{settings_anchor, SystemPermissions};

    pub fn detect() -> SystemPermissions {
        SystemPermissions {
            supported: false,
            disk_access: true,
            accessibility: true,
            screen_capture: true,
            automation: true,
        }
    }

    pub fn open(kind: &str) -> Result<(), String> {
        let _ = settings_anchor(kind).ok_or_else(|| format!("未知的授权类型：{kind}"))?;
        Err("系统授权只在 macOS 上可用".into())
    }
}

#[cfg(test)]
mod tests {
    use super::settings_anchor;

    #[test]
    fn anchors_cover_all_supported_kinds() {
        assert_eq!(settings_anchor("disk"), Some("Privacy_AllFiles"));
        assert_eq!(settings_anchor("accessibility"), Some("Privacy_Accessibility"));
        assert_eq!(settings_anchor("screenCapture"), Some("Privacy_ScreenCapture"));
        assert_eq!(settings_anchor("automation"), Some("Privacy_Automation"));
    }

    #[test]
    fn unknown_kind_is_rejected() {
        assert_eq!(settings_anchor("camera"), None);
        assert_eq!(settings_anchor(""), None);
    }

    /// FFI 边界冒烟：真实调用四项查询（无授权环境返回 false 是正常结果，**不许 panic**）。
    #[test]
    fn detect_reads_without_panicking() {
        let state = super::platform::detect();
        #[cfg(target_os = "macos")]
        assert!(state.supported);
        #[cfg(not(target_os = "macos"))]
        assert!(!state.supported);
    }

    /// 回归（2026-10-22 用户实测：系统设置里开关全开，面板仍显示未授权）：
    /// `AEDeterminePermissionToAutomateTarget` 按 bundle id 寻址要求目标进程在运行，
    /// System Events 由 launchd 按需拉起、平时不常驻，不在跑时返回 -600。
    /// `detect()` 必须在这一档先拉起它、再查一次——不能把 -600 当授权结论。
    ///
    /// 这里只验证机制（不再读到 -600），不断言具体的授权值：那取决于跑测试的可执行文件
    /// 自己的 TCC 身份（0 = 已允许 / -1743 = 已拒绝 / -1744 = 尚未询问，都是合法结果）。
    #[cfg(target_os = "macos")]
    #[test]
    fn automation_probe_does_not_confuse_missing_target_with_denial() {
        let _ = super::platform::detect();
        assert_ne!(super::platform::query_automation(), super::platform::PROC_NOT_FOUND);
    }
}
