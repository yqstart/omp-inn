//! 存储维护（2026-10-22）：omp 侧磁盘占用读数、安全清理、壳侧闲置会话回收。
//!
//! 清理口径：
//! - `blobs` / `wal` / `archive` / `compress` 交给 omp 自己的 `omp gc`——哪些图片还在被会话引用
//!   是上游真值，壳侧不猜；默认先 dry-run 出读数，用户确认后才加 `--apply`。
//! - 日志 / 粘贴临时文件 / 设置备份是固定目录，按 mtime 阈值删除：跳过最近的文件与符号链接。
//! - **会话 jsonl 永远不由本模块删除**：归档 / 压缩也是 omp 的行为，用户数据只随用户显式操作变化。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::commands::{cmd_err, discover_omp_path, AppState, CmdError};

/// 递归统计上限：防止误把超大目录（例如用户把项目软链进来）扫穿。
const MAX_FILES: u64 = 200_000;
const MAX_DEPTH: u32 = 8;
/// `omp gc` 的超时：引用扫描要读全部会话 jsonl，实测秒级，留足余量。
const GC_TIMEOUT_SECS: u64 = 180;
/// 清理日志时永远跳过最近这么久内改过的文件（omp 正在写）。
const LOG_KEEP_RECENT_SECS: u64 = 3600;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageItem {
    /// 前端文案键（后端不掺文案）。
    pub key: String,
    pub path: String,
    pub bytes: u64,
    pub files: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStats {
    pub agent_dir: String,
    pub app_data_dir: String,
    pub items: Vec<StorageItem>,
    /// 当前常驻的会话进程数（壳侧内存里最重的一块）。
    pub runtimes: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoragePreview {
    /// `omp gc` 认为可回收的 blob 字节 / 文件数（dry-run 读数）。
    pub blob_bytes: u64,
    pub blob_files: u64,
    /// 冷会话归档 / 压缩的候选数。
    pub archive_sessions: u64,
    /// WAL checkpoint 能吐出的字节。
    pub wal_bytes: u64,
    /// 壳侧按阈值可删的字节 / 文件（日志 / 粘贴 / 备份）。
    pub logs_bytes: u64,
    pub paste_bytes: u64,
    pub backup_bytes: u64,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanPlan {
    #[serde(default)]
    pub blobs: bool,
    #[serde(default)]
    pub wal: bool,
    #[serde(default)]
    pub logs: bool,
    #[serde(default)]
    pub paste: bool,
    #[serde(default)]
    pub backups: bool,
    /// 深度优化：冷会话归档（`omp gc --archive`）。
    #[serde(default)]
    pub archive: bool,
    /// 深度优化：空闲会话文件系统压缩（`omp gc --compress`）。
    #[serde(default)]
    pub compress: bool,
    /// 壳侧文件（日志 / 粘贴 / 备份）的年龄阈值，天；缺省 7，夹到 1..=365。
    #[serde(default)]
    pub older_days: Option<u32>,
    /// true = 只算不删（与 `omp gc` 的 dry-run 一致）。
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanResult {
    pub freed_bytes: u64,
    pub deleted_files: u64,
    pub archived_sessions: u64,
    pub errors: Vec<String>,
}

fn now() -> SystemTime {
    SystemTime::now()
}

fn older_than(days: u32) -> SystemTime {
    let days = days.clamp(1, 365);
    now() - Duration::from_secs(u64::from(days) * 24 * 3600)
}

/// 递归统计目录：返回 (字节, 文件数)。`skip_ext` = 跳过带扩展名的文件
/// （omp 的 blob 目录是「无扩展名主文件 + 带扩展名硬链接」，按主文件计一次）。
fn dir_usage(root: &Path, skip_ext: bool) -> (u64, u64) {
    fn walk(dir: &Path, depth: u32, skip_ext: bool, bytes: &mut u64, files: &mut u64) {
        if depth > MAX_DEPTH || *files >= MAX_FILES {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            if *files >= MAX_FILES {
                return;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let ft = meta.file_type();
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                walk(&entry.path(), depth + 1, skip_ext, bytes, files);
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            if skip_ext && entry.path().extension().is_some() {
                continue;
            }
            *bytes = bytes.saturating_add(meta.len());
            *files += 1;
        }
    }
    let mut bytes = 0;
    let mut files = 0;
    walk(root, 0, skip_ext, &mut bytes, &mut files);
    (bytes, files)
}

fn file_usage(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// 统计或删除目录下早于 `cutoff` 的普通文件（不删目录、不跟随符号链接）。
fn scan_old(root: &Path, cutoff: SystemTime, keep_recent: Duration, delete: bool) -> (u64, u64, Vec<String>) {
    fn walk(dir: &Path, depth: u32, cutoff: SystemTime, keep_recent_until: SystemTime, delete: bool, bytes: &mut u64, files: &mut u64, errors: &mut Vec<String>) {
        if depth > MAX_DEPTH || *files >= MAX_FILES {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            let ft = meta.file_type();
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                walk(&entry.path(), depth + 1, cutoff, keep_recent_until, delete, bytes, files, errors);
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            let Ok(modified) = meta.modified() else { continue };
            if modified >= cutoff || modified >= keep_recent_until {
                continue;
            }
            let result = if delete { std::fs::remove_file(entry.path()) } else { Ok(()) };
            match result {
                Ok(()) => {
                    *bytes = bytes.saturating_add(meta.len());
                    *files += 1;
                }
                Err(e) => errors.push(format!("{}: {e}", entry.path().display())),
            }
        }
    }
    let mut bytes = 0;
    let mut files = 0;
    let mut errors = vec![];
    let keep_recent_until = now().checked_sub(keep_recent).unwrap_or(SystemTime::UNIX_EPOCH);
    walk(root, 0, cutoff, keep_recent_until, delete, &mut bytes, &mut files, &mut errors);
    (bytes, files, errors)
}

/// 确认清理后删除符合条件的文件。
fn prune_old(root: &Path, cutoff: SystemTime, keep_recent: Duration) -> (u64, u64, Vec<String>) {
    scan_old(root, cutoff, keep_recent, true)
}

/// 跑一次 `omp gc`（`--json`；`apply = false` 时是 dry-run），返回解析后的 JSON。
async fn run_gc(bin: &str, flags: &[&str], apply: bool) -> Result<serde_json::Value, String> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("gc").arg("--json");
    for f in flags {
        cmd.arg(f);
    }
    if apply {
        cmd.arg("--apply");
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    if let Some(p) = crate::proc::login_path() {
        cmd.env("PATH", p);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.as_std_mut().process_group(0);
    }
    let out = tokio::time::timeout(Duration::from_secs(GC_TIMEOUT_SECS), cmd.output())
        .await
        .map_err(|_| "omp gc 超时（会话很多时请稍后重试）".to_string())?
        .map_err(|e| format!("无法运行 omp gc：{e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { format!("omp gc 退出码 {}", out.status) } else { err });
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("omp gc 输出无法解析：{e}"))
}

fn u64_at(v: &serde_json::Value, path: &[&str]) -> u64 {
    let mut cur = v;
    for k in path {
        match cur.get(*k) {
            Some(next) => cur = next,
            None => return 0,
        }
    }
    cur.as_u64().unwrap_or(0)
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, CmdError> {
    app.path()
        .app_data_dir()
        .map_err(|e| cmd_err("IO", format!("无法定位应用数据目录：{e}"), None))
}

/// 壳侧固定目录：agent 的图片缓存 / 会话记录 / 日志，应用自己的粘贴临时文件 / 设置备份。
#[derive(Clone)]
struct Dirs {
    agent: PathBuf,
    blobs: PathBuf,
    sessions: PathBuf,
    logs: PathBuf,
    paste: PathBuf,
    backups: PathBuf,
    app_data: PathBuf,
}

fn dirs(app: &AppHandle, agent: PathBuf) -> Result<Dirs, CmdError> {
    let app_data = app_data_dir(app)?;
    // omp 的日志目录与 agent 目录同级（`~/.omp/logs`），不在 `agent/logs` 里；
    // 自定义 `--agent-dir` 时同样按「agent 的父目录」兜底。
    let logs = agent.parent().map(|p| p.join("logs")).unwrap_or_else(|| agent.join("logs"));
    Ok(Dirs {
        blobs: agent.join("blobs"),
        sessions: agent.join("sessions"),
        logs,
        paste: app_data.join("omp-inn").join("paste"),
        backups: app_data.join("omp-inn").join("backups"),
        agent,
        app_data,
    })
}

/// 存储读数（只读、不做 `omp gc`——那一步单独走 `preview_storage_cleanup`，避免每次进页面都扫全部会话）。
#[tauri::command]
pub async fn get_storage_stats(app: AppHandle, state: State<'_, AppState>) -> Result<StorageStats, CmdError> {
    let agent = state.agent_dir.lock().await.clone();
    let d = dirs(&app, agent)?;
    let runtimes = state.runtime.lock().await.len();
    let dirs_for_blocking = d.clone();
    let items = tauri::async_runtime::spawn_blocking(move || {
        let mut items = vec![];
        let mut push = |key: &str, path: PathBuf, skip_ext: bool| {
            let (bytes, files) = dir_usage(&path, skip_ext);
            items.push(StorageItem { key: key.into(), path: path.to_string_lossy().to_string(), bytes, files });
        };
        // omp 的 blob 主文件没有扩展名；带扩展名的是同 inode 硬链接，只按主文件计一次。
        push("ompImages", dirs_for_blocking.blobs.clone(), true);
        push("ompSessions", dirs_for_blocking.sessions.clone(), false);
        push("ompLogs", dirs_for_blocking.logs.clone(), false);
        push("shellPaste", dirs_for_blocking.paste.clone(), false);
        push("shellBackups", dirs_for_blocking.backups.clone(), false);
        let db_paths: Vec<PathBuf> = ["history.db", "models.db", "agent.db"]
            .iter()
            .flat_map(|name| [dirs_for_blocking.agent.join(name), dirs_for_blocking.agent.join(format!("{name}-wal")), dirs_for_blocking.agent.join(format!("{name}-shm"))])
            .filter(|p| p.is_file())
            .collect();
        let db_bytes: u64 = db_paths.iter().map(|p| file_usage(p)).sum();
        let db_files = db_paths.len() as u64;
        let ledger = file_usage(&dirs_for_blocking.app_data.join("omp-inn").join("usage-ledger.jsonl"));
        items.push(StorageItem { key: "ompDatabases".into(), path: dirs_for_blocking.agent.to_string_lossy().to_string(), bytes: db_bytes, files: db_files });
        items.push(StorageItem { key: "shellLedger".into(), path: dirs_for_blocking.app_data.to_string_lossy().to_string(), bytes: ledger, files: if ledger > 0 { 1 } else { 0 } });
        items
    })
    .await
    .map_err(|e| cmd_err("IO", format!("统计失败：{e}"), None))?;
    Ok(StorageStats {
        agent_dir: d.agent.to_string_lossy().to_string(),
        app_data_dir: d.app_data.to_string_lossy().to_string(),
        items,
        runtimes,
    })
}

/// 清理前的 dry-run 读数：`omp gc` 的候选字节 + 壳侧按阈值的可删字节。
#[tauri::command]
pub async fn preview_storage_cleanup(app: AppHandle, state: State<'_, AppState>, older_days: Option<u32>) -> Result<StoragePreview, CmdError> {
    let agent = state.agent_dir.lock().await.clone();
    let d = dirs(&app, agent)?;
    let cutoff = older_than(older_days.unwrap_or(7));
    let (logs_bytes, _, _) = scan_old(&d.logs, cutoff, Duration::from_secs(LOG_KEEP_RECENT_SECS), false);
    let (paste_bytes, _, _) = scan_old(&d.paste, cutoff, Duration::ZERO, false);
    let (backup_bytes, _, _) = scan_old(&d.backups, cutoff, Duration::ZERO, false);
    let mut preview = StoragePreview { logs_bytes, paste_bytes, backup_bytes, ..Default::default() };
    let bin = discover_omp_path(&state).ok_or_else(|| cmd_err("NO_OMP", "没有找到 omp 可执行文件".into(), None))?;
    match run_gc(&bin, &["--blobs", "--archive", "--wal"], false).await {
        Ok(v) => {
            preview.blob_bytes = u64_at(&v, &["blobs", "bytes"]);
            preview.blob_files = u64_at(&v, &["blobs", "wouldDelete"]);
            preview.archive_sessions = u64_at(&v, &["archive", "wouldArchive"]);
            preview.wal_bytes = u64_at(&v, &["wal", "walBytes"]);
        }
        Err(e) => preview.errors.push(e),
    }
    Ok(preview)
}

/// 执行清理（或 dry-run）。
///
/// `plan` 里勾选的项才动；日志 / 粘贴 / 备份在 dry-run 下只统计不删除。
#[tauri::command]
pub async fn clean_storage(app: AppHandle, state: State<'_, AppState>, plan: CleanPlan) -> Result<CleanResult, CmdError> {
    let agent = state.agent_dir.lock().await.clone();
    let d = dirs(&app, agent)?;
    let mut result = CleanResult::default();
    let older_days = plan.older_days.unwrap_or(7);
    let cutoff = older_than(older_days);

    // 壳侧目录：dry-run 由 `preview_storage_cleanup` 单独给读数，这里只在执行时真删。
    if !plan.dry_run {
        if plan.logs {
            let (bytes, files, errors) = prune_old(&d.logs, cutoff, Duration::from_secs(LOG_KEEP_RECENT_SECS));
            result.errors.extend(errors);
            result.freed_bytes = result.freed_bytes.saturating_add(bytes);
            result.deleted_files = result.deleted_files.saturating_add(files);
        }
        if plan.paste {
            let (bytes, files, errors) = prune_old(&d.paste, cutoff, Duration::ZERO);
            result.errors.extend(errors);
            result.freed_bytes = result.freed_bytes.saturating_add(bytes);
            result.deleted_files = result.deleted_files.saturating_add(files);
        }
        if plan.backups {
            let (bytes, files, errors) = prune_old(&d.backups, cutoff, Duration::ZERO);
            result.errors.extend(errors);
            result.freed_bytes = result.freed_bytes.saturating_add(bytes);
            result.deleted_files = result.deleted_files.saturating_add(files);
        }
    }

    let mut flags = vec![];
    if plan.blobs {
        flags.push("--blobs");
    }
    if plan.wal {
        flags.push("--wal");
    }
    if plan.archive {
        flags.push("--archive");
    }
    if plan.compress {
        flags.push("--compress");
    }
    if !flags.is_empty() {
        match discover_omp_path(&state) {
            Some(bin) => match run_gc(&bin, &flags, !plan.dry_run).await {
                Ok(v) => {
                    if plan.blobs {
                        result.freed_bytes = result.freed_bytes.saturating_add(u64_at(&v, &["blobs", "bytes"]));
                        result.deleted_files = result.deleted_files.saturating_add(u64_at(&v, &["blobs", if plan.dry_run { "wouldDelete" } else { "deleted" }]));
                    }
                    if plan.wal {
                        result.freed_bytes = result.freed_bytes.saturating_add(u64_at(&v, &["wal", "walBytes"]));
                    }
                    if plan.archive {
                        result.archived_sessions = u64_at(&v, &["archive", if plan.dry_run { "wouldArchive" } else { "archived" }]);
                    }
                }
                Err(e) => result.errors.push(e),
            },
            None => result.errors.push("没有找到 omp 可执行文件".into()),
        }
    }
    Ok(result)
}

/// 立即回收闲置会话进程（与定时回收同一判定：idle 超阈值 + 已落盘）。
#[tauri::command]
pub async fn reclaim_idle_sessions(state: State<'_, AppState>) -> Result<usize, CmdError> {
    Ok(crate::runtime::reclaim_idle_now(&state, crate::runtime::IDLE_RECYCLE_MS).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_usage_counts_files_and_can_skip_hardlink_copies() {
        let root = std::env::temp_dir().join(format!("omp-inn-storage-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("a"), b"12345").unwrap();
        std::fs::write(root.join("a.webp"), b"12345").unwrap();
        std::fs::write(root.join("sub").join("b"), b"123").unwrap();
        let (bytes, files) = dir_usage(&root, false);
        assert_eq!((bytes, files), (13, 3));
        let (bytes, files) = dir_usage(&root, true);
        assert_eq!((bytes, files), (8, 2));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_skips_recent_and_follows_no_symlinks() {
        let root = std::env::temp_dir().join(format!("omp-inn-prune-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("old.log"), b"old").unwrap();
        std::fs::write(root.join("new.log"), b"new").unwrap();
        let old = SystemTime::now() - Duration::from_secs(10 * 24 * 3600);
        filetime_set(root.join("old.log"), old);
        let cutoff = SystemTime::now() - Duration::from_secs(7 * 24 * 3600);
        let (bytes, files, errors) = prune_old(&root, cutoff, Duration::ZERO);
        assert_eq!((bytes, files), (3, 1));
        assert!(errors.is_empty());
        assert!(!root.join("old.log").exists());
        assert!(root.join("new.log").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 改 mtime（标准库只有 set_times 需要 File；测试里用 `filetime` 会多一个依赖，直接走宏）。
    fn filetime_set(path: PathBuf, time: SystemTime) {
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(time).unwrap();
    }

    #[test]
    fn u64_at_reads_nested_counts() {
        let v = serde_json::json!({"blobs": {"bytes": 42, "wouldDelete": 3}});
        assert_eq!(u64_at(&v, &["blobs", "bytes"]), 42);
        assert_eq!(u64_at(&v, &["blobs", "wouldDelete"]), 3);
        assert_eq!(u64_at(&v, &["missing", "x"]), 0);
    }
}
