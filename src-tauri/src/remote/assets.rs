//! 手机 PWA 的静态资源服务。
//!
//! 生产：走 Tauri 的 `asset_resolver`（与桌面同一份 `dist`，`mobile.html` 由 Vite
//! 多入口构建进去）。开发：如果 `dist` 还没有移动端产物，可反代 Vite dev server。
//!
//! **路径必须净化**：Tauri dev 的 asset_resolver 会把相对路径直接 join 到 `dist`，
//! 不拦 `..` 就能读到 `dist` 之外的文件（例如 `../tauri.conf.json`）。这里只放行
//! 常规路径组件，且拒绝 `%`（不做二次解码，宁可 404）。

use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::extract::State;

use super::server::Ctx;

pub async fn static_handler(State(ctx): State<Ctx>, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let Some(path) = safe_path(path) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    match load(&ctx, &path).await {
        Some(asset) => respond(&path, asset.0, asset.1),
        None => {
            let msg = if path.ends_with(".html") || path == "mobile.html" {
                "移动端页面还没有构建：请在仓库根目录运行 `pnpm build`。"
            } else {
                "not found"
            };
            (StatusCode::NOT_FOUND, msg).into_response()
        }
    }
}

async fn load(ctx: &Ctx, path: &str) -> Option<(Vec<u8>, String)> {
    let asset_path = if path.is_empty() { "mobile.html" } else { path };
    if let Some(asset) = ctx.app.asset_resolver().get(asset_path.to_string()) {
        return Some((asset.bytes, asset.mime_type));
    }
    #[cfg(debug_assertions)]
    {
        // 开发模式：Vite dev server 里有最新的 mobile.html / 源码模块。
        if let Some((bytes, mime)) = dev_proxy(asset_path).await {
            return Some((bytes, mime));
        }
    }
    let _ = ctx;
    None
}

#[cfg(debug_assertions)]
async fn dev_proxy(path: &str) -> Option<(Vec<u8>, String)> {
    let url = format!("http://127.0.0.1:1420/{path}");
    let res = reqwest::Client::new()
        .get(url)
        .timeout(std::time::Duration::from_millis(1500))
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let mime = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = res.bytes().await.ok()?.to_vec();
    Some((bytes, mime))
}

fn respond(path: &str, bytes: Vec<u8>, mime: String) -> Response {
    // Tauri 的 MIME 表不一定认识 webmanifest；浏览器要 application/manifest+json 才认 manifest。
    let mime = if path.ends_with(".webmanifest") {
        "application/manifest+json".to_string()
    } else {
        mime
    };
    let is_html = path.ends_with(".html") || path.is_empty() || mime.starts_with("text/html");
    let cache = if is_html {
        "no-store"
    } else if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut b = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, HeaderValue::from_str(&mime).unwrap_or(HeaderValue::from_static("application/octet-stream")))
        .header(header::CACHE_CONTROL, cache)
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .header("x-frame-options", "DENY")
        .header("permissions-policy", "camera=(self), microphone=(), geolocation=()");
    if is_html {
        b = b.header("content-security-policy", csp());
    }
    b.body(Body::from(bytes)).unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn csp() -> String {
    #[cfg(debug_assertions)]
    {
        // Vite dev 会注入内联 preamble；生产不放宽。
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' ws: wss: http://127.0.0.1:1420 ws://127.0.0.1:1420; font-src 'self' data:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'".into()
    }
    #[cfg(not(debug_assertions))]
    {
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' ws: wss:; font-src 'self' data:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'".into()
    }
}

/// 只允许常规路径组件；空串（根）映射到 mobile.html。
pub fn safe_path(path: &str) -> Option<String> {
    if path.is_empty() {
        return Some("mobile.html".into());
    }
    if path.starts_with('/') || path.contains('\\') || path.contains('\0') || path.contains('%') {
        return None;
    }
    let mut parts: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return None;
        }
        parts.push(seg);
    }
    if parts.is_empty() {
        return Some("mobile.html".into());
    }
    Some(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        assert_eq!(safe_path("").as_deref(), Some("mobile.html"));
        assert_eq!(safe_path("mobile.html").as_deref(), Some("mobile.html"));
        assert_eq!(safe_path("assets/a.js").as_deref(), Some("assets/a.js"));
        assert!(safe_path("../tauri.conf.json").is_none());
        assert!(safe_path("assets/../../x").is_none());
        assert!(safe_path("/etc/passwd").is_none());
        assert!(safe_path("..%2f..%2fx").is_none());
        assert!(safe_path("a\\b").is_none());
    }
}
