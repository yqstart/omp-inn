//! 远程控制的持久化：本应用偏好 + 已配对设备。
//!
//! 两类文件都放在 `<appData>/omp-inn/` 下，**不写 omp 配置、不动 overlay**：
//! - `remote.json`：端口 / 访问方式 / Tailscale HTTPS 端口（可以公开，不含密钥）；
//! - `remote-devices.json`：安装级 salt + 设备记录的 **token 哈希**（0600）。
//!
//! 写入一律「临时文件 + rename」；Unix 下把临时文件权限设成 0600。文件损坏时备份
//! `.bak` 并按空处理——设备需要重新配对，但不会把损坏内容静默当成空文件覆盖掉。

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub const PREFS_VERSION: u32 = 1;
pub const DEVICES_VERSION: u32 = 1;

/// 默认端口：固定端口让 PWA 的 origin 稳定（换端口会让装机后的 PWA 打不开新地址）。
pub const DEFAULT_PORT: u16 = 43110;
/// Tailscale Serve 的默认 HTTPS 端口：独立于 443，避免覆盖用户已有的 serve 配置。
pub const DEFAULT_TS_HTTPS_PORT: u16 = 8443;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePrefs {
    pub version: u32,
    /// `lan` = 绑 0.0.0.0；`tailscale` = 绑 127.0.0.1，只经 Tailscale Serve 访问。
    pub access: String,
    pub port: u16,
    pub tailscale_https_port: u16,
    /// 本次运行是否由壳启动了 `tailscale serve`（退出 / 停止时据此清理）。
    #[serde(default)]
    pub serve_enabled_by_us: bool,
}

impl Default for RemotePrefs {
    fn default() -> Self {
        Self {
            version: PREFS_VERSION,
            access: "lan".into(),
            port: DEFAULT_PORT,
            tailscale_https_port: DEFAULT_TS_HTTPS_PORT,
            serve_enabled_by_us: false,
        }
    }
}

impl RemotePrefs {
    pub fn normalize(mut self) -> Self {
        if self.version != PREFS_VERSION {
            return Self::default();
        }
        if self.access != "lan" && self.access != "tailscale" {
            self.access = "lan".into();
        }
        if self.port < 1024 {
            self.port = DEFAULT_PORT;
        }
        if self.tailscale_https_port < 1024 {
            self.tailscale_https_port = DEFAULT_TS_HTTPS_PORT;
        }
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub id: String,
    pub name: String,
    /// `sha256(salt || token)` 的十六进制；明文 token 只在配对响应 / Cookie 里出现。
    pub token_hash: String,
    pub created_at: i64,
    #[serde(default)]
    pub last_seen_at: Option<i64>,
    #[serde(default)]
    pub last_ip: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub last_seen_at: Option<i64>,
    pub last_ip: Option<String>,
}

impl From<&DeviceRecord> for DeviceView {
    fn from(d: &DeviceRecord) -> Self {
        Self {
            id: d.id.clone(),
            name: d.name.clone(),
            created_at: d.created_at,
            last_seen_at: d.last_seen_at,
            last_ip: d.last_ip.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceFile {
    version: u32,
    salt: String,
    devices: Vec<DeviceRecord>,
}

/// 内存里的持久化数据。所有字段写入口都在本模块，调用方拿不到裸 `Vec`。
pub struct Store {
    prefs_path: PathBuf,
    devices_path: PathBuf,
    pub prefs: RemotePrefs,
    salt: String,
    devices: Vec<DeviceRecord>,
}

impl Store {
    pub fn load(dir: &Path) -> Self {
        let prefs_path = dir.join("remote.json");
        let devices_path = dir.join("remote-devices.json");
        let prefs = read_json::<RemotePrefs>(&prefs_path)
            .map(RemotePrefs::normalize)
            .unwrap_or_default();

        let (salt, devices) = match read_json::<DeviceFile>(&devices_path) {
            Some(mut f) if f.version == DEVICES_VERSION && !f.salt.is_empty() => {
                f.devices.retain(|d| !d.id.is_empty() && !d.token_hash.is_empty());
                (f.salt, f.devices)
            }
            Some(_) => (new_secret(16), Vec::new()),
            None => (new_secret(16), Vec::new()),
        };

        let store = Self { prefs_path, devices_path, prefs, salt, devices };
        // 首次启动 / 设备文件损坏后立刻落一份，避免每次启动换 salt（那会让所有设备静默失效）。
        let _ = store.save_prefs();
        let _ = store.save_devices();
        store
    }

    pub fn save_prefs(&self) -> Result<(), String> {
        let text = serde_json::to_string_pretty(&self.prefs).map_err(|e| e.to_string())?;
        write_private(&self.prefs_path, &text)
    }

    pub fn save_devices(&self) -> Result<(), String> {
        let file = DeviceFile {
            version: DEVICES_VERSION,
            salt: self.salt.clone(),
            devices: self.devices.clone(),
        };
        let text = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
        write_private(&self.devices_path, &text)
    }

    pub fn devices(&self) -> Vec<DeviceView> {
        self.devices.iter().map(DeviceView::from).collect()
    }

    /// 常量时间比对所有设备哈希；设备数量是个位数，遍历成本可以忽略。
    pub fn authenticate(&mut self, token: &str, ip: Option<&str>) -> Option<DeviceView> {
        if token.is_empty() {
            return None;
        }
        let want = hash_token(&self.salt, token);
        let mut hit: Option<usize> = None;
        for (i, d) in self.devices.iter().enumerate() {
            if d.token_hash.as_bytes().ct_eq(want.as_bytes()).into() {
                hit = Some(i);
            }
        }
        let i = hit?;
        let now = chrono::Utc::now().timestamp_millis();
        let d = &mut self.devices[i];
        d.last_seen_at = Some(now);
        if ip.is_some() {
            d.last_ip = ip.map(str::to_string);
        }
        Some(DeviceView::from(&*d))
    }

    /// 配对：已有合法设备（轮换）沿用 id / 创建时间；否则新建。
    pub fn issue_token(
        &mut self,
        existing: Option<&str>,
        name: &str,
        ip: Option<&str>,
        user_agent: Option<&str>,
    ) -> (String, DeviceView) {
        let token = new_secret(32);
        let token_hash = hash_token(&self.salt, &token);
        let now = chrono::Utc::now().timestamp_millis();
        let name = sanitize_name(name);
        if let Some(id) = existing {
            if let Some(d) = self.devices.iter_mut().find(|d| d.id == id) {
                d.name = name;
                d.token_hash = token_hash;
                d.last_seen_at = Some(now);
                d.last_ip = ip.map(str::to_string);
                if user_agent.is_some() {
                    d.user_agent = user_agent.map(str::to_string);
                }
                return (token, DeviceView::from(&*d));
            }
        }
        let d = DeviceRecord {
            id: new_secret(16).trim_end_matches('=').replace(['-', '_'], ""),
            name,
            token_hash,
            created_at: now,
            last_seen_at: Some(now),
            last_ip: ip.map(str::to_string),
            user_agent: user_agent.map(str::to_string),
        };
        let view = DeviceView::from(&d);
        self.devices.push(d);
        (token, view)
    }

    pub fn revoke(&mut self, id: &str) -> bool {
        let before = self.devices.len();
        self.devices.retain(|d| d.id != id);
        self.devices.len() != before
    }

    pub fn revoke_all(&mut self) -> usize {
        let n = self.devices.len();
        self.devices.clear();
        n
    }

    #[cfg(test)]
    pub fn has_token(&self, token: &str) -> bool {
        let want = hash_token(&self.salt, token);
        self.devices.iter().any(|d| d.token_hash.as_bytes().ct_eq(want.as_bytes()).into())
    }
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let text = fs::read_to_string(path).ok()?;
    match serde_json::from_str::<T>(&text) {
        Ok(v) => Some(v),
        Err(_) => {
            let bak = path.with_extension("bak");
            let _ = fs::copy(path, bak);
            None
        }
    }
}

fn write_private(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, text).map_err(|e| format!("写入失败：{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    #[cfg(windows)]
    {
        // Windows 的 rename 不覆盖已存在文件：先删再换（不是原子操作，但应用数据文件很小）。
        if path.exists() {
            let _ = fs::remove_file(path);
        }
    }
    fs::rename(&tmp, path).map_err(|e| format!("替换失败：{e}"))?;
    Ok(())
}

pub fn new_secret(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

fn hash_token(salt: &str, token: &str) -> String {
    let mut h = Sha256::new();
    h.update(salt.as_bytes());
    h.update(b":");
    h.update(token.as_bytes());
    hex::encode(h.finalize())
}

fn sanitize_name(name: &str) -> String {
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

/// 轻量 hex 编码（只用于哈希展示，不引额外依赖）。
mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        let mut out = String::with_capacity(bytes.as_ref().len() * 2);
        for b in bytes.as_ref() {
            use std::fmt::Write;
            let _ = write!(out, "{b:02x}");
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefs_normalize_bad_values() {
        let p = RemotePrefs { access: "nope".into(), port: 80, ..RemotePrefs::default() }.normalize();
        assert_eq!(p.access, "lan");
        assert_eq!(p.port, DEFAULT_PORT);
        let old = RemotePrefs { version: 99, access: "tailscale".into(), ..RemotePrefs::default() }.normalize();
        assert_eq!(old.version, PREFS_VERSION);
        assert_eq!(old.access, "lan");
    }

    #[test]
    fn token_is_hashed_and_authenticates() {
        let dir = std::env::temp_dir().join(format!("omp-remote-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut store = Store::load(&dir);
        let (token, dev) = store.issue_token(None, "iPhone", Some("192.168.1.9"), None);
        store.save_devices().unwrap();
        assert!(store.has_token(&token));
        assert!(!store.has_token("nope"));
        assert_eq!(store.authenticate(&token, None).unwrap().id, dev.id);
        // 文件里不能出现明文 token
        let raw = std::fs::read_to_string(dir.join("remote-devices.json")).unwrap();
        assert!(!raw.contains(&token));
        assert!(raw.contains("tokenHash"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn revoke_removes_device() {
        let dir = std::env::temp_dir().join(format!("omp-remote-revoke-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut store = Store::load(&dir);
        let (token, dev) = store.issue_token(None, "Phone", None, None);
        assert!(store.revoke(&dev.id));
        assert!(!store.has_token(&token));
        assert!(!store.revoke(&dev.id));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
