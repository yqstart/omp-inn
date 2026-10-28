//! 手机远程控制（V50）：内嵌 HTTP/WS 服务 + 扫码配对 + 设备管理。
//!
//! 设计口径：
//! - 桌面端单进程内起 axum，不引入 sidecar；手机端是浏览器 PWA。
//! - 默认关闭；每次启动都不自动开（安全优先）。端口 / 访问方式 / 设备可持久化。
//! - 手机只能调用 [`rpc`] 的白名单命令；文件 / 终端 / 设置 / git 一律不可达。
//! - 配对是 256-bit 一次性 secret + HttpOnly 设备 Cookie；设备可撤销。
//! - 事件经 [`bus::Hub`] 镜像给 WebSocket；审批帧离线也缓存，重连可处理。

pub mod assets;
pub mod auth;
pub mod bus;
pub mod net;
pub mod rpc;
pub mod server;
pub mod store;

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Instant;

use qrcode::QrCode;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::net::TcpListener;
use tokio::sync::{watch, Mutex};

use auth::{Pairing, RateLimiter};
use bus::Hub;
use store::{DeviceView, RemotePrefs, Store};

pub const REMOTE_STATE_EVENT: &str = "remote://state";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAddress {
    pub url: String,
    pub label: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleView {
    pub installed: bool,
    pub backend_state: Option<String>,
    pub dns_name: Option<String>,
    pub ipv4: Option<String>,
    pub https_url: Option<String>,
    pub serve_enabled: bool,
    pub error: Option<String>,
}

impl TailscaleView {
    fn from_info(info: net::TailscaleInfo) -> Self {
        Self {
            installed: info.installed,
            backend_state: info.backend_state,
            dns_name: info.dns_name,
            ipv4: info.ipv4,
            https_url: None,
            serve_enabled: false,
            error: info.error,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub running: bool,
    pub access: String,
    pub port: u16,
    pub addresses: Vec<RemoteAddress>,
    pub pairing_active: bool,
    pub pairing_expires_in: u64,
    pub devices: Vec<DeviceView>,
    pub devices_save_pending: bool,
    pub connections: usize,
    pub tailscale: TailscaleView,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    pub url: String,
    pub svg: String,
    pub expires_in: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairError {
    Expired,
    Used,
    BadSecret,
    Storage,
}

struct RunningServer {
    generation: u64,
    port: u16,
    shutdown: watch::Sender<bool>,
    task: tauri::async_runtime::JoinHandle<()>,
}

struct Inner {
    store: StdMutex<Store>,
    hub: Arc<Hub>,
    running: Mutex<Option<RunningServer>>,
    pairing: StdMutex<Option<Pairing>>,
    pair_limit: StdMutex<RateLimiter>,
    rpc_limit: StdMutex<RateLimiter>,
    tailscale: StdMutex<TailscaleView>,
    ts_checked: StdMutex<Option<Instant>>,
    running_flag: AtomicBool,
    generation: AtomicU64,
    last_error: StdMutex<Option<String>>,
}

#[derive(Clone)]
pub struct RemoteManager {
    inner: Arc<Inner>,
}

impl RemoteManager {
    pub fn new(app: &AppHandle) -> Self {
        let dir = app
            .path()
            .app_data_dir()
            .map(|p| p.join("omp-inn"))
            .unwrap_or_else(|_| std::env::temp_dir().join("omp-inn"));
        let _ = std::fs::create_dir_all(&dir);
        let store = Store::load(&dir);
        Self {
            inner: Arc::new(Inner {
                store: StdMutex::new(store),
                hub: Arc::new(Hub::new()),
                running: Mutex::new(None),
                pairing: StdMutex::new(None),
                pair_limit: StdMutex::new(RateLimiter::default()),
                rpc_limit: StdMutex::new(RateLimiter::default()),
                tailscale: StdMutex::new(TailscaleView::default()),
                ts_checked: StdMutex::new(None),
                running_flag: AtomicBool::new(false),
                generation: AtomicU64::new(0),
                last_error: StdMutex::new(None),
            }),
        }
    }

    pub fn hub(&self) -> Arc<Hub> {
        self.inner.hub.clone()
    }

    pub fn is_running(&self) -> bool {
        self.inner.running_flag.load(Ordering::Relaxed)
    }

    pub fn tailscale_url(&self) -> Option<String> {
        self.inner.tailscale.lock().unwrap().https_url.clone()
    }

    pub fn allow_pair(&self, ip: &str) -> bool {
        self.inner
            .pair_limit
            .lock()
            .unwrap()
            .allow(ip, auth::PAIR_MAX_PER_WINDOW, auth::PAIR_WINDOW)
    }

    pub fn allow_rpc(&self, device: &str) -> bool {
        self.inner
            .rpc_limit
            .lock()
            .unwrap()
            .allow(device, auth::RPC_MAX_PER_WINDOW, auth::RPC_WINDOW)
    }

    pub fn authenticate(&self, token: &str, ip: Option<&str>) -> Option<DeviceView> {
        self.inner.store.lock().unwrap().authenticate(token, ip)
    }

    pub fn device_id_for_token(&self, token: &str) -> Option<String> {
        self.inner.store.lock().unwrap().authenticate(token, None).map(|d| d.id)
    }

    pub fn pair(
        &self,
        secret: &str,
        name: &str,
        ip: Option<&str>,
        ua: Option<&str>,
        existing: Option<&str>,
    ) -> Result<(String, DeviceView), PairError> {
        let mut guard = self.inner.pairing.lock().unwrap();
        let Some(p) = guard.as_mut() else { return Err(PairError::BadSecret) };
        if p.used {
            return Err(PairError::Used);
        }
        if p.remaining_secs() == 0 {
            return Err(PairError::Expired);
        }
        if !p.verify(secret) {
            return Err(PairError::BadSecret);
        }
        p.consume();
        drop(guard);
        let issued = {
            let mut store = self.inner.store.lock().unwrap();
            store.issue_token_persisted(existing, name, ip, ua)
        };
        *self.inner.pairing.lock().unwrap() = None;
        issued.map_err(|_| PairError::Storage)
    }

    pub fn revoke_device(&self, id: &str) -> Result<bool, String> {
        let mut store = self.inner.store.lock().unwrap();
        let changed = store.revoke(id);
        // 即使内存中已不存在也要重试写入：上一次撤销可能未能持久化。
        store.persist_devices()?;
        Ok(changed)
    }

    /// 在同一把锁内取出实际撤销的设备身份；保存失败也要返回清单以断开连接。
    pub fn revoke_all(&self) -> (Vec<String>, Result<(), String>) {
        let mut store = self.inner.store.lock().unwrap();
        let ids = store.devices().into_iter().map(|d| d.id).collect();
        store.revoke_all();
        (ids, store.persist_devices())
    }

    fn prefs(&self) -> RemotePrefs {
        self.inner.store.lock().unwrap().prefs.clone()
    }

    pub async fn status(&self) -> RemoteStatus {
        let (running, port, access) = {
            let r = self.inner.running.lock().await;
            match r.as_ref() {
                Some(r) => (true, r.port, self.prefs().access),
                None => (false, self.prefs().port, self.prefs().access),
            }
        };
        let tailscale = self.inner.tailscale.lock().unwrap().clone();
        let mut addresses = Vec::new();
        if running {
            addresses.push(RemoteAddress {
                url: net::local_address(port).url,
                label: net::local_address(port).label,
                kind: "local".into(),
            });
            if access == "lan" {
                addresses.extend(
                    net::lan_addresses(port)
                        .into_iter()
                        .map(|a| RemoteAddress { url: a.url, label: a.label, kind: a.kind }),
                );
                if let Some(ip) = &tailscale.ipv4 {
                    let a = net::tailscale_address(ip, port);
                    addresses.push(RemoteAddress { url: a.url, label: a.label, kind: a.kind });
                }
            }
            if let Some(url) = &tailscale.https_url {
                addresses.push(RemoteAddress {
                    url: url.clone(),
                    label: "Tailscale HTTPS".into(),
                    kind: "tailscale".into(),
                });
            }
        }
        let (pairing_active, pairing_expires_in) = {
            let p = self.inner.pairing.lock().unwrap();
            match p.as_ref() {
                Some(p) if p.is_active() => (true, p.remaining_secs()),
                _ => (false, 0),
            }
        };
        let (devices, devices_save_pending) = {
            let store = self.inner.store.lock().unwrap();
            (store.devices(), store.devices_save_pending())
        };
        RemoteStatus {
            running,
            access,
            port,
            addresses,
            pairing_active,
            pairing_expires_in,
            devices,
            devices_save_pending,
            connections: self.inner.hub.client_count(),
            tailscale,
            error: self.inner.last_error.lock().unwrap().clone(),
        }
    }

    pub fn emit_state(&self, app: &AppHandle) {
        let manager = self.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let status = manager.status().await;
            let _ = app.emit(REMOTE_STATE_EVENT, status);
        });
    }

    pub async fn start(&self, app: &AppHandle, access: &str, port: u16) -> Result<RemoteStatus, crate::commands::CmdError> {
        if access != "lan" && access != "tailscale" {
            return Err(crate::commands::cmd_err("BAD_ARG", "访问方式只能是 lan / tailscale".into(), None));
        }
        if port < 1024 {
            return Err(crate::commands::cmd_err("BAD_ARG", "端口必须在 1024–65535".into(), None));
        }
        // 重新开启时保留 Tailscale Serve（下面按新端口重新指一次）；只有显式 stop 才关闭。
        self.stop_inner(app, false).await;
        let bind = if access == "lan" { "0.0.0.0" } else { "127.0.0.1" };
        let listener = TcpListener::bind((bind, port))
            .await
            .map_err(|e| {
                crate::commands::cmd_err(
                    "REMOTE_BIND",
                    format!("远程控制启动失败：{e}"),
                    Some(if e.kind() == std::io::ErrorKind::AddrInUse {
                        "端口被占用（可能另一个实例已开启远程控制），请换一个端口".into()
                    } else {
                        "请检查系统防火墙 / 端口权限".into()
                    }),
                )
            })?;
        {
            let mut store = self.inner.store.lock().unwrap();
            store.prefs.access = access.to_string();
            store.prefs.port = port;
            let _ = store.save_prefs();
        }
        let generation = self.inner.generation.fetch_add(1, Ordering::Relaxed) + 1;
        let (shutdown, mut rx) = watch::channel(false);
        let ctx = server::Ctx { app: app.clone(), manager: self.clone() };
        let router = server::router(ctx);
        let manager = self.clone();
        let app2 = app.clone();
        let task = tauri::async_runtime::spawn(async move {
            let out = axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
                .with_graceful_shutdown(async move {
                    let _ = rx.changed().await;
                })
                .await;
            manager.finish(generation, out.err().map(|e| e.to_string()), &app2).await;
        });
        *self.inner.running.lock().await = Some(RunningServer { generation, port, shutdown, task });
        self.inner.running_flag.store(true, Ordering::Relaxed);
        *self.inner.last_error.lock().unwrap() = None;
        // 之前已启用 Serve：端口可能变了，重新指到新端口（失败则清掉 HTTPS 地址并报错，
        // 但局域网仍可用）。
        let dns = {
            let ts = self.inner.tailscale.lock().unwrap();
            ts.serve_enabled.then(|| ts.dns_name.clone()).flatten()
        };
        if let Some(dns) = dns {
            let https_port = self.prefs().tailscale_https_port;
            match net::serve_on(&dns, port, https_port).await {
                Ok(url) => {
                    let mut ts = self.inner.tailscale.lock().unwrap();
                    ts.https_url = Some(url);
                    ts.serve_enabled = true;
                }
                Err(e) => {
                    let mut ts = self.inner.tailscale.lock().unwrap();
                    ts.https_url = None;
                    ts.serve_enabled = false;
                    *self.inner.last_error.lock().unwrap() = Some(format!("Tailscale Serve 未恢复：{e}"));
                }
            }
        }
        self.emit_state(app);
        Ok(self.status().await)
    }

    async fn finish(&self, generation: u64, error: Option<String>, app: &AppHandle) {
        let mut running = self.inner.running.lock().await;
        let matches = running.as_ref().is_some_and(|r| r.generation == generation);
        if matches {
            running.take();
            self.inner.running_flag.store(false, Ordering::Relaxed);
            *self.inner.last_error.lock().unwrap() = error;
            self.inner.hub.close_all();
        }
        drop(running);
        self.emit_state(app);
    }

    pub async fn stop(&self, app: &AppHandle) -> RemoteStatus {
        self.stop_inner(app, true).await
    }

    async fn stop_inner(&self, app: &AppHandle, disable_tailscale: bool) -> RemoteStatus {
        let running = self.inner.running.lock().await.take();
        if let Some(r) = running {
            self.inner.running_flag.store(false, Ordering::Relaxed);
            let _ = r.shutdown.send(true);
            self.inner.hub.close_all();
            let mut task = r.task;
            if tokio::time::timeout(std::time::Duration::from_secs(2), &mut task).await.is_err() {
                task.abort();
            }
        }
        *self.inner.pairing.lock().unwrap() = None;
        let prefs = self.prefs();
        if disable_tailscale && prefs.serve_enabled_by_us {
            let _ = net::serve_off(prefs.tailscale_https_port).await;
            let mut store = self.inner.store.lock().unwrap();
            store.prefs.serve_enabled_by_us = false;
            let _ = store.save_prefs();
            let mut ts = self.inner.tailscale.lock().unwrap();
            ts.https_url = None;
            ts.serve_enabled = false;
        }
        self.emit_state(app);
        self.status().await
    }

    pub fn pairing_qr(&self, base_url: &str) -> Result<PairingInfo, crate::commands::CmdError> {
        if !self.is_running() {
            return Err(crate::commands::cmd_err("REMOTE_OFF", "请先启用远程控制".into(), None));
        }
        let base = base_url.trim_end_matches('/').to_string();
        let port = self.prefs().port;
        let allowed = {
            let mut urls = vec![net::local_address(port).url.trim_end_matches('/').to_string()];
            urls.extend(net::lan_addresses(port).into_iter().map(|a| a.url.trim_end_matches('/').to_string()));
            if let Some(ip) = self.inner.tailscale.lock().unwrap().ipv4.clone() {
                urls.push(net::tailscale_address(&ip, port).url.trim_end_matches('/').to_string());
            }
            if let Some(u) = self.inner.tailscale.lock().unwrap().https_url.clone() {
                urls.push(u.trim_end_matches('/').to_string());
            }
            urls
        };
        if !allowed.iter().any(|u| u == &base) {
            return Err(crate::commands::cmd_err("BAD_ARG", "二维码地址不在当前可用地址里".into(), None));
        }
        let secret = store::new_secret(32);
        let url = format!("{base}/#pair={secret}");
        let svg = QrCode::new(url.as_bytes())
            .map_err(|e| crate::commands::cmd_err("QR", format!("生成二维码失败：{e}"), None))?
            .render::<qrcode::render::svg::Color>()
            .min_dimensions(260, 260)
            .build();
        *self.inner.pairing.lock().unwrap() = Some(Pairing::new(secret));
        Ok(PairingInfo { url, svg, expires_in: auth::PAIRING_TTL.as_secs() })
    }

    pub fn cancel_pairing(&self) {
        *self.inner.pairing.lock().unwrap() = None;
    }

    pub async fn tailscale_probe(&self, app: &AppHandle) -> TailscaleView {
        let info = net::detect().await;
        let mut view = TailscaleView::from_info(info);
        {
            let mut ts = self.inner.tailscale.lock().unwrap();
            view.https_url = ts.https_url.clone().filter(|_| ts.serve_enabled);
            view.serve_enabled = ts.serve_enabled;
            if !view.serve_enabled {
                view.https_url = None;
            }
            *ts = view.clone();
        }
        *self.inner.ts_checked.lock().unwrap() = Some(Instant::now());
        self.emit_state(app);
        view
    }

    pub async fn tailscale_enable(&self, app: &AppHandle) -> Result<RemoteStatus, crate::commands::CmdError> {
        let port = {
            let r = self.inner.running.lock().await;
            match r.as_ref() {
                Some(r) => r.port,
                None => return Err(crate::commands::cmd_err("REMOTE_OFF", "请先启用远程控制".into(), None)),
            }
        };
        let info = net::detect().await;
        if !info.installed {
            return Err(crate::commands::cmd_err("TS_MISSING", "未找到 Tailscale，请先安装".into(), None));
        }
        if let Some(err) = &info.error {
            return Err(crate::commands::cmd_err("TS_STATUS", err.clone(), None));
        }
        if info.backend_state.as_deref() != Some("Running") {
            return Err(crate::commands::cmd_err(
                "TS_OFFLINE",
                format!("Tailscale 未连接（{}）", info.backend_state.unwrap_or_else(|| "未知".into())),
                Some("请先在 Tailscale 里登录并连接".into()),
            ));
        }
        let dns = info.dns_name.clone().ok_or_else(|| {
            crate::commands::cmd_err("TS_DNS", "Tailscale 没有 MagicDNS 名称".into(), Some("请在 tailnet 里开启 MagicDNS".into()))
        })?;
        let prefs = self.prefs();
        let url = net::serve_on(&dns, port, prefs.tailscale_https_port).await.map_err(|e| {
            crate::commands::cmd_err("TS_SERVE", e, Some("请确认 tailnet 已开启 HTTPS 证书".into()))
        })?;
        {
            let mut store = self.inner.store.lock().unwrap();
            store.prefs.serve_enabled_by_us = true;
            let _ = store.save_prefs();
        }
        {
            let mut ts = self.inner.tailscale.lock().unwrap();
            ts.installed = true;
            ts.backend_state = info.backend_state;
            ts.dns_name = Some(dns);
            ts.ipv4 = info.ipv4;
            ts.https_url = Some(url);
            ts.serve_enabled = true;
            ts.error = None;
        }
        self.emit_state(app);
        Ok(self.status().await)
    }

    pub async fn tailscale_disable(&self, app: &AppHandle) -> RemoteStatus {
        let prefs = self.prefs();
        let _ = net::serve_off(prefs.tailscale_https_port).await;
        {
            let mut store = self.inner.store.lock().unwrap();
            store.prefs.serve_enabled_by_us = false;
            let _ = store.save_prefs();
        }
        {
            let mut ts = self.inner.tailscale.lock().unwrap();
            ts.https_url = None;
            ts.serve_enabled = false;
        }
        self.emit_state(app);
        self.status().await
    }

    /// App 退出：只发信号 + 尽力关 Serve，不等待（进程马上要结束）。
    pub fn shutdown(&self) {
        self.inner.running_flag.store(false, Ordering::Relaxed);
        self.inner.hub.close_all();
        let prefs = self.prefs();
        if prefs.serve_enabled_by_us {
            net::serve_off_sync(prefs.tailscale_https_port);
            if let Ok(mut store) = self.inner.store.lock() {
                store.prefs.serve_enabled_by_us = false;
                let _ = store.save_prefs();
            }
        }
        if let Some(r) = self.inner.running.try_lock().ok().and_then(|mut g| g.take()) {
            let _ = r.shutdown.send(true);
        }
    }
}

// ---------- Tauri commands ----------

#[tauri::command]
pub async fn remote_get_status(manager: State<'_, RemoteManager>) -> Result<RemoteStatus, crate::commands::CmdError> {
    Ok(manager.status().await)
}

#[tauri::command]
pub async fn remote_start(
    app: AppHandle,
    manager: State<'_, RemoteManager>,
    access: String,
    port: u16,
) -> Result<RemoteStatus, crate::commands::CmdError> {
    manager.start(&app, &access, port).await
}

#[tauri::command]
pub async fn remote_stop(app: AppHandle, manager: State<'_, RemoteManager>) -> Result<RemoteStatus, crate::commands::CmdError> {
    Ok(manager.stop(&app).await)
}

#[tauri::command]
pub async fn remote_pairing(
    manager: State<'_, RemoteManager>,
    base_url: String,
) -> Result<PairingInfo, crate::commands::CmdError> {
    manager.pairing_qr(&base_url)
}

#[tauri::command]
pub async fn remote_cancel_pairing(manager: State<'_, RemoteManager>) -> Result<(), crate::commands::CmdError> {
    manager.cancel_pairing();
    Ok(())
}

#[tauri::command]
pub async fn remote_revoke_device(
    app: AppHandle,
    manager: State<'_, RemoteManager>,
    id: String,
) -> Result<RemoteStatus, crate::commands::CmdError> {
    let result = manager.revoke_device(&id);
    // 空 id 只用于重试保存，不对应任何设备，也无需发断开通知。
    if !id.is_empty() {
        manager.hub().revoke_device(&id);
    }
    manager.emit_state(&app);
    result.map_err(|e| crate::commands::cmd_err("REMOTE_STORAGE", format!("设备已在当前运行中撤销，但保存失败；重启后可能恢复：{e}"), None))?;
    Ok(manager.status().await)
}

#[tauri::command]
pub async fn remote_revoke_all(app: AppHandle, manager: State<'_, RemoteManager>) -> Result<RemoteStatus, crate::commands::CmdError> {
    let (ids, result) = manager.revoke_all();
    for id in ids {
        manager.hub().revoke_device(&id);
    }
    manager.emit_state(&app);
    result.map_err(|e| crate::commands::cmd_err("REMOTE_STORAGE", format!("设备已在当前运行中撤销，但保存失败；重启后可能恢复：{e}"), None))?;
    Ok(manager.status().await)
}

#[tauri::command]
pub async fn remote_tailscale_probe(
    app: AppHandle,
    manager: State<'_, RemoteManager>,
) -> Result<TailscaleView, crate::commands::CmdError> {
    Ok(manager.tailscale_probe(&app).await)
}

#[tauri::command]
pub async fn remote_tailscale_enable(
    app: AppHandle,
    manager: State<'_, RemoteManager>,
) -> Result<RemoteStatus, crate::commands::CmdError> {
    manager.tailscale_enable(&app).await
}

#[tauri::command]
pub async fn remote_tailscale_disable(
    app: AppHandle,
    manager: State<'_, RemoteManager>,
) -> Result<RemoteStatus, crate::commands::CmdError> {
    Ok(manager.tailscale_disable(&app).await)
}

/// 事件镜像入口：运行时 / 命令层每发一个 Tauri 事件就顺手调这里。
pub fn mirror<R: tauri::Runtime>(app: &AppHandle<R>, channel: &str, payload: &Value) {
    let Some(manager) = app.try_state::<RemoteManager>() else { return };
    if !manager.is_running() {
        return;
    }
    manager.hub().mirror(channel, payload);
}

/// 给 `runtime.rs` / `commands` 的统一出口：Tauri 事件 + 远程镜像。
pub fn emit_event<R: tauri::Runtime>(app: &AppHandle<R>, channel: &str, payload: &Value) {
    let _ = app.emit(channel, payload);
    mirror(app, channel, payload);
}

/// 同 [`emit_event`]，但接受任意可序列化的 payload（运行时快照等）。
pub fn emit_serializable<R: tauri::Runtime, T: Serialize>(app: &AppHandle<R>, channel: &str, payload: &T) {
    let value = serde_json::to_value(payload).unwrap_or(Value::Null);
    emit_event(app, channel, &value);
}

