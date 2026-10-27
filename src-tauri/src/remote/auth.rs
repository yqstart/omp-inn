//! 远程控制的认证原语：配对密钥、Cookie、Host/Origin/CSRF 校验、限流。
//!
//! 这些函数都刻意保持纯逻辑（输入 header / 字符串，输出决策），路由层只负责取
//! 值和回包——安全规则能单测，不靠集成测试才发现。

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

use axum::http::{header, HeaderMap};
use subtle::ConstantTimeEq;

/// 配对二维码有效期：够扫码 + 打开浏览器，又不至于让截图长期可用。
pub const PAIRING_TTL: Duration = Duration::from_secs(120);
/// 单 IP 配对尝试频率。
pub const PAIR_MAX_PER_WINDOW: usize = 5;
pub const PAIR_WINDOW: Duration = Duration::from_secs(60);
/// 单设备 RPC 频率（粗粒度，防脚本刷；正常手机远低于这个数）。
pub const RPC_MAX_PER_WINDOW: usize = 300;
pub const RPC_WINDOW: Duration = Duration::from_secs(60);

pub const COOKIE_NAME: &str = "omp_remote";

#[derive(Debug, Clone)]
pub struct Pairing {
    pub secret: String,
    pub expires: Instant,
    pub used: bool,
}

impl Pairing {
    pub fn new(secret: String) -> Self {
        let now = Instant::now();
        Self { secret, expires: now + PAIRING_TTL, used: false }
    }

    pub fn remaining_secs(&self) -> u64 {
        self.expires.saturating_duration_since(Instant::now()).as_secs()
    }

    pub fn is_active(&self) -> bool {
        !self.used && Instant::now() < self.expires
    }

    /// 先判过期/已用再比密钥；比较走常量时间。
    pub fn verify(&self, input: &str) -> bool {
        if !self.is_active() {
            return false;
        }
        input.as_bytes().ct_eq(self.secret.as_bytes()).into()
    }

    pub fn consume(&mut self) {
        self.used = true;
    }
}

/// 小型滑动窗口限流（单机、单用户；不需要引入限流中间件）。
pub struct RateLimiter {
    hits: HashMap<String, VecDeque<Instant>>,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self { hits: HashMap::new() }
    }
}

impl RateLimiter {
    pub fn allow(&mut self, key: &str, max: usize, window: Duration) -> bool {
        let now = Instant::now();
        // 先清长期不用的 key，避免 LAN 扫描把表撑大（必须在 entry 借用之前做）。
        if self.hits.len() > 512 {
            self.hits.retain(|_, v| v.back().is_some_and(|t| now.duration_since(*t) < window));
        }
        let q = self.hits.entry(key.to_string()).or_default();
        while let Some(t) = q.front() {
            if now.duration_since(*t) > window {
                q.pop_front();
            } else {
                break;
            }
        }
        if q.len() >= max {
            return false;
        }
        q.push_back(now);
        true
    }
}

/// 取 Cookie 里的设备令牌（只认名字完全匹配的键）。
pub fn cookie_token(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let part = part.trim();
        let Some((k, v)) = part.split_once('=') else { continue };
        if k.trim() == COOKIE_NAME && !v.trim().is_empty() {
            return Some(v.trim().to_string());
        }
    }
    None
}

/// 令牌也可以走 Bearer（curl / 调试用）；浏览器仍用 HttpOnly Cookie。
pub fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let rest = raw.strip_prefix("Bearer ").or_else(|| raw.strip_prefix("bearer "))?;
    let t = rest.trim();
    (!t.is_empty()).then(|| t.to_string())
}

pub fn request_token(headers: &HeaderMap) -> Option<String> {
    cookie_token(headers).or_else(|| bearer_token(headers))
}

/// Host 允许列表：本机 / 私网 / 链路本地 / CGNAT（Tailscale）IPv4，以及启用 Serve 时的 `*.ts.net`。
///
/// 这是防 DNS rebinding 的关键：恶意域名解析到 127.0.0.1 时，Host 是攻击者域名，
/// 直接拒绝；只靠 Cookie 同源策略并不够。
pub fn host_allowed(host_header: Option<&str>, allow_tailscale: bool) -> bool {
    let Some(raw) = host_header else { return false };
    let host = strip_port(raw.trim());
    if host.is_empty() {
        return false;
    }
    if host.eq_ignore_ascii_case("localhost") || host == "::1" {
        return true;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => {
                v4.is_loopback() || v4.is_private() || v4.is_link_local() || is_cgnat(v4)
            }
            IpAddr::V6(v6) => v6.is_loopback(),
        };
    }
    if allow_tailscale {
        let h = host.trim_end_matches('.').to_ascii_lowercase();
        if h.ends_with(".ts.net") {
            return true;
        }
    }
    false
}

fn is_cgnat(ip: std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 100 && (64..=127).contains(&o[1])
}

/// 去掉 Host 的端口（IPv6 的 `[::1]:43110` 也处理）。
pub fn strip_port(host: &str) -> &str {
    let h = host.trim();
    if let Some(rest) = h.strip_prefix('[') {
        return rest.split(']').next().unwrap_or(rest);
    }
    match h.rsplit_once(':') {
        // 只有一个冒号才当端口；裸 IPv6 不在这里出现（浏览器会给方括号）
        Some((head, tail)) if !head.contains(':') && tail.chars().all(|c| c.is_ascii_digit()) => head,
        _ => h,
    }
}

/// Origin 必须与请求 Host 同主机（协议可不同：Tailscale 代理内部是 http，外部是 https）。
pub fn origin_matches(origin: Option<&str>, host_header: Option<&str>) -> bool {
    let Some(origin) = origin else {
        // 非浏览器客户端（curl）可以没有 Origin；有 Cookie + 自定义头仍然安全。
        return true;
    };
    if origin.is_empty() || origin == "null" {
        return false;
    }
    let Some((_, rest)) = origin.split_once("://") else { return false };
    let origin_host = rest.split('/').next().unwrap_or(rest);
    match host_header {
        Some(h) => strip_port(origin_host).eq_ignore_ascii_case(strip_port(h)),
        None => false,
    }
}

/// 客户端地址（用于限流 / 审计展示）：优先 TCP peer，反代场景不信任 XFF。
pub fn client_ip(peer: SocketAddr) -> String {
    peer.ip().to_string()
}

/// HTTPS 判定：只有 TCP peer 是 loopback（Tailscale Serve 在本机）时才信 `X-Forwarded-Proto`。
pub fn is_secure(headers: &HeaderMap, peer: SocketAddr) -> bool {
    if peer.ip().is_loopback() {
        if let Some(proto) = headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()) {
            return proto.eq_ignore_ascii_case("https");
        }
    }
    false
}

/// 远程请求的 CSRF 门槛：自定义头 + JSON Content-Type（跨站表单无法伪造）。
pub fn csrf_ok(headers: &HeaderMap) -> bool {
    let custom = headers
        .get("x-omp-remote")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == "1");
    let json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(';').next().is_some_and(|m| m.trim().eq_ignore_ascii_case("application/json")));
    custom && json
}

pub fn sanitize_device_name(name: &str) -> String {
    let s: String = name
        .chars()
        .filter(|c| !c.is_control())
        .take(64)
        .collect::<String>()
        .trim()
        .to_string();
    if s.is_empty() {
        "手机".into()
    } else {
        s
    }
}

pub fn set_cookie(token: &str, secure: bool) -> String {
    let mut s = format!(
        "{COOKIE_NAME}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000"
    );
    if secure {
        s.push_str("; Secure");
    }
    s
}

pub fn clear_cookie(secure: bool) -> String {
    let mut s = format!("{COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    if secure {
        s.push_str("; Secure");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn pairing_is_single_use_and_expires() {
        let mut p = Pairing::new("secret".into());
        assert!(p.verify("secret"));
        assert!(!p.verify("other"));
        p.consume();
        assert!(!p.verify("secret"));
        let mut expired = Pairing::new("x".into());
        expired.expires = Instant::now() - Duration::from_secs(1);
        assert!(!expired.verify("x"));
    }

    #[test]
    fn host_rules_reject_public_and_accept_private() {
        assert!(host_allowed(Some("127.0.0.1:43110"), false));
        assert!(host_allowed(Some("192.168.1.5:43110"), false));
        assert!(host_allowed(Some("[::1]:43110"), false));
        assert!(host_allowed(Some("100.101.102.103:43110"), false));
        assert!(!host_allowed(Some("evil.example:43110"), false));
        assert!(!host_allowed(Some("8.8.8.8:43110"), false));
        assert!(!host_allowed(None, false));
        assert!(host_allowed(Some("mac.tailnet.ts.net:8443"), true));
        assert!(!host_allowed(Some("mac.tailnet.ts.net:8443"), false));
    }

    #[test]
    fn origin_must_match_host() {
        assert!(origin_matches(None, Some("192.168.1.5:43110")));
        assert!(origin_matches(Some("http://192.168.1.5:43110"), Some("192.168.1.5:43110")));
        assert!(origin_matches(Some("https://mac.tailnet.ts.net:8443"), Some("mac.tailnet.ts.net:8443")));
        assert!(!origin_matches(Some("http://evil.example"), Some("192.168.1.5:43110")));
        assert!(!origin_matches(Some("null"), Some("192.168.1.5:43110")));
    }

    #[test]
    fn csrf_needs_header_and_json() {
        let mut h = HeaderMap::new();
        h.insert("x-omp-remote", HeaderValue::from_static("1"));
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
        assert!(csrf_ok(&h));
        h.remove(header::CONTENT_TYPE);
        assert!(!csrf_ok(&h));
    }

    #[test]
    fn cookie_parser_only_takes_our_name() {
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, HeaderValue::from_static("a=1; omp_remote=abc; b=2"));
        assert_eq!(cookie_token(&h).as_deref(), Some("abc"));
        h.insert(header::COOKIE, HeaderValue::from_static("omp_remote_x=abc"));
        assert!(cookie_token(&h).is_none());
    }

    #[test]
    fn rate_limiter_blocks_after_max() {
        let mut r = RateLimiter::default();
        for _ in 0..3 {
            assert!(r.allow("ip", 3, Duration::from_secs(60)));
        }
        assert!(!r.allow("ip", 3, Duration::from_secs(60)));
    }

    #[test]
    fn sanitize_name_strips_controls_and_caps() {
        assert_eq!(sanitize_device_name("  iPhone\n"), "iPhone");
        assert_eq!(sanitize_device_name(""), "手机");
        assert_eq!(sanitize_device_name(&"a".repeat(100)).len(), 64);
    }
}
