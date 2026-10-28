//! 远程服务的 HTTP 路由与 WebSocket。
//!
//! 认证顺序：Host（防 DNS rebinding）→ Origin（防跨站）→ CSRF 自定义头 →
//! Cookie → 限流。静态资源不需要 Cookie（手机还没配对时也要能加载 PWA），
//! 但 API 一律要；配对是唯一的无认证写入口，靠一次性 secret。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, State};
use axum::extract::Request;
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tower_http::compression::CompressionLayer;
use tower_http::limit::RequestBodyLimitLayer;

use super::auth;
use super::store::DeviceView;
use super::bus::RemoteEvent;
use super::{PairError, RemoteManager};

pub const MAX_BODY: usize = 16 * 1024 * 1024;

#[derive(Clone)]
pub struct Ctx {
    pub app: AppHandle,
    pub manager: RemoteManager,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub sessions: Vec<crate::commands::SessionView>,
    pub total_files: usize,
    pub scanned_files: usize,
    pub statuses: HashMap<String, String>,
    pub pending: HashMap<String, usize>,
}

#[derive(Debug, Deserialize)]
struct PairReq {
    secret: String,
    #[serde(default)]
    name: String,
}

#[derive(Debug, Deserialize)]
struct RpcReq {
    cmd: String,
    #[serde(default)]
    args: Value,
}

pub fn router(ctx: Ctx) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/api/v1/me", get(me))
        .route("/api/v1/pair", post(pair))
        .route("/api/v1/logout", post(logout))
        .route("/api/v1/overview", get(overview))
        .route("/api/v1/pending", get(pending))
        .route("/api/v1/rpc", post(rpc))
        .route("/api/v1/events", get(ws))
        .fallback(super::assets::static_handler)
        .layer(axum::middleware::from_fn_with_state(ctx.clone(), guard))
        .layer(RequestBodyLimitLayer::new(MAX_BODY))
        .layer(CompressionLayer::new())
        .with_state(ctx)
}

async fn guard(
    State(ctx): State<Ctx>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    mut req: Request,
    next: Next,
) -> Response {
    let path = req.uri().path().to_string();
    let method_is_post = req.method() == axum::http::Method::POST;

    let allow_ts = ctx.manager.tailscale_url().is_some();
    // HTTP/2 没有 Host 头，权威信息在 URI 的 authority 里；两路都看，Tailscale 的
    // HTTPS（h2）与局域网（h1）才能一致通过 Host 允许列表。
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| req.uri().authority().map(|a| a.to_string()));
    if !auth::host_allowed(host.as_deref(), allow_ts) {
        return api_error(StatusCode::MISDIRECTED_REQUEST, "BAD_HOST", "请求的 Host 不在允许列表里");
    }
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if !auth::origin_matches(origin.as_deref(), host.as_deref()) {
        return api_error(StatusCode::FORBIDDEN, "BAD_ORIGIN", "请求来源与 Host 不一致");
    }

    if path.starts_with("/api/") {
        if method_is_post && !auth::csrf_ok(req.headers()) {
            return api_error(StatusCode::FORBIDDEN, "CSRF", "缺少远程请求头或 Content-Type 不是 application/json");
        }
        if path != "/api/v1/pair" && path != "/api/v1/login" {
            let Some(token) = auth::request_token(req.headers()) else {
                return api_error(StatusCode::UNAUTHORIZED, "UNAUTHORIZED", "未配对或设备已被撤销");
            };
            let ip = auth::client_ip(peer);
            let Some(device) = ctx.manager.authenticate(&token, Some(&ip)) else {
                return api_error(StatusCode::UNAUTHORIZED, "UNAUTHORIZED", "未配对或设备已被撤销");
            };
            if path == "/api/v1/rpc" && !ctx.manager.allow_rpc(&device.id) {
                return api_error(StatusCode::TOO_MANY_REQUESTS, "RATE_LIMIT", "请求过于频繁");
            }
            let secure = auth::is_secure(req.headers(), peer);
            req.extensions_mut().insert(AuthDevice { device, secure, token });
        }
    }

    let mut res = next.run(req).await;
    if path.starts_with("/api/") {
        res.headers_mut().insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    }
    res.headers_mut().insert("x-content-type-options", "nosniff".parse().unwrap());
    res
}

#[derive(Clone)]
pub struct AuthDevice {
    pub device: DeviceView,
    pub secure: bool,
    token: String,
}

async fn healthz() -> Json<Value> {
    Json(json!({"ok": true}))
}

async fn me(Extension(a): Extension<AuthDevice>) -> Json<Value> {
    Json(json!({"device": a.device, "protocol": 1}))
}

async fn pair(
    State(ctx): State<Ctx>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<PairReq>,
) -> Response {
    let ip = auth::client_ip(peer);
    if !ctx.manager.allow_pair(&ip) {
        return api_error(StatusCode::TOO_MANY_REQUESTS, "PAIR_RATE_LIMIT", "配对尝试过于频繁，请稍后再试");
    }
    let existing = auth::request_token(&headers).and_then(|t| ctx.manager.device_id_for_token(&t));
    let name = if body.name.trim().is_empty() {
        "手机".to_string()
    } else {
        auth::sanitize_device_name(&body.name)
    };
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.chars().take(200).collect::<String>());
    match ctx.manager.pair(&body.secret, &name, Some(&ip), ua.as_deref(), existing.as_deref()) {
        Ok((token, device)) => {
            let secure = auth::is_secure(&headers, peer);
            let cookie = auth::set_cookie(&token, secure);
            let mut res = Json(json!({"device": device, "protocol": 1})).into_response();
            if let Ok(v) = cookie.parse() {
                res.headers_mut().insert(header::SET_COOKIE, v);
            }
            ctx.manager.emit_state(&ctx.app);
            res
        }
        Err(PairError::Expired) => api_error(StatusCode::GONE, "PAIRING_EXPIRED", "二维码已过期，请在电脑上重新生成"),
        Err(PairError::Used) => api_error(StatusCode::GONE, "PAIRING_USED", "二维码已被使用，请在电脑上重新生成"),
        Err(PairError::BadSecret) => api_error(StatusCode::FORBIDDEN, "PAIRING_BAD", "配对密钥不正确"),
        Err(PairError::Storage) => api_error(StatusCode::INTERNAL_SERVER_ERROR, "PAIRING_STORAGE", "保存设备失败，请检查电脑上的存储后重新配对"),
    }
}

async fn logout(State(ctx): State<Ctx>, Extension(a): Extension<AuthDevice>) -> Response {
    let result = ctx.manager.revoke_device(&a.device.id);
    let mut res = match result {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(_) => api_error(StatusCode::INTERNAL_SERVER_ERROR, "REMOTE_STORAGE", "本次运行已退出，但保存失败，重启后设备可能恢复；请在电脑上重试撤销"),
    };
    if let Ok(v) = auth::clear_cookie(a.secure).parse() {
        res.headers_mut().insert(header::SET_COOKIE, v);
    }
    ctx.manager.hub().revoke_device(&a.device.id);
    ctx.manager.emit_state(&ctx.app);
    res
}

#[derive(Debug, Deserialize)]
struct OverviewQuery {
    limit: Option<usize>,
}

async fn overview(
    Extension(_a): Extension<AuthDevice>,
    State(ctx): State<Ctx>,
    Query(q): Query<OverviewQuery>,
) -> Response {
    let limit = q.limit.unwrap_or(200).clamp(1, 500);
    let state = ctx.app.state::<crate::commands::AppState>();
    let page = match crate::commands::list_sessions(state.clone(), None, Some(limit), Some(0)).await {
        Ok(p) => p,
        Err(e) => return cmd_error(e),
    };
    let mut statuses = HashMap::new();
    {
        let rt = state.runtime.lock().await;
        for (sid, r) in rt.iter() {
            statuses.insert(sid.clone(), crate::runtime::activity_state_label(r.activity.state()).to_string());
        }
    }
    let pending = ctx.manager.hub().pending_counts();
    Json(Overview {
        sessions: page.sessions,
        total_files: page.total_files,
        scanned_files: page.scanned_files,
        statuses,
        pending,
    })
    .into_response()
}

#[derive(Debug, Deserialize)]
struct PendingQuery {
    sid: String,
}

async fn pending(
    Extension(_a): Extension<AuthDevice>,
    State(ctx): State<Ctx>,
    Query(q): Query<PendingQuery>,
) -> Response {
    if !super::rpc::is_full_uuid(&q.sid) {
        return api_error(StatusCode::BAD_REQUEST, "BAD_ARG", "会话 id 必须是完整 uuid");
    }
    Json(json!({"frames": ctx.manager.hub().pending_for(&q.sid)})).into_response()
}

async fn rpc(
    Extension(_a): Extension<AuthDevice>,
    State(ctx): State<Ctx>,
    Json(req): Json<RpcReq>,
) -> Response {
    let pending = if req.cmd == "approve" || req.cmd == "respond_ui" {
        match (
            req.args.get("id").and_then(|v| v.as_str()).map(str::to_string),
            req.args.get("uiId").and_then(|v| v.as_str()).map(str::to_string),
        ) {
            (Some(sid), Some(ui)) => Some((sid, ui)),
            _ => None,
        }
    } else {
        None
    };
    let fut = super::rpc::dispatch(&ctx, &req.cmd, req.args);
    let out = match tokio::time::timeout(Duration::from_secs(65), fut).await {
        Ok(v) => v,
        Err(_) => return api_error(StatusCode::GATEWAY_TIMEOUT, "REMOTE_TIMEOUT", "命令执行超时"),
    };
    match out {
        Ok(result) => {
            if let Some((sid, ui_id)) = pending {
                ctx.manager.hub().clear_pending(&sid, &ui_id);
            }
            Json(json!({"ok": true, "result": result})).into_response()
        }
        Err(e) => cmd_error(e),
    }
}

fn cmd_error(e: crate::commands::CmdError) -> Response {
    let status = match e.code.as_str() {
        "BAD_ARG" | "PAIRING_BAD" => StatusCode::BAD_REQUEST,
        "REMOTE_FORBIDDEN" => StatusCode::FORBIDDEN,
        "NOT_FOUND" => StatusCode::NOT_FOUND,
        _ => StatusCode::BAD_REQUEST,
    };
    (status, Json(json!({"ok": false, "code": e.code, "message": e.message, "hint": e.hint}))).into_response()
}

fn api_error(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({"ok": false, "code": code, "message": message, "hint": null}))).into_response()
}

async fn ws(
    State(ctx): State<Ctx>,
    Extension(a): Extension<AuthDevice>,
    ws: WebSocketUpgrade,
) -> Response {
    // 单机服务，连接数上限按全局算（手机 + 平板 + 调试页足够）；超限直接拒绝升级。
    if ctx.manager.hub().client_count() >= 32 {
        return api_error(StatusCode::TOO_MANY_REQUESTS, "WS_LIMIT", "并发连接过多");
    }
    ws.on_upgrade(move |socket| handle_socket(ctx, a, socket))
}

async fn handle_socket(ctx: Ctx, a: AuthDevice, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let hub = ctx.manager.hub();
    hub.client_connected();
    ctx.manager.emit_state(&ctx.app);
    let mut events = hub.subscribe();
    let mut revokes = hub.revocations();
    let mut shutdown = hub.shutdown_rx();
    // 订阅后复核令牌，防止认证通过后、订阅之前发生撤销或令牌轮换。
    if ctx.manager.device_id_for_token(&a.token).as_deref() != Some(a.device.id.as_str()) {
        let _ = sink.send(Message::Close(Some(CloseFrame { code: 4401, reason: "revoked".into() }))).await;
        hub.client_disconnected();
        ctx.manager.emit_state(&ctx.app);
        return;
    }
    let hello = json!({"channel": "remote://hello", "payload": {"protocol": 1, "device": a.device}});
    let _ = sink.send(Message::Text(hello.to_string().into())).await;
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    loop {
        tokio::select! {
            _ = ping.tick() => {
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
            }
            ev = events.recv() => {
                match ev {
                    Ok(RemoteEvent { seq, channel, payload }) => {
                        if ctx.manager.device_id_for_token(&a.token).as_deref() != Some(a.device.id.as_str()) {
                            let _ = sink.send(Message::Close(Some(CloseFrame { code: 4401, reason: "revoked".into() }))).await;
                            break;
                        }
                        let msg = json!({"seq": seq, "channel": channel, "payload": payload});
                        if sink.send(Message::Text(msg.to_string().into())).await.is_err() { break; }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let _ = sink.send(Message::Text(json!({"channel":"remote://lagged","payload":{}}).to_string().into())).await;
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            id = revokes.recv() => {
                match id {
                    Ok(id) if id == a.device.id => {
                        let _ = sink.send(Message::Close(Some(CloseFrame { code: 4401, reason: "revoked".into() }))).await;
                        break;
                    }
                    Err(_) => break,
                    _ => {}
                }
            }
            _ = shutdown.recv() => break,
            msg = stream.next() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
    hub.client_disconnected();
    ctx.manager.emit_state(&ctx.app);
    let _ = sink.close().await;
}
