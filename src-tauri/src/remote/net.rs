//! 网络地址与 Tailscale 探测。
//!
//! 地址只用于「给手机一个能拨的 URL」：局域网优先私网 IPv4，过滤 docker / VPN 之类的
//! 虚拟网卡；Tailscale 的 100.64/10 单独列。Tailscale Serve 走 CLI，失败一律降级成
//! 可读错误，不影响局域网模式。

use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAddress {
    pub url: String,
    pub label: String,
    /// `lan` / `tailscale` / `local`
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleInfo {
    pub installed: bool,
    /// `Running` / `Stopped` / `NeedsLogin` …（上游 BackendState 原样）
    pub backend_state: Option<String>,
    pub dns_name: Option<String>,
    pub ipv4: Option<String>,
    pub error: Option<String>,
}

/// 局域网地址候选：按“像真实网卡”的程度排序，去重。
pub fn lan_addresses(port: u16) -> Vec<RemoteAddress> {
    let mut out: Vec<(u8, String, String)> = Vec::new();
    let Ok(ifaces) = if_addrs::get_if_addrs() else { return Vec::new() };
    for iface in ifaces {
        let ip = match iface.addr {
            if_addrs::IfAddr::V4(v4) => v4.ip,
            _ => continue,
        };
        if ip.is_loopback() || ip.is_link_local() || is_cgnat(ip) {
            continue;
        }
        let name = iface.name;
        let lower = name.to_ascii_lowercase();
        if lower.starts_with("utun")
            || lower.starts_with("tun")
            || lower.starts_with("tap")
            || lower.contains("docker")
            || lower.contains("bridge")
            || lower.contains("vmnet")
            || lower.contains("vbox")
            || lower.contains("tailscale")
        {
            continue;
        }
        let score = if lower.starts_with("en") || lower.contains("wlan") || lower.contains("wi-fi") || lower.contains("eth") {
            0
        } else if ip.is_private() {
            1
        } else {
            2
        };
        if !ip.is_private() {
            continue;
        }
        out.push((score, name, format!("http://{ip}:{port}/")));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    out.dedup_by(|a, b| a.2 == b.2);
    out.into_iter()
        .map(|(_, name, url)| RemoteAddress { url, label: format!("局域网 · {name}"), kind: "lan".into() })
        .collect()
}

pub fn local_address(port: u16) -> RemoteAddress {
    RemoteAddress {
        url: format!("http://127.0.0.1:{port}/"),
        label: "本机".into(),
        kind: "local".into(),
    }
}

pub fn tailscale_address(ip: &str, port: u16) -> RemoteAddress {
    RemoteAddress {
        url: format!("http://{ip}:{port}/"),
        label: "Tailscale IP（需手机已加入 tailnet）".into(),
        kind: "tailscale".into(),
    }
}

fn is_cgnat(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 100 && (64..=127).contains(&o[1])
}

/// Tailscale CLI 的常见落点（GUI 进程 PATH 很贫瘠，不能只靠 `which`）。
pub fn tailscale_bin() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join(if cfg!(windows) { "tailscale.exe" } else { "tailscale" }));
        }
    }
    #[cfg(target_os = "macos")]
    candidates.push(PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale"));
    #[cfg(target_os = "macos")]
    candidates.push(PathBuf::from("/opt/homebrew/bin/tailscale"));
    #[cfg(target_os = "macos")]
    candidates.push(PathBuf::from("/usr/local/bin/tailscale"));
    #[cfg(target_os = "windows")]
    if let Ok(pf) = std::env::var("ProgramFiles") {
        candidates.push(PathBuf::from(pf).join("Tailscale").join("tailscale.exe"));
    }
    #[cfg(target_os = "linux")]
    candidates.push(PathBuf::from("/usr/bin/tailscale"));
    candidates.into_iter().find(|p| p.is_file())
}

/// `tailscale status --json` 的最小解析（只取展示/配对需要的字段）。
pub fn parse_status(raw: &str) -> TailscaleInfo {
    let v: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => {
            return TailscaleInfo { installed: true, error: Some(format!("解析 Tailscale 状态失败：{e}")), ..Default::default() };
        }
    };
    let backend = v.get("BackendState").and_then(|x| x.as_str()).map(str::to_string);
    let dns = v
        .get("Self")
        .and_then(|s| s.get("DNSName"))
        .and_then(|x| x.as_str())
        .map(|s| s.trim_end_matches('.').to_string())
        .filter(|s| !s.is_empty());
    let ipv4 = v
        .get("Self")
        .and_then(|s| s.get("TailscaleIPs"))
        .and_then(|x| x.as_array())
        .and_then(|arr| arr.iter().filter_map(|x| x.as_str()).find(|s| s.parse::<Ipv4Addr>().is_ok()))
        .map(str::to_string);
    TailscaleInfo { installed: true, backend_state: backend, dns_name: dns, ipv4, error: None }
}

pub async fn detect() -> TailscaleInfo {
    let Some(bin) = tailscale_bin() else {
        return TailscaleInfo { installed: false, ..Default::default() };
    };
    let fut = tokio::process::Command::new(&bin).args(["status", "--json"]).output();
    match tokio::time::timeout(Duration::from_secs(4), fut).await {
        Ok(Ok(out)) if out.status.success() => {
            let mut info = parse_status(&String::from_utf8_lossy(&out.stdout));
            info.installed = true;
            info
        }
        Ok(Ok(out)) => TailscaleInfo {
            installed: true,
            error: Some(format!(
                "tailscale status 失败：{}",
                String::from_utf8_lossy(&out.stderr).trim()
            )),
            ..Default::default()
        },
        Ok(Err(e)) => TailscaleInfo { installed: true, error: Some(format!("无法执行 tailscale：{e}")), ..Default::default() },
        Err(_) => TailscaleInfo { installed: true, error: Some("tailscale status 超时".into()), ..Default::default() },
    }
}

/// 开一个后台 Serve：返回可访问的 HTTPS URL。
pub async fn serve_on(dns_name: &str, local_port: u16, https_port: u16) -> Result<String, String> {
    let bin = tailscale_bin().ok_or("未找到 tailscale 命令（请先安装 Tailscale）")?;
    let target = format!("http://127.0.0.1:{local_port}");
    let arg = format!("--https={https_port}");
    let fut = tokio::process::Command::new(&bin)
        .args(["serve", "--bg", &arg, &target])
        .output();
    let out = tokio::time::timeout(Duration::from_secs(15), fut)
        .await
        .map_err(|_| "tailscale serve 超时（可能需要先在 tailnet 开启 HTTPS）".to_string())?
        .map_err(|e| format!("无法执行 tailscale serve：{e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("tailscale serve 失败：{}", err.trim()));
    }
    Ok(format!("https://{}:{}/", dns_name.trim_end_matches('.'), https_port))
}

pub async fn serve_off(https_port: u16) -> Result<(), String> {
    let Some(bin) = tailscale_bin() else { return Ok(()) };
    let arg = format!("--https={https_port}");
    let out = tokio::process::Command::new(&bin)
        .args(["serve", &arg, "off"])
        .output()
        .await
        .map_err(|e| format!("无法执行 tailscale serve off：{e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// 退出路径专用：进程马上结束，不等待 async runtime；尽力关掉 Serve。
pub fn serve_off_sync(https_port: u16) {
    let Some(bin) = tailscale_bin() else { return };
    let arg = format!("--https={https_port}");
    let Ok(mut child) = std::process::Command::new(bin)
        .args(["serve", &arg, "off"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return;
    };
    // 退出路径最多等 2s；tailscale 卡住也不许把应用退出拖死。
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_status_extracts_dns_and_ip() {
        let raw = r#"{
          "BackendState": "Running",
          "Self": {
            "DNSName": "mac.tailnet.ts.net.",
            "TailscaleIPs": ["100.101.102.103", "fd7a::1"]
          }
        }"#;
        let info = parse_status(raw);
        assert_eq!(info.backend_state.as_deref(), Some("Running"));
        assert_eq!(info.dns_name.as_deref(), Some("mac.tailnet.ts.net"));
        assert_eq!(info.ipv4.as_deref(), Some("100.101.102.103"));
    }

    #[test]
    fn parse_bad_json_reports_error() {
        let info = parse_status("nope");
        assert!(info.error.is_some());
    }

    #[test]
    fn cgnat_detection() {
        assert!(is_cgnat("100.100.1.1".parse().unwrap()));
        assert!(!is_cgnat("100.200.1.1".parse().unwrap()));
        assert!(!is_cgnat("192.168.1.1".parse().unwrap()));
    }
}
