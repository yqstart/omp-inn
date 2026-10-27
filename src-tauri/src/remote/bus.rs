//! 远程事件总线：把运行时事件镜像给手机，并缓存“手机离线期间错过的审批”。
//!
//! 事件通道名与桌面 Tauri 事件**完全同名**（`omp-event://<sid>` / `omp-status://<sid>` /
//! `omp-state://<sid>`），前端因此能复用同一个 `useSessionEvents`，只是把 `listen`
//! 换成 WebSocket 实现。
//!
//! 待审批缓存只在内存里（TTL 30 分钟）：审批本来就是一次性的交互，不需要落盘。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::broadcast;

pub const PENDING_TTL: Duration = Duration::from_secs(30 * 60);
pub const PENDING_PER_SESSION: usize = 10;
pub const BROADCAST_CAP: usize = 1024;

#[derive(Debug, Clone)]
pub struct RemoteEvent {
    pub seq: u64,
    pub channel: String,
    pub payload: Value,
}

#[derive(Debug, Clone)]
struct PendingUi {
    frame: Value,
    created: Instant,
}

pub struct Hub {
    tx: broadcast::Sender<RemoteEvent>,
    seq: AtomicU64,
    clients: AtomicUsize,
    pending: Mutex<HashMap<String, Vec<PendingUi>>>,
    revoke: broadcast::Sender<String>,
    shutdown: broadcast::Sender<()>,
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}

impl Hub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(BROADCAST_CAP);
        let (revoke, _) = broadcast::channel(16);
        let (shutdown, _) = broadcast::channel(16);
        Self {
            tx,
            seq: AtomicU64::new(0),
            clients: AtomicUsize::new(0),
            pending: Mutex::new(HashMap::new()),
            revoke,
            shutdown,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RemoteEvent> {
        self.tx.subscribe()
    }

    pub fn revocations(&self) -> broadcast::Receiver<String> {
        self.revoke.subscribe()
    }

    pub fn shutdown_rx(&self) -> broadcast::Receiver<()> {
        self.shutdown.subscribe()
    }

    pub fn client_connected(&self) {
        self.clients.fetch_add(1, Ordering::Relaxed);
    }

    pub fn client_disconnected(&self) {
        self.clients.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn client_count(&self) -> usize {
        self.clients.load(Ordering::Relaxed)
    }

    /// 运行时每发一个事件就调这里：有客户端才广播；审批帧无论有没有客户端都要缓存。
    pub fn mirror(&self, channel: &str, payload: &Value) {
        self.remember_pending(channel, payload);
        if self.client_count() == 0 {
            return;
        }
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let _ = self.tx.send(RemoteEvent {
            seq,
            channel: channel.to_string(),
            payload: payload.clone(),
        });
    }

    /// 服务停止 / 撤销设备时用：让所有 WS 主动收尾。
    pub fn close_all(&self) {
        let _ = self.shutdown.send(());
    }

    pub fn revoke_device(&self, device_id: &str) {
        let _ = self.revoke.send(device_id.to_string());
    }

    fn remember_pending(&self, channel: &str, payload: &Value) {
        let Some(sid) = channel.strip_prefix("omp-event://") else {
            if let Some(sid) = channel.strip_prefix("omp-status://") {
                let state = payload.get("state").and_then(|s| s.as_str()).unwrap_or("");
                if state != "awaiting-approval" {
                    self.clear_session(sid);
                }
            }
            return;
        };
        let ty = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if ty != "extension_ui_request" {
            return;
        }
        let method = payload.get("method").and_then(|v| v.as_str()).unwrap_or("");
        let ui_id = payload.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if method == "cancel" {
            let target = payload.get("targetId").and_then(|v| v.as_str()).unwrap_or("");
            if !target.is_empty() {
                self.clear_pending(sid, target);
            }
            return;
        }
        if !matches!(method, "select" | "confirm" | "input" | "editor" | "ask") || ui_id.is_empty() {
            return;
        }
        let now = Instant::now();
        let mut map = self.pending.lock().unwrap();
        let list = map.entry(sid.to_string()).or_default();
        list.retain(|p| now.duration_since(p.created) <= PENDING_TTL);
        if let Some(p) = list.iter_mut().find(|p| p.frame.get("id").and_then(|v| v.as_str()) == Some(ui_id)) {
            p.frame = payload.clone();
            p.created = now;
            return;
        }
        if list.len() >= PENDING_PER_SESSION {
            list.remove(0);
        }
        list.push(PendingUi { frame: payload.clone(), created: now });
    }

    pub fn pending_for(&self, sid: &str) -> Vec<Value> {
        let now = Instant::now();
        let mut map = self.pending.lock().unwrap();
        let Some(list) = map.get_mut(sid) else { return Vec::new() };
        list.retain(|p| now.duration_since(p.created) <= PENDING_TTL);
        list.iter().map(|p| p.frame.clone()).collect()
    }

    pub fn pending_counts(&self) -> HashMap<String, usize> {
        let now = Instant::now();
        let mut map = self.pending.lock().unwrap();
        map.retain(|_, list| {
            list.retain(|p| now.duration_since(p.created) <= PENDING_TTL);
            !list.is_empty()
        });
        map.iter().map(|(k, v)| (k.clone(), v.len())).collect()
    }

    pub fn clear_pending(&self, sid: &str, ui_id: &str) {
        let mut map = self.pending.lock().unwrap();
        if let Some(list) = map.get_mut(sid) {
            list.retain(|p| p.frame.get("id").and_then(|v| v.as_str()) != Some(ui_id));
            if list.is_empty() {
                map.remove(sid);
            }
        }
    }

    pub fn clear_session(&self, sid: &str) {
        self.pending.lock().unwrap().remove(sid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn approval(id: &str) -> Value {
        json!({"type":"extension_ui_request","method":"select","id":id,"title":"run?"})
    }

    #[test]
    fn caches_approval_even_without_clients_and_dedupes() {
        let hub = Hub::new();
        let ch = "omp-event://s1";
        hub.mirror(ch, &approval("a1"));
        hub.mirror(ch, &approval("a1"));
        assert_eq!(hub.pending_for("s1").len(), 1);
        hub.clear_pending("s1", "a1");
        assert!(hub.pending_for("s1").is_empty());
    }

    #[test]
    fn status_running_clears_pending() {
        let hub = Hub::new();
        hub.mirror("omp-event://s1", &approval("a1"));
        assert_eq!(hub.pending_counts().get("s1"), Some(&1));
        hub.mirror("omp-status://s1", &json!({"state":"running"}));
        assert!(hub.pending_for("s1").is_empty());
    }

    #[test]
    fn cancel_removes_target() {
        let hub = Hub::new();
        hub.mirror("omp-event://s1", &approval("a1"));
        hub.mirror(
            "omp-event://s1",
            &json!({"type":"extension_ui_request","method":"cancel","id":"c1","targetId":"a1"}),
        );
        assert!(hub.pending_for("s1").is_empty());
    }

    #[test]
    fn pending_per_session_is_bounded() {
        let hub = Hub::new();
        for i in 0..(PENDING_PER_SESSION + 5) {
            hub.mirror("omp-event://s1", &approval(&format!("a{i}")));
        }
        assert!(hub.pending_for("s1").len() <= PENDING_PER_SESSION);
    }

    #[test]
    fn broadcast_only_with_clients() {
        let hub = Hub::new();
        let mut rx = hub.subscribe();
        hub.mirror("omp-event://s1", &json!({"type":"agent_start"}));
        assert!(rx.try_recv().is_err());
        hub.client_connected();
        hub.mirror("omp-event://s1", &json!({"type":"agent_start"}));
        let ev = rx.try_recv().unwrap();
        assert_eq!(ev.channel, "omp-event://s1");
        assert_eq!(ev.seq, 1);
    }
}
