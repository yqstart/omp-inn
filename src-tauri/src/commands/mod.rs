use serde::Serialize;
use std::{
    collections::HashMap,
    future::Future,
    path::{Path, PathBuf},
};
use tokio::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{overlay::*, session_scan::*};

pub struct AppState {
    pub overlay_path: PathBuf,
    pub overlay: Mutex<Overlay>,
    pub agent_dir: Mutex<PathBuf>,
    pub omp_path: Mutex<Option<String>>,
    pub omp_version: Mutex<Option<String>>,
    pub models_cache: Mutex<Option<(i64, serde_json::Value)>>,
    /// 模型目录拉取的**单飞锁**：`omp models --json` 实测 2–10s（上游要拉各供应商的
    /// 模型列表，抖动大），而读取方有四个（启动预取 / 健康检查 / 供应商页 / 模型页）
    /// ——必须共用同一次拉取（见 [`load_catalog`]）。
    pub models_fetch: Mutex<()>,
    /// 进行中的供应商登录（同一时刻只允许一个）。
    pub login: std::sync::Arc<Mutex<Option<crate::providers::LoginSession>>>,
    /// 最近一次登录的进度快照（切走设置页再回来时用它补齐，见 `providers.rs`）。
    pub login_status: std::sync::Arc<Mutex<crate::providers::LoginStatus>>,
    /// 模型角色「读 → 改 → 写」与「整表激活」的串行锁：`modelRoles` 是 record，
    /// 只能整表写回，两次并发写不加锁会互相覆盖（丢键）。
    pub roles_edit: Mutex<()>,
    /// 失败转移链（`retry.fallbackChains`）的同类锁：record 也只能整表写回。
    pub retry_edit: Mutex<()>,
    /// 自定义模型配置（`models.yml`）的读写锁：写入含「预校验 + 备份 + 替换」多步，
    /// 并发保存会互相覆盖（见 `models_config.rs`）。
    pub models_edit: Mutex<()>,
    /// 设置 ›「omp 约束」的写操作串行锁：`AGENTS.md` / `RULES.md` / `rules/*.md` 的
    /// 「读 → 比对 → 备份 → 原子写」多步事务（见 `constraints.rs`）。
    pub constraints_edit: Mutex<()>,
    /// 扩展（设置 ›「插件」/「技能」）写操作的串行锁：插件 install / uninstall 会动
    /// 同一个插件目录与 lock 文件；技能的 `disabledExtensions` 是读-改-写同一份 config.yml
    /// （见 `plugins.rs` / `skills.rs`）。能力少、争用低，共用一个锁就够。
    pub extensions_edit: Mutex<()>,
    /// 聊天形态（V32 恢复自 V1–V10）：per-会话长驻 `omp --mode rpc-ui` 进程表（见 `runtime.rs`）。
    /// 列表行「运行中」标记不另存 map：判据是进程表内活动态（`activity_is_busy`），
    /// 见 `running_snapshot`——单一真值，避免「打开过就一直转圈」。
    pub runtime: crate::runtime::RuntimeMap,
    /// 同一会话的恢复共用一次启动；弱引用避免长期保留已结束的锁。
    pub runtime_recovery: Mutex<HashMap<String, std::sync::Weak<Mutex<Option<String>>>>>,
    /// V42 右栏「终端」页签：终端 id → PTY 句柄（前端打开 / 关闭驱动，见 `pty.rs`）。
    pub terminals: crate::pty::TerminalMap,
    /// V14 工作区「提交并推送」：cwd → 任务句柄（同一工作区拒绝重入，不同工作区可并行，
    /// 见 `git_commit.rs`）。
    pub commit_tasks: crate::git_commit::CommitMap,
    /// V24 omp 运行时更新：**全局单槽**任务句柄（一台机器只有一份 omp 安装，两次更新互斥；
    /// 见 `omp_update.rs`）。
    pub omp_update_task: crate::omp_update::UpdateSlot,
    /// 使用统计的**壳侧账本**（`<appData>/omp-inn/usage-ledger.jsonl`，只追加）：会话被删掉后
    /// 用量仍能补回来（见 `usage.rs` 模块头「壳侧账本」）。
    pub usage_ledger: crate::usage::UsageLedger,
}

#[derive(Debug, Serialize)]
pub struct CmdError {
    pub ok: bool,
    pub code: String,
    pub message: String,
    pub hint: Option<String>,
}

pub fn cmd_err(code: &str, message: String, hint: Option<String>) -> CmdError {
    CmdError { ok: false, code: code.into(), message, hint }
}

/// 覆盖层原子写（临时文件 + rename）。调用方负责保证 `ov` 是当前内存快照。
pub(crate) fn write_overlay_file(path: &Path, ov: &Overlay) -> Result<(), String> {
    let text = serde_json::to_string_pretty(ov).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn save_overlay(state: &AppState) -> Result<(), String> {
    let ov = state.overlay.try_lock().map_err(|_| "overlay 忙，请重试".to_string())?;
    write_overlay_file(&state.overlay_path, &ov)
}

/// 项目路径跟随外部改名：把覆盖层里失联的项目按目录身份链找回，并刷新身份链。
///
/// 只在真正有变化时写盘；返回**项目路径是否变了**（身份链首次补齐不算）。
/// 写盘失败回滚内存快照，避免「界面已换新路径、重启又变回去」。
pub(crate) async fn sync_project_paths(state: &AppState) -> bool {
    let mut ov = state.overlay.lock().await;
    let original = ov.clone();
    let before: Vec<String> = ov.projects.iter().map(|p| p.path.clone()).collect();
    let dirty = crate::project_paths::sync_project_paths(&mut ov);
    let paths_changed = ov.projects.iter().map(|p| p.path.clone()).collect::<Vec<_>>() != before;
    if dirty {
        if let Err(e) = write_overlay_file(&state.overlay_path, &ov) {
            eprintln!("[project-paths] 覆盖层写盘失败：{e}");
            *ov = original;
            return false;
        }
    }
    paths_changed
}

fn load_overlay(path: &std::path::Path) -> (Overlay, bool) {
    let Ok(text) = std::fs::read_to_string(path) else { return (Overlay::default(), false) };
    let Ok(v) = serde_json::from_str::<Overlay>(&text) else {
        let bak = path.with_extension("bak");
        let _ = std::fs::copy(path, &bak);
        return (Overlay::default(), true);
    };
    v.normalize()
}

// ---------- omp 定位 ----------

fn run_cmd(file: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new(file)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Windows 上按 PATH 找 omp：先手动扫 PATH（`std::env::split_paths` 是 Unicode 安全的），
/// 再用 `where omp` 兜底（PATHEXT / App Paths 的少量差异；它的 stdout 走系统 OEM 代码页，
/// 中文用户名目录可能解成乱码，所以只放在兜底）。
///
/// 不走 `$SHELL -ilc`：Windows 默认没有 `SHELL`，而 Git Bash 给出的 `/c/...`
/// 是 MSYS 路径，`Path::is_file()` 不认。
#[cfg(windows)]
fn find_omp_in_path() -> Option<String> {
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in ["omp.exe", "omp.cmd", "omp.bat", "omp"] {
                let p = dir.join(name);
                if p.is_file() {
                    return Some(p.to_string_lossy().into_owned());
                }
            }
        }
    }
    if let Ok(out) = run_cmd("where", &["omp"]) {
        for line in out.lines().map(str::trim).filter(|l| !l.is_empty()) {
            if std::path::Path::new(line).is_file() {
                return Some(line.to_string());
            }
        }
    }
    None
}

/// omp 可执行文件的定位（**唯一入口**）：覆盖层显式路径 → 已发现的缓存 → PATH → 常见安装位置。
///
/// **别改读 `state.omp_path`**：那个只在诊断（`locate_omp`）跑完才非空——启动时前端的配置读取
/// （权限档 / 默认思考档）与健康检查并发发出，读它拿到的是空值（档位永远卡在「读取中…」，
/// 直到用户打开菜单才补读成功）；而诊断失败也不该把配置读取一起拖垮。反过来，缓存里已有
/// 仍存在的路径时不必再起一次登录 shell 探测（切模型时读默认思考档会走这里）。
pub fn discover_omp_path(state: &State<AppState>) -> Option<String> {
    if let Ok(ov) = state.overlay.try_lock() {
        if let Some(p) = ov.omp_path.as_ref() {
            if std::path::Path::new(p).is_file() {
                return Some(p.clone());
            }
        }
    }
    if let Ok(g) = state.omp_path.try_lock() {
        if let Some(p) = g.as_ref() {
            if std::path::Path::new(p).is_file() {
                return Some(p.clone());
            }
        }
    }
    #[cfg(windows)]
    if let Some(found) = find_omp_in_path() {
        return Some(found);
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        if let Ok(out) = run_cmd(&shell, &["-ilc", "command -v omp"]) {
            if let Some(found) = out.lines().map(str::trim).filter(|l| l.starts_with('/')).last() {
                if std::path::Path::new(found).is_file() {
                    return Some(found.to_string());
                }
            }
        }
        for c in ["/opt/homebrew/bin/omp", "/usr/local/bin/omp"] {
            if std::path::Path::new(c).is_file() {
                return Some(c.to_string());
            }
        }
    }
    // 官方安装脚本的落点（`omp.sh/install`：bun 可用时装到 bun 的全局 bin，
    // 否则把预编译二进制放进 `~/.local/bin`）——两者都可能不在 GUI 进程的 PATH 里。
    // Windows 的脚本落在 `%LOCALAPPDATA%\omp\omp.exe` 或 bun 的全局 bin（`%USERPROFILE%`）。
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok();
    if let Some(home) = home {
        #[cfg(windows)]
        let candidates = [format!("{home}\\.bun\\bin\\omp.exe")];
        #[cfg(not(windows))]
        let candidates = [format!("{home}/.local/bin/omp"), format!("{home}/.bun/bin/omp")];
        for p in candidates {
            if std::path::Path::new(&p).is_file() {
                return Some(p);
            }
        }
    }
    #[cfg(windows)]
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let p = format!("{local}\\omp\\omp.exe");
        if std::path::Path::new(&p).is_file() {
            return Some(p);
        }
    }
    None
}

#[derive(Debug, Clone, Serialize)]
pub struct OmpInfo {
    #[serde(rename = "ompPath")]
    pub omp_path: Option<String>,
    #[serde(rename = "ompVersion")]
    pub omp_version: Option<String>,
    #[serde(rename = "agentDir")]
    pub agent_dir: String,
    pub errors: Vec<String>,
}

/// 后端工具函数：解析一次 omp 定位与版本（不触碰 State，供 Tauri commands 与内部调用共用）。
/// 必须 anyhow 化：任何失败都返回 Err(String)，调用方自行决定降级。
fn probe_omp(bin: &str) -> Result<(Option<String>, std::path::PathBuf, Vec<String>), String> {
    let mut errors = vec![];
    let mut version = None;
    match run_cmd(bin, &["--version"]) {
        Ok(out) => {
            let text = out.trim().to_string();
            version = text.split_whitespace().next().map(|s| s.trim_start_matches("omp/").to_string()).or(Some(text));
        }
        Err(e) => errors.push(format!("omp --version 失败：{e}")),
    }
    let mut agent_dir = resolve_agent_dir(None);
    match run_cmd(bin, &["config", "path"]) {
        Ok(out) => {
            agent_dir = resolve_agent_dir(Some(out));
        }
        Err(e) => errors.push(format!("omp config path 失败：{e}")),
    }
    Ok((version, agent_dir, errors))
}

/// 诊断用：解析一次 omp 定位与版本（`set_omp_path` / `get_health` 内部调用）。
pub async fn locate_omp(state: State<'_, AppState>) -> Result<OmpInfo, CmdError> {
    let resolved = discover_omp_path(&state);
    let (mut version, mut agent_dir, mut errors) = (None, resolve_agent_dir(None), vec![]);
    if let Some(ref p) = resolved {
        match probe_omp(p) {
            Ok((v, dir, errs)) => {
                version = v;
                agent_dir = dir;
                errors = errs;
            }
            Err(e) => errors.push(e),
        }
    } else {
        errors.push("未找到 omp 可执行文件，请安装 oh-my-pi 或手动指定路径".into());
    }
    *state.omp_path.lock().await = resolved.clone();
    *state.omp_version.lock().await = version.clone();
    *state.agent_dir.lock().await = agent_dir.clone();
    Ok(OmpInfo {
        omp_path: resolved,
        omp_version: version,
        agent_dir: agent_dir.to_string_lossy().to_string(),
        errors,
    })
}

#[tauri::command]
pub async fn set_omp_path(state: State<'_, AppState>, path: Option<String>) -> Result<OmpInfo, CmdError> {
    if let Ok(mut ov) = state.overlay.try_lock() {
        ov.omp_path = path;
    }
    save_overlay(&state).map_err(|e| cmd_err("OVERLAY_WRITE", e, None))?;
    locate_omp(state).await
}

#[derive(Debug, Clone, Serialize)]
pub struct HealthInfo {
    pub omp: OmpInfo,
    #[serde(rename = "modelsError")]
    pub models_error: Option<String>,
    pub ok: bool,
}

#[tauri::command]
pub async fn get_health(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<HealthInfo, CmdError> {
    let omp = locate_omp(state.clone()).await?;
    let mut models_error = None;
    if omp.omp_path.is_some() {
        // 目录走缓存（SWR）：健康检查的职责是「omp 能不能用」，不该每次重拉目录——
        // `omp models --json` 实测 2–10s，这是启动慢与「重新检测」慢的主要来源。
        if let Err(e) = catalog_swr(&state, &app).await {
            models_error = Some(format!("模型目录加载失败：{}", e.message));
        }
    } else {
        models_error = Some("未找到 omp，无法加载模型目录".into());
    }
    let ok = omp.omp_path.is_some() && models_error.is_none();
    Ok(HealthInfo { omp, models_error, ok })
}

// ---------- overlay ----------

#[tauri::command]
pub async fn get_overlay(state: State<'_, AppState>) -> Result<Overlay, CmdError> {
    Ok(state.overlay.lock().await.clone())
}

// ---------- 模型目录（唯一读取入口） ----------

/// 模型目录（`omp models --json`）的缓存有效期：过期后由读取方顺带**后台**刷新
/// （stale-while-revalidate），只有从未拉过时才阻塞等待。
pub const MODELS_TTL_MS: i64 = 5 * 60_000;
/// 目录快照刷新完成的事件通道（payload = `{models, fetchedAt}` 目录快照）。
/// 冷启动 / 后台刷新完成后广播——已挂载的设置页据此在原地换成新目录，不必自己轮询重拉。
pub const MODELS_EVENT: &str = "omp-models://catalog";

/// 快照是否仍在有效期内（纯函数，单测锁着）。
pub fn catalog_fresh(at: i64, now: i64) -> bool {
    now - at < MODELS_TTL_MS
}

/// 单飞 + SWR 的缓存读取核心（与 Tauri 解耦，单测锁着；[`load_catalog`] 是它的一个实例）。
///
/// - `force = false`：缓存新鲜（< `ttl_ms`）直接命中；过期才考虑真拉。
/// - 需要真拉的路径都先抢 `lock`（**单飞**）：等锁后二次检查——若缓存时间戳晚于本次请求
///   起点（别人刚拉完），直接复用，**不重复拉**。
pub(crate) async fn load_cached<T, E, F, Fut>(
    cache: &Mutex<Option<(i64, T)>>,
    lock: &Mutex<()>,
    force: bool,
    ttl_ms: i64,
    fetch: F,
) -> Result<T, E>
where
    T: Clone,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    let started = chrono::Utc::now().timestamp_millis();
    if !force {
        if let Some((at, v)) = cache.lock().await.clone() {
            if started - at < ttl_ms {
                return Ok(v);
            }
        }
    }
    let _guard = lock.lock().await;
    if let Some((at, v)) = cache.lock().await.clone() {
        // 等锁期间别人拉过：更新的（或仍然新鲜的）快照直接用，不再重复拉
        if at >= started || (!force && chrono::Utc::now().timestamp_millis() - at < ttl_ms) {
            return Ok(v);
        }
    }
    let v = fetch().await?;
    *cache.lock().await = Some((chrono::Utc::now().timestamp_millis(), v.clone()));
    Ok(v)
}

/// 模型目录的**唯一读取入口**（`get_models` / `refresh_models` / 健康检查 / 供应商页都走它）。
///
/// **为什么要单飞**：`omp models --json` 实测 2–10s（上游要拉各供应商的模型列表，抖动大），
/// 没有单飞时四个读取方会各起一个进程（实测设置页里最多并发三个）——总延迟按最慢的算，
/// CPU / 网络翻倍。
///
/// - `force = false`：快照新鲜（< [`MODELS_TTL_MS`]）直接命中；过期则真拉一次。
/// - `force = true`（用户点「刷新」）：必拉；但等锁期间若别人刚拉完（快照时间戳晚于本次
///   请求起点），直接用它——同一份数据不重复拉。
pub async fn load_catalog(
    state: &State<'_, AppState>,
    app: &AppHandle,
    force: bool,
) -> Result<serde_json::Value, CmdError> {
    load_cached(
        &state.models_cache,
        &state.models_fetch,
        force,
        MODELS_TTL_MS,
        || async {
            // omp 定位走 `discover_omp_path`（唯一入口：覆盖层 → 已发现的缓存 → 登录 shell → 常见路径），
            // 而不是诊断状态里的 `state.omp_path`——那个只在 `locate_omp` 成功后才非空，
            // 用它会让「诊断还没跑完 / 探测失败」连模型目录一起拖垮（供应商页与 ModelPicker 都会中招）。
            let Some(p) = discover_omp_path(state) else {
                return Err(cmd_err("OMP_MISSING", "未找到 omp，无法加载模型目录".into(), Some("请先安装 oh-my-pi".into())));
            };
            *state.omp_path.lock().await = Some(p.clone());
            // 拉取最长可到 10s：`run_cmd` 是同步子进程，放 `spawn_blocking` 别占 tokio 工作线程
            let out = tokio::task::spawn_blocking(move || run_cmd(&p, &["models", "--json"]))
                .await
                .map_err(|e| cmd_err("MODELS_FAILED", format!("模型目录加载失败：{e}"), Some("重试或检查网络".into())))?
                .map_err(|e| cmd_err("MODELS_FAILED", format!("模型目录加载失败：{e}"), Some("重试或检查网络".into())))?;
            let v: serde_json::Value =
                serde_json::from_str(&out).map_err(|e| cmd_err("MODELS_PARSE", format!("模型目录解析失败：{e}"), None))?;
            let catalog = serde_json::json!({
                "models": v.get("models").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                "fetchedAt": chrono::Utc::now().timestamp_millis(),
            });
            // 广播新快照：设置页（模型 / 供应商）据此在原地更新，不必自己重拉
            let _ = app.emit(MODELS_EVENT, &catalog);
            Ok(catalog)
        },
    )
    .await
}

/// SWR 读取：有快照立即返回（哪怕过期——过期时顺带起一次**后台**刷新，完成后广播事件）；
/// 从未拉过才阻塞等待。
///
/// 给「目录是参考信息、不该拖慢页面」的调用方用（健康检查 / 供应商页的已配置标记）：
/// `omp models --json` 2–10s，等它只会让页面白等。
pub async fn catalog_swr(
    state: &State<'_, AppState>,
    app: &AppHandle,
) -> Result<serde_json::Value, CmdError> {
    let cached = state.models_cache.lock().await.clone();
    match cached {
        Some((at, v)) => {
            if !catalog_fresh(at, chrono::Utc::now().timestamp_millis()) {
                spawn_catalog_refresh(app);
            }
            Ok(v)
        }
        None => load_catalog(state, app, false).await,
    }
}

/// 起一次后台目录刷新（不等待）。已有拉取在飞时，[`load_catalog`] 会等锁后直接复用结果。
pub fn spawn_catalog_refresh(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let _ = load_catalog(&state, &app, false).await;
    });
}

// ---------- 模型 ----------

#[tauri::command]
pub async fn get_models(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, CmdError> {
    load_catalog(&state, &app, false).await
}

#[tauri::command]
pub async fn refresh_models(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, CmdError> {
    load_catalog(&state, &app, true).await
}

// ---------- 项目 ----------

#[derive(Debug, Clone, Serialize)]
pub struct ProjectView {
    pub id: String,
    pub path: String,
    pub name: String,
    pub missing: bool,
    #[serde(rename = "sessionCount")]
    pub session_count: usize,
    /// 所属工作区（V21）；null = 未分组。
    #[serde(rename = "workspaceId")]
    pub workspace_id: Option<String>,
}

/// 项目视图：**等锁**而不是 try_lock 返回空。挂载时 `list_projects` / `list_checkouts` /
/// `list_sessions` 并发进来，每个入口都会先做一次外部改名对账（持有 overlay 锁写盘）；
/// 老实现 try_lock 失败就返回空列表，前端会把「项目还在」误判成全部消失。
/// 计数扫描在锁外做，避免长时间占着覆盖层。
async fn project_views(state: &State<'_, AppState>) -> Vec<ProjectView> {
    let (projects, sessions_root) = {
        let ov = state.overlay.lock().await;
        let sessions_root = state.agent_dir.lock().await.join("sessions");
        (ov.projects.clone(), sessions_root)
    };
    projects
        .iter()
        .map(|p| {
            let name = std::path::Path::new(&p.path)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(&p.path)
                .to_string();
            let missing = !std::path::Path::new(&p.path).exists();
            let count = count_sessions_for(&sessions_root, &p.path);
            ProjectView { id: p.id.clone(), path: p.path.clone(), name, missing, session_count: count, workspace_id: p.workspace_id.clone() }
        })
        .collect()
}

fn count_sessions_for(root: &std::path::Path, project_path: &str) -> usize {
    let mut n = 0;
    let Ok(rd) = std::fs::read_dir(root) else { return 0 };
    for entry in rd.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&dir) else { continue };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            // 只读前 64KB 找 session.cwd
            let Ok(text) = read_head_text(&p, 65536) else { continue };
            for line in text.lines().take(40) {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                if v.get("type").and_then(|t| t.as_str()) == Some("session") {
                    let cwd = v.get("cwd").and_then(|c| c.as_str()).unwrap_or("");
                    if project_of(cwd, &[project_path.to_string()]).is_some() {
                        n += 1;
                    }
                    break;
                }
            }
        }
    }
    n
}

fn read_head_text(p: &std::path::Path, limit: usize) -> std::io::Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(p)?;
    let mut buf = vec![0u8; limit];
    let n = f.read(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf[..n]).to_string())
}

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> Result<Vec<ProjectView>, CmdError> {
    // 外部改名 / 移动后，先把失联项目的路径找回来，再按新路径派生名字与会话数。
    sync_project_paths(&state).await;
    Ok(project_views(&state).await)
}

/// 轻量对账入口（前端可见时轮询）：只 stat 项目路径 / 必要时按身份链找回，
/// 不扫会话、不跑 git；返回项目路径是否有变化，由前端决定是否重拉侧栏。
#[tauri::command]
pub async fn reconcile_projects(state: State<'_, AppState>) -> Result<bool, CmdError> {
    Ok(sync_project_paths(&state).await)
}

#[tauri::command]
pub async fn add_project(state: State<'_, AppState>, path: String) -> Result<ProjectView, CmdError> {
    let norm = normalize_path(&path);
    let md = std::fs::metadata(&norm).map_err(|_| cmd_err("DIR_MISSING", "目录不存在，只能移除或重定位".into(), None))?;
    if !md.is_dir() {
        return Err(cmd_err("NOT_DIR", "所选路径不是目录".into(), None));
    }
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok();
    if let Some(home) = home {
        if normalize_path(&home) == norm {
            return Err(cmd_err("HOME_ROOT", "不能把用户主目录作为项目".into(), None));
        }
    }
    {
        let mut ov = state.overlay.lock().await;
        if let Some(exist) = ov.projects.iter().find(|p| normalize_path(&p.path) == norm) {
            let id = exist.id.clone();
            drop(ov);
            return project_views(&state).await.into_iter().find(|v| v.id == id).ok_or(cmd_err("INTERNAL", "项目状态不一致".into(), None));
        }
        let id = format!("p{}", chrono::Utc::now().timestamp_millis());
        let path_ids = crate::project_paths::path_chain(std::path::Path::new(&norm)).unwrap_or_default();
        ov.projects.push(Project { id: id.clone(), path: norm.clone(), added_at: chrono::Utc::now().timestamp_millis(), last_model: None, last_thinking: None, workspace_id: None, path_ids });
    }
    save_overlay(&state).map_err(|e| cmd_err("OVERLAY_WRITE", e, None))?;
    project_views(&state).await.into_iter().find(|v| v.path == norm).ok_or(cmd_err("INTERNAL", "项目状态不一致".into(), None))
}

#[tauri::command]
pub async fn remove_project(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), CmdError> {
    // 语义（对齐“删除工作区”）：仅解绑项目，不删任何会话文件；
    // 该项目下全部会话标记归档保留（删后进“未归属会话”），备注/权限覆盖一并保留。
    let proj_path = {
        let ov = state.overlay.lock().await;
        let Some(proj) = ov.projects.iter().find(|p| p.id == id) else {
            return Err(cmd_err("NOT_FOUND", "项目不存在".into(), None));
        };
        proj.path.clone()
    };
    // 以后端扫描为准找该项目会话（读 jsonl 头 cwd 前缀匹配，不猜 slug）
    let agent = state.agent_dir.lock().await.clone();
    let sids = session_ids_for(&agent.join("sessions"), &proj_path);
    // 聊天形态：该项目下的长驻会话进程先停（逐个通知 idle + kill_runtime，不阻塞落盘）
    for sid in &sids {
        crate::remote::emit_event(&app, &format!("omp-status://{sid}"), &serde_json::json!({"state":"idle"}));
        kill_runtime(&state, sid);
    }
    {
        let mut ov = state.overlay.lock().await;
        ov.projects.retain(|p| p.id != id);
        for sid in sids {
            ov.archived.insert(sid, true);
        }
    }
    save_overlay(&state).map_err(|e| cmd_err("OVERLAY_WRITE", e, None))?;
    Ok(())
}

fn session_ids_for(root: &std::path::Path, project_path: &str) -> Vec<String> {
    let mut out = vec![];
    let Ok(rd) = std::fs::read_dir(root) else { return out };
    for entry in rd.flatten() {
        let Ok(files) = std::fs::read_dir(entry.path()) else { continue };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let head = parse_session_head(&p);
            if !head.corrupt && project_of(&head.cwd, &[project_path.to_string()]).is_some() {
                out.push(head.id);
            }
        }
    }
    out
}

#[tauri::command]
pub async fn relocate_project(state: State<'_, AppState>, id: String, path: String) -> Result<ProjectView, CmdError> {
    let norm = normalize_path(&path);
    if !std::path::Path::new(&norm).is_dir() {
        return Err(cmd_err("DIR_MISSING", "目录不存在，只能移除或重定位".into(), None));
    }
    {
        let mut ov = state.overlay.lock().await;
        let Some(p) = ov.projects.iter_mut().find(|p| p.id == id) else {
            return Err(cmd_err("NOT_FOUND", "项目不存在".into(), None));
        };
        p.path = norm;
        p.path_ids = crate::project_paths::path_chain(std::path::Path::new(&p.path)).unwrap_or_default();
    }
    save_overlay(&state).map_err(|e| cmd_err("OVERLAY_WRITE", e, None))?;
    project_views(&state).await.into_iter().find(|v| v.id == id).ok_or(cmd_err("INTERNAL", "项目状态不一致".into(), None))
}

// ---------- 目录行（V21：项目主目录 + git worktree；原「工作区行」） ----------

/// 左栏目录行：项目主目录或它的一个 git worktree。
///
/// V21 起「工作区」指多项目容器（见下方 workspace 命令），这里改名为目录行；
/// 字段与语义与旧 `WorkspaceView` 完全一致（只读展示，真相 = `git worktree list`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutView {
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "projectName")]
    pub project_name: String,
    /// 工作目录：主目录 = 项目路径；worktree = worktree 路径。
    pub path: String,
    /// 检出的分支；detached / 非 git 仓库为 null。
    pub branch: Option<String>,
    /// detached 时的短 sha（用于展示「游离」）。
    pub head: Option<String>,
    /// 主目录（项目本体）还是 worktree。
    #[serde(rename = "isMain")]
    pub is_main: bool,
    /// 目录不存在（worktree 被手工删掉 / 项目目录被移走）。
    pub missing: bool,
}

fn project_display_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string()
}

/// 左栏树数据源：每个项目 = 主目录行 + 该仓库的全部 worktree 行（只读展示）。
///
/// worktree 真相 = `git worktree list --porcelain`（手工 `git worktree add` 的也在），
/// 而不是 `omp worktree list`（只登记 `~/.omp/wt` 下的）。
#[tauri::command]
pub async fn list_checkouts(state: State<'_, AppState>) -> Result<Vec<CheckoutView>, CmdError> {
    // 先跟随外部改名：目录行 / git worktree 查询都必须用新路径。
    sync_project_paths(&state).await;
    let projects: Vec<(String, String, String)> = {
        let ov = state.overlay.lock().await;
        ov.projects.iter().map(|p| (p.id.clone(), p.path.clone(), project_display_name(&p.path))).collect()
    };
    let git = crate::git_info::git_bin().await;
    let mut out: Vec<CheckoutView> = vec![];
    for (id, path, name) in projects {
        let missing = !std::path::Path::new(&path).is_dir();
        let wts = match (&git, missing) {
            (Some(g), false) => crate::git_info::list_worktrees(g, &path).await,
            _ => vec![],
        };
        // 主目录行的分支取 porcelain 第一块（git 约定第一块是主 worktree）；
        // 路径仍用项目自己的写法（git 回读的可能是 /private 归一后的形式）。
        let main = wts.first();
        out.push(CheckoutView {
            project_id: id.clone(),
            project_name: name.clone(),
            path: path.clone(),
            branch: main.and_then(|w| w.branch.clone()),
            head: main.and_then(|w| w.head.clone()),
            is_main: true,
            missing,
        });
        for w in wts.iter().skip(1) {
            if w.path == path || !std::path::Path::new(&w.path).is_dir() {
                continue;
            }
            out.push(CheckoutView {
                project_id: id.clone(),
                project_name: name.clone(),
                path: w.path.clone(),
                branch: w.branch.clone(),
                head: w.head.clone(),
                is_main: false,
                missing: false,
            });
        }
    }
    Ok(out)
}

// ---------- 工作区（V21：多项目容器） ----------

/// 左栏工作区：多项目容器。成员关系存在 `Project.workspace_id` 上（唯一归属），
/// 这里返回的 `project_ids` 按左栏顺序（`overlay.projects` 的数组顺序；V26 起可在左栏拖拽调整）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceView {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    /// 成员项目 id；空组合法（先建组、后加项目）。
    pub project_ids: Vec<String>,
}

fn workspace_views(ov: &Overlay) -> Vec<WorkspaceView> {
    ov.workspaces
        .iter()
        .map(|w| WorkspaceView {
            id: w.id.clone(),
            name: w.name.clone(),
            created_at: w.created_at,
            project_ids: ov
                .projects
                .iter()
                .filter(|p| p.workspace_id.as_deref() == Some(w.id.as_str()))
                .map(|p| p.id.clone())
                .collect(),
        })
        .collect()
}

/// 工作区名清洗：去首尾空白；内部换行 / 制表符折成空格（名字会进注入文本与左栏）。
pub fn clean_workspace_name(raw: &str) -> String {
    raw.chars()
        .map(|c| if c == '\n' || c == '\r' || c == '\t' { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

/// 成员重设：`project_ids` 里的项目设为工作区 `wid` 成员，其余原成员移出（回归未分组）。
/// 不存在的项目 id 静默忽略（前端列表可能过期）；一个项目只会属于一个工作区——
/// 若它原本在别的组里，归属直接改到本组。
fn assign_members(ov: &mut Overlay, wid: &str, project_ids: &[String]) {
    for p in &mut ov.projects {
        if project_ids.iter().any(|id| id == &p.id) {
            p.workspace_id = Some(wid.to_string());
        } else if p.workspace_id.as_deref() == Some(wid) {
            p.workspace_id = None;
        }
    }
}

#[tauri::command]
pub async fn list_workspaces(state: State<'_, AppState>) -> Result<Vec<WorkspaceView>, CmdError> {
    let ov = state.overlay.lock().await;
    Ok(workspace_views(&ov))
}

#[tauri::command]
pub async fn create_workspace(
    state: State<'_, AppState>,
    name: String,
    project_ids: Vec<String>,
) -> Result<WorkspaceView, CmdError> {
    let name = clean_workspace_name(&name);
    if name.is_empty() {
        return Err(cmd_err("BAD_ARG", "工作区名不能为空".into(), None));
    }
    let id = format!("w{}", chrono::Utc::now().timestamp_millis());
    let view = {
        let mut ov = state.overlay.lock().await;
        ov.workspaces.push(Workspace { id: id.clone(), name, created_at: chrono::Utc::now().timestamp_millis() });
        assign_members(&mut ov, &id, &project_ids);
        workspace_views(&ov)
            .into_iter()
            .find(|w| w.id == id)
            .ok_or_else(|| cmd_err("INTERNAL", "工作区状态不一致".into(), None))?
    };
    save_overlay(&state).map_err(|e| cmd_err("OVERLAY_WRITE", e, None))?;
    Ok(view)
}

/// 一次写全：改名 + 成员重设（编辑对话框的两个字段同时提交）。
/// 项目移出本组即回归未分组——不删项目、不动任何文件。
#[tauri::command]
pub async fn update_workspace(
    state: State<'_, AppState>,
    id: String,
    name: String,
    project_ids: Vec<String>,
) -> Result<(), CmdError> {
    let name = clean_workspace_name(&name);
    if name.is_empty() {
        return Err(cmd_err("BAD_ARG", "工作区名不能为空".into(), None));
    }
    {
        let mut ov = state.overlay.lock().await;
        let Some(w) = ov.workspaces.iter_mut().find(|w| w.id == id) else {
            return Err(cmd_err("NOT_FOUND", "工作区不存在".into(), None));
        };
        w.name = name;
        assign_members(&mut ov, &id, &project_ids);
    }
    save_overlay(&state).map_err(|e| cmd_err("OVERLAY_WRITE", e, None))?;
    Ok(())
}

/// 删组：成员项目回归未分组（不删项目、不删文件、不杀终端）。
#[tauri::command]
pub async fn delete_workspace(state: State<'_, AppState>, id: String) -> Result<(), CmdError> {
    {
        let mut ov = state.overlay.lock().await;
        let before = ov.workspaces.len();
        ov.workspaces.retain(|w| w.id != id);
        if ov.workspaces.len() == before {
            return Err(cmd_err("NOT_FOUND", "工作区不存在".into(), None));
        }
        for p in &mut ov.projects {
            if p.workspace_id.as_deref() == Some(id.as_str()) {
                p.workspace_id = None;
            }
        }
    }
    save_overlay(&state).map_err(|e| cmd_err("OVERLAY_WRITE", e, None))?;
    Ok(())
}

/// 左栏拖拽落地（V26）：把一个项目移动到目标工作区（`workspace_id = None` = 未分组）并同步全局顺序。
///
/// `order` = 拖拽后的**全部项目 id 顺序**（左栏顺序 = 覆盖层 `projects` 的数组顺序）：
/// 认不得的 id 忽略、缺席的项目按原相对顺序补到末尾——任何输入都不丢项目（前端传的是全量列表）。
/// 归属与顺序一次写完：拖进 / 拖出工作区与组内排序是同一次操作的两个面。
#[tauri::command]
pub async fn move_project(
    state: State<'_, AppState>,
    id: String,
    workspace_id: Option<String>,
    order: Vec<String>,
) -> Result<Vec<ProjectView>, CmdError> {
    {
        let mut ov = state.overlay.lock().await;
        if !ov.projects.iter().any(|p| p.id == id) {
            return Err(cmd_err("NOT_FOUND", "项目不存在".into(), None));
        }
        if let Some(w) = &workspace_id {
            if !ov.workspaces.iter().any(|g| &g.id == w) {
                return Err(cmd_err("NOT_FOUND", "工作区不存在".into(), None));
            }
        }
        let projects = std::mem::take(&mut ov.projects);
        let mut projects = apply_project_order(projects, &order);
        if let Some(p) = projects.iter_mut().find(|p| p.id == id) {
            p.workspace_id = workspace_id;
        }
        ov.projects = projects;
    }
    save_overlay(&state).map_err(|e| cmd_err("OVERLAY_WRITE", e, None))?;
    Ok(project_views(&state).await)
}

/// 按 `order` 重排项目：认得的 id 按序在前，缺席的按原相对顺序补末尾（防御脏输入，不丢项目）。
fn apply_project_order(projects: Vec<Project>, order: &[String]) -> Vec<Project> {
    let mut rest = projects;
    let mut out: Vec<Project> = Vec::with_capacity(rest.len());
    for id in order {
        if let Some(pos) = rest.iter().position(|p| p.id == *id) {
            out.push(rest.remove(pos));
        }
    }
    out.extend(rest);
    out
}

/// 归属匹配集：项目路径 ∪ 其全部 worktree 路径（同 project id）。
/// V11：终端工作区在 worktree 里开的会话（jsonl cwd = worktree 目录）必须归到所属项目——
/// 否则会话弹窗与归档清单都看不见它们（掉进「未归属」）。
pub async fn ownership_scope(projects: &[(String, String)]) -> Vec<(String, String)> {
    let mut out = projects.to_vec();
    let Some(git) = crate::git_info::git_bin().await else { return out };
    for (id, path) in projects {
        if !std::path::Path::new(path).is_dir() {
            continue;
        }
        for wt in crate::git_info::list_worktrees(&git, path).await {
            if !wt.main && !wt.path.is_empty() {
                out.push((id.clone(), wt.path));
            }
        }
    }
    out
}

// ---------- 会话 ----------

#[derive(Debug, Clone, Serialize)]
pub struct SessionView {
    pub id: String,
    #[serde(rename = "projectId")]
    pub project_id: Option<String>,
    pub title: String,
    pub cwd: String,
    pub timestamp: i64,
    pub archived: bool,
    pub corrupt: bool,
    pub note: Option<String>,
    /// 是否有长驻聊天进程（V32；终端形态不看这个字段，聊天形态列表行标记「运行中」）。
    pub running: bool,
    /// 新建会话时**参数被 omp 拒绝而降级**的说明（`create_session` 专有；其余路径为 `None`）。
    /// 之所以让它随视图回传：前端在会话内追加一条本地说明（消息流已有的反馈位），
    /// 用户才知道「为什么这次没用上次的模型」（无提示的静默降级比报错更难排查）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<FallbackNotice>,
}

/// 降级说明：哪些启动参数在 omp 侧已经不成立（覆盖层里留着的失效偏好）。
///
/// 判断依据是**新进程实际用什么起来**的：降级后进程没拿到模型 ⇒ omp 默认模型本身不可用，
/// 此时不把责任推给参数（`fallback_model` 置否、`detail` 带上原始报错）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct FallbackNotice {
    /// 失效的模型（`--model` 被 omp 拒绝）。
    pub model: Option<String>,
    /// 失效的思考档（`--thinking` 被 omp 拒绝）。
    pub thinking: Option<String>,
    /// 降级后 omp 是否真的用上了模型（否 = 默认档也不可用，原因见 `detail`）。
    pub fallback_model: bool,
    /// omp 自己写的报错首行（诊断用）。
    pub detail: Option<String>,
}

/// 显示标题的兜底链：备注 > omp 真标题 > 首条用户消息派生的短标题 > 「未命名会话 MM-DD」。
///
/// 派生档（V44）：omp 在 `--mode rpc-ui` 下**关闭自动标题**（二进制实测
/// `PI_NO_TITLE=1`，TUI 才有），聊天形态会话在壳侧补标题完成前一直是空标题——
/// 派生标题让列表 / 顶栏立刻有可读名字（与前端 `fallbackTitleFromText` 同口径：
/// 折叠空白、取前 12 字、超长加省略号）；omp 真标题（`/rename` / 用户改名）一到就顶掉它。
fn display_title(note: Option<&String>, head_title: &str, first_user_text: Option<&str>, ts: i64) -> String {
    if let Some(n) = note {
        if !n.trim().is_empty() {
            return n.clone();
        }
    }
    if !head_title.trim().is_empty() {
        return head_title.to_string();
    }
    if let Some(t) = first_user_text.and_then(derived_title) {
        return t;
    }
    format!("未命名会话 {}", chrono::DateTime::from_timestamp_millis(ts).map(|d| d.format("%m-%d").to_string()).unwrap_or_default())
}

/// 首条用户消息 → 短标题（前 12 字 + 省略号；与前端 `fallbackTitleFromText` 同口径）。
fn derived_title(text: &str) -> Option<String> {
    let clean = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.is_empty() {
        return None;
    }
    if clean.chars().count() <= 12 {
        return Some(clean);
    }
    Some(format!("{}…", clean.chars().take(12).collect::<String>()))
}

/// 会话列表分页（V2 M7a）：`totalFiles` = sessions 目录下的 jsonl 总数，
/// `scannedFiles` = 本次真正解析头部的文件数（默认最近 500 个）。
/// 前端据此显示「已扫描最近 N 个（共 M 个）」并允许继续加载更老的会话。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    pub sessions: Vec<SessionView>,
    pub total_files: usize,
    pub scanned_files: usize,
}

/// 扫描窗口：`limit` 默认 500、夹在 1..=5000；`offset` 无上限（超出即空窗口）。
pub fn scan_window(limit: Option<usize>, offset: Option<usize>) -> (usize, usize) {
    let limit = limit.unwrap_or(500).clamp(1, 5000);
    (limit, offset.unwrap_or(0))
}

/// 列表「运行中」标记快照（`SessionView.running` 的唯一数据源）：只反映**任务在跑**
/// （agent 干活 / 等审批，见 [`crate::runtime::activity_is_busy`]），不是"进程在壳里"。
/// 常驻进程会把打开过的会话一直留在进程表里——「打开过」不是「在跑」，跑完的任务
/// 不许继续转圈；spawn 时刻活动态初值就是 idle，刚打开的空转会话天然不亮。
async fn running_snapshot(state: &State<'_, AppState>) -> HashMap<String, bool> {
    let rt = state.runtime.lock().await;
    rt.iter()
        .map(|(sid, c)| (sid.clone(), crate::runtime::activity_is_busy(c.activity.state())))
        .collect()
}

#[tauri::command]
pub async fn list_sessions(
    state: State<'_, AppState>,
    project_id: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<SessionPage, CmdError> {
    // 外部改名后先更新项目路径，再按新路径计算会话归属（否则列表把新目录里的会话算成未归属）。
    sync_project_paths(&state).await;
    // 列表「运行中」快照从进程表的活动态生成（唯一真值；见 running_snapshot）。
    // 先取快照再锁 overlay：与 fork 路径（runtime → overlay）保持同一把锁顺序。
    let running = running_snapshot(&state).await;
    let ov = state.overlay.lock().await;
    let agent = state.agent_dir.lock().await.clone();
    let paths: Vec<(String, String)> = ov.projects.iter().map(|p| (p.id.clone(), p.path.clone())).collect();
    // 只列某个项目的会话：按 id 过滤（归属已算成 id，不必再拿路径比一遍）
    let only: Option<String> = project_id.filter(|pid| ov.projects.iter().any(|p| p.id == *pid));
    drop(ov);
    // 归属匹配集含工作区 worktree：在 worktree 里跑的会话也归到项目（V11）
    let scope = ownership_scope(&paths).await;
    let mut out: Vec<SessionView> = vec![];
    // 损坏文件也列出（M1-1 要求可删）：按文件兜底一行
    let root = agent.join("sessions");
    // 规模保护（V2 M7a 起可分页）：sessions 目录按修改时间倒序取「窗口」再解析。
    // 共享 agentDir / 长期使用后动辄上千个会话文件，逐个读头尾也会拖慢列表；
    // 列表本来就按时间倒序展示，窗口外都是更老的会话——前端用 `scannedFiles/totalFiles`
    // 告诉用户还有多少没扫，并按 500 递增重扫。
    let (limit, offset) = scan_window(limit, offset);
    let mut candidates: Vec<(std::time::SystemTime, PathBuf)> = vec![];
    let Ok(rd) = std::fs::read_dir(&root) else {
        return Ok(SessionPage { sessions: out, total_files: 0, scanned_files: 0 });
    };
    for entry in rd.flatten() {
        let Ok(files) = std::fs::read_dir(entry.path()) else { continue };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let mtime = f.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
            candidates.push((mtime, p));
        }
    }
    let total_files = candidates.len();
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    if total_files > limit + offset {
        eprintln!(
            "[list_sessions] 共 {} 个会话文件，本次窗口 offset={} limit={}",
            total_files, offset, limit
        );
    }
    let window: Vec<(std::time::SystemTime, PathBuf)> =
        candidates.into_iter().skip(offset).take(limit).collect();
    let scanned_files = window.len();
    for (_mtime, p) in window {
        {
            let head = parse_session_head(&p);
            let ov = state.overlay.lock().await;
            if head.corrupt {
                out.push(SessionView {
                    id: head.id.clone(),
                    project_id: None,
                    title: "已损坏，可删除".into(),
                    cwd: String::new(),
                    timestamp: 0,
                    archived: false,
                    corrupt: true,
                    note: None,
                    running: false,
                    notice: None,
                });
                continue;
            }
            let owner = owner_project(&scope, &head.cwd);
            if let Some(want) = &only {
                if owner.as_deref() != Some(want.as_str()) {
                    continue;
                }
            }
            let archived = ov.archived.get(&head.id).copied().unwrap_or(false);
            let note = ov.notes.get(&head.id).cloned();
            out.push(SessionView {
                title: display_title(note.as_ref(), &head.title, head.first_user_text.as_deref(), head.timestamp),
                project_id: owner,
                cwd: head.cwd.clone(),
                timestamp: head.timestamp,
                archived,
                corrupt: false,
                note,
                running: running.get(&head.id).copied().unwrap_or(false),
                notice: None,
                id: head.id.clone(),
            });
        }
    }
    // runtime 里可能有「刚建好、尚未落盘」的会话（omp 懒写盘）：扫磁盘当然扫不到，但列表
    // 不能因此把刚新建的会话抹掉（切换项目等任何一次刷新都会丢行）——按 spawn 事实补一行。
    {
        let candidates: Vec<(String, String, i64)> = {
            let rt = state.runtime.lock().await;
            rt.iter().map(|(sid, c)| (sid.clone(), c.cwd.clone(), c.created_ms)).collect()
        };
        if !candidates.is_empty() {
            let ov = state.overlay.lock().await;
            for v in unlanded_views(&agent, &candidates, &scope, &ov.notes, &running) {
                if out.iter().any(|s| s.id == v.id) {
                    continue;
                }
                if let Some(want) = &only {
                    if v.project_id.as_deref() != Some(want.as_str()) {
                        continue;
                    }
                }
                out.push(v);
            }
        }
    }
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(SessionPage { sessions: out, total_files, scanned_files })
}

/// 已归档对话清单（设置页「已归档对话」tab）。
///
/// 与 `list_sessions` 的关键差别：**不受扫描窗口限制**。归档是管理面——归档的意义就是
/// 把老会话收起来，它们大概率落在窗口之外，被窗口截掉等于「归档即失踪」。所以这里不看
/// mtime 窗口，只按覆盖层 `archived` 标记逐个定位文件。代价可控：**只读那些文件名里带
/// 归档 id 前缀的文件**（与 `session_file_for` 同一套约定），不做全量头部解析。
#[tauri::command]
pub async fn list_archived_sessions(state: State<'_, AppState>) -> Result<Vec<SessionView>, CmdError> {
    let ov = state.overlay.lock().await;
    let archived = ov.archived.clone();
    let notes = ov.notes.clone();
    let projects: Vec<(String, String)> = ov.projects.iter().map(|p| (p.id.clone(), p.path.clone())).collect();
    drop(ov);
    let agent = state.agent_dir.lock().await.clone();
    // 归属匹配集含 worktree（与 list_sessions 同一口径）
    let scope = ownership_scope(&projects).await;
    let running = running_snapshot(&state).await;
    Ok(list_archived_in(&agent.join("sessions"), &archived, &scope, &running, &notes))
}

/// 归档清单核心（不碰 tauri，可在临时目录上做真实行为测试）。
/// `archived` 里 value 为 true 的 id 才算归档；覆盖层里残留的失效 id（文件已被删）自然落空。
pub fn list_archived_in(
    root: &std::path::Path,
    archived: &HashMap<String, bool>,
    projects: &[(String, String)],
    running: &HashMap<String, bool>,
    notes: &HashMap<String, String>,
) -> Vec<SessionView> {
    let wanted: Vec<&String> = archived.iter().filter(|(_, v)| **v).map(|(id, _)| id).collect();
    if wanted.is_empty() {
        return vec![];
    }
    let Ok(rd) = std::fs::read_dir(root) else { return vec![] };
    let mut out: Vec<SessionView> = vec![];
    for entry in rd.flatten() {
        let Ok(files) = std::fs::read_dir(entry.path()) else { continue };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            // 文件名主干带完整会话 id（真实布局：`sessions/<slug>/<时间戳>_<id>.jsonl`，
            // 与 `session_file_for` 同一套约定）。**不用 8 字符前缀**：同一分钟建的两个
            // 会话前缀相同，前缀过滤会把无关文件也读进来（那头里的 id 复核能挡住错行，
            // 但没必要读）；用整条路径比以免漏掉 id 落在目录名上的情况。
            let full = path.to_string_lossy();
            if !wanted.iter().any(|id| !id.is_empty() && full.contains(id.as_str())) {
                continue;
            }
            let head = parse_session_head(&path);
            // 文件名前缀可能撞车，以头里的 id 为准再核一次归档标记
            if head.corrupt || !archived.get(&head.id).copied().unwrap_or(false) {
                continue;
            }
            let pid = owner_project(projects, &head.cwd);
            let note = notes.get(&head.id).cloned();
            out.push(SessionView {
                title: display_title(note.as_ref(), &head.title, head.first_user_text.as_deref(), head.timestamp),
                project_id: pid,
                cwd: head.cwd.clone(),
                timestamp: head.timestamp,
                archived: true,
                corrupt: false,
                note,
                running: running.get(&head.id).copied().unwrap_or(false),
                notice: None,
                id: head.id.clone(),
            });
        }
    }
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    out
}

/// 按**完整会话 id** 在 sessions 树里定位 jsonl（真实布局 `sessions/<slug>/<ISO 时间戳>_<id>.jsonl`）。
///
/// 只认完整 id（`stem == id` 或 `stem` 以 `_<id>` 结尾），**不许退回 8 字符前缀**——
/// uuid v7 的前 8 个字符是毫秒时间戳的高 32 位，**同一分钟内建的两个会话前 8 位必然相同**
/// （真机实测：`01a123c6-9b8c…` 与 `01a123c6-f958…`，同一分钟里建的两个聊天会话）。
/// 前缀匹配会命中「文件名最大」的那个 = **另一个会话**：读历史读错文件、删除删错文件、
/// `--resume <前缀>` 拉起另一个会话（omp 侧同口径取最新，实测），正在跑的会话还会被
/// 同 id 补位顶掉（进行中的轮次被中止，用户侧表现就是「切换会话把会话打断」）。
///
/// `id` 也允许是 `parse_session_head` 损坏兜底给的文件名主干（`<时间戳>_<id>`）——
/// 那一支由 `stem == id` 兼容。同一 id 命中多个 slug 目录时取字典序最大的整条路径（新目录）。
pub(crate) fn session_file_for(agent: &std::path::Path, id: &str) -> Option<PathBuf> {
    if id.is_empty() {
        return None;
    }
    let suffix = format!("_{id}");
    let mut best: Option<PathBuf> = None;
    let Ok(rd) = std::fs::read_dir(agent.join("sessions")) else { return None };
    for entry in rd.flatten() {
        let Ok(files) = std::fs::read_dir(entry.path()) else { continue };
        for f in files.flatten() {
            let p = f.path();
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            let Some(stem) = name.strip_suffix(".jsonl") else { continue };
            if stem != id && !stem.ends_with(&suffix) {
                continue;
            }
            if best.as_ref().map(|b| p > *b).unwrap_or(true) {
                best = Some(p);
            }
        }
    }
    best
}

/// 会话归属判定的**唯一入口**（新建 / 打开 / 归档清单共用）：
/// 按 `project_of` 的真实路径前缀匹配（最长优先、符号链接展开），与 `list_sessions`
/// 同一条规则。此前这三处各写一遍「路径精确相等」，规则一旦分叉，左栏按前缀归组、
/// 命令回包却给 null，刚建好的会话就会掉进「未归属」。
///
/// `projects` = `(项目 id, 项目路径)` 列表；`project_of` 回传的是原始路径串，按串取 id。
pub fn owner_project(projects: &[(String, String)], cwd: &str) -> Option<String> {
    let paths: Vec<String> = projects.iter().map(|p| p.1.clone()).collect();
    let owner = project_of(cwd, &paths)?;
    projects.iter().find(|p| p.1 == owner).map(|p| p.0.clone())
}

/// 等锁版 kill：`kill_runtime` 的 `try_lock` 在锁被占时**会静默跳过移除**
/// （同步路径可接受：下次打开会 resume），但归档 / 删除 / 重启这类路径不行——旧 key
/// 留在表里，会话会被列表刷新补回来或状态收敛错位。语义与 `kill_runtime` 一致
/// （哨兵 → stdin 关闭 → 进程退出）。
async fn kill_runtime_awaited(state: &State<'_, AppState>, id: &str) {
    let mut m = state.runtime.lock().await;
    if let Some(r) = m.remove(id) {
        let _ = r.tx.send(String::new());
    }
}

/// 批量归档：逐个标记 archived=true，一次落盘；返回成功数与失败明细。
#[tauri::command]
pub async fn archive_sessions(state: State<'_, AppState>, ids: Vec<String>) -> Result<serde_json::Value, CmdError> {
    if ids.is_empty() {
        return Err(cmd_err("BAD_ARG", "未选中任何会话".into(), None));
    }
    if ids.len() > 200 {
        return Err(cmd_err("BAD_ARG", "一次最多归档 200 个会话".into(), None));
    }
    let mut ok = 0usize;
    // 归档只改覆盖层键，逐个都不该失败；失败明细字段保留为空，与 delete_sessions 的返回结构对齐
    let failed: Vec<serde_json::Value> = vec![];
    // 聊天形态：先停这批会话的长驻进程（归档 = 收起来；进程继续跑没有意义，还会占内存）。
    // 用等锁版：`kill_runtime` 的 `try_lock` 在锁被占时会静默跳过移除，进程还活着的
    // 会话会在下一次列表刷新里被「未落盘补行」补出来（行又冒出来）。
    for id in &ids {
        kill_runtime_awaited(&state, id).await;
    }
    {
        let mut ov = state.overlay.lock().await;
        for id in &ids {
            ov.archived.insert(id.clone(), true);
            ok += 1;
        }
    }
    save_overlay(&state).map_err(|e| cmd_err("OVERLAY_WRITE", e, None))?;
    Ok(serde_json::json!({ "ok": ok, "failed": failed }))
}

/// 批量取消归档（设置页「恢复」用）：逐个摘掉覆盖层标记，一次落盘；
/// 返回结构与 `archive_sessions` 对齐（`ok` / `failed`）。
/// 幂等：对没归档过的 id 也返回成功，不因重复点击报错。
#[tauri::command]
pub async fn unarchive_sessions(state: State<'_, AppState>, ids: Vec<String>) -> Result<serde_json::Value, CmdError> {
    if ids.is_empty() {
        return Err(cmd_err("BAD_ARG", "未选中任何会话".into(), None));
    }
    if ids.len() > 200 {
        return Err(cmd_err("BAD_ARG", "一次最多恢复 200 个会话".into(), None));
    }
    let mut ok = 0usize;
    {
        let mut ov = state.overlay.lock().await;
        for id in &ids {
            ov.archived.remove(id);
            ok += 1;
        }
    }
    save_overlay(&state).map_err(|e| cmd_err("OVERLAY_WRITE", e, None))?;
    Ok(serde_json::json!({ "ok": ok, "failed": Vec::<serde_json::Value>::new() }))
}

/// 批量删除：逐个删文件 + 清覆盖层键，一次落盘；返回成功数与失败明细。
#[tauri::command]
pub async fn delete_sessions(state: State<'_, AppState>, ids: Vec<String>) -> Result<serde_json::Value, CmdError> {
    if ids.is_empty() {
        return Err(cmd_err("BAD_ARG", "未选中任何会话".into(), None));
    }
    if ids.len() > 200 {
        return Err(cmd_err("BAD_ARG", "一次最多删除 200 个会话".into(), None));
    }
    let mut ok = 0usize;
    let mut failed: Vec<serde_json::Value> = vec![];
    // 聊天形态：先停再删（进程若还在写盘，删掉的文件会被重新创建）。
    // 用等锁版：`kill_runtime` 的 `try_lock` 在锁被占时会静默跳过移除——进程没停、
    // 表里条目还在，下一次列表刷新就会给刚删掉的会话补一行（看着像删除又造了一个会话）。
    for id in &ids {
        kill_runtime_awaited(&state, id).await;
    }
    for id in &ids {
        match delete_session_inner(&state, id).await {
            Ok(()) => ok += 1,
            Err(e) => failed.push(serde_json::json!({ "id": id, "message": e.message })),
        }
    }
    save_overlay(&state).map_err(|e| cmd_err("OVERLAY_WRITE", e, None))?;
    Ok(serde_json::json!({ "ok": ok, "failed": failed }))
}

async fn delete_session_inner(state: &State<'_, AppState>, id: &str) -> Result<(), CmdError> {
    let agent = state.agent_dir.lock().await.clone();
    if let Some(path) = session_file_for(&agent, id) {
        let _ = std::fs::remove_file(&path);
        // 同名前缀目录（去 .jsonl 后缀）
        if let Some(stem) = path.file_name().and_then(|s| s.to_str()) {
            if let Some(dir_name) = stem.strip_suffix(".jsonl") {
                let dir = path.parent().unwrap_or(&agent).join(dir_name);
                if dir.is_dir() {
                    let _ = std::fs::remove_dir_all(&dir);
                }
            }
        }
    }
    {
        let mut ov = state.overlay.lock().await;
        ov.archived.remove(id);
        ov.notes.remove(id);
        ov.session_approval.remove(id);
    }
    Ok(())
}

// ==================== 聊天形态（V32 恢复自 V1–V10）：RPC 会话命令面 ====================

/// 图片附件（V2 M6）：只用得上 base64 与 mime，`name`/`bytes` 供前端展示。
/// 前端传 camelCase（`dataBase64` / `mimeType`），omp 侧 image 内容块用 `data` / `mimeType`。
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    pub data_base64: String,
    pub mime_type: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub bytes: Option<usize>,
}

/// 单张图片上限：与前端 `ATTACH_MAX_BYTES` 对齐，后端再兜一道（RPC 帧别被几十 MB 撑爆）。
pub(crate) const IMAGE_MAX_BYTES: usize = 10 * 1024 * 1024;

/// 记住会话所属项目的「上次使用」模型与思考档（覆盖层 `lastModel` / `lastThinking`）。
///
/// 数据源只认真值：切模型 / 切档后 runtime 会紧跟一次 `get_state` 回读，
/// 这里把回读结果落到项目上；`create_session` 再把它作为 spawn 参数带上，
/// 于是「新建会话沿用该项目上次的模型」才真正成立（此前这两个字段只写不读）。
/// 找不到归属项目（未归属会话）时静默跳过，不报错。
pub(crate) async fn remember_project_pref(
    state: &State<'_, AppState>,
    session_id: &str,
    model: Option<String>,
    thinking: Option<String>,
) {
    if model.is_none() && thinking.is_none() {
        return;
    }
    let agent = state.agent_dir.lock().await.clone();
    let Some(path) = session_file_for(&agent, session_id) else {
        return;
    };
    let head = parse_session_head(&path);
    if head.cwd.is_empty() {
        return;
    }
    let cwd = normalize_path(&head.cwd);
    let changed = {
        let mut ov = state.overlay.lock().await;
        match ov.projects.iter_mut().find(|p| normalize_path(&p.path) == cwd) {
            Some(p) => {
                let mut changed = false;
                if let Some(m) = model {
                    if p.last_model.as_deref() != Some(m.as_str()) {
                        p.last_model = Some(m);
                        changed = true;
                    }
                }
                if let Some(t) = thinking {
                    if p.last_thinking.as_deref() != Some(t.as_str()) {
                        p.last_thinking = Some(t);
                        changed = true;
                    }
                }
                changed
            }
            None => false,
        }
    };
    if changed {
        let _ = save_overlay(state);
    }
}

/// 归属用的 cwd：会话文件头读得到就以文件为准（真相），读不到（omp 的 jsonl 懒写盘，
/// 刚建好的会话要等首个 turn 才落文件）退回 spawn 时的 `--cwd`——
/// 不许因为「文件还不存在」就把刚新建的会话退回「未归属」。
pub fn owner_cwd(head_cwd: &str, spawn_cwd: &str) -> String {
    if head_cwd.is_empty() {
        spawn_cwd.to_string()
    } else {
        head_cwd.to_string()
    }
}

/// 「刚建好、尚未落盘」的会话补行（纯函数，可在临时目录上做真实行为测试）。
///
/// `candidates` = 当前 runtime 里的会话 `(sid, spawn 时的 --cwd, spawn 时刻毫秒)`。
/// 磁盘上已有 jsonl 的候选不算（走正常解析），只补真正还没落盘的——omp 懒写盘期间，
/// 任何一次列表刷新（切换项目 / 新建会话 / 打开搜索命中）都不许把刚新建的会话抹掉。
/// cwd / 时间 / 归属全是 spawn 的事实，只有标题还没有来源，用「未命名会话」。
pub fn unlanded_views(
    agent: &std::path::Path,
    candidates: &[(String, String, i64)],
    projects: &[(String, String)],
    notes: &HashMap<String, String>,
    running: &HashMap<String, bool>,
) -> Vec<SessionView> {
    candidates
        .iter()
        .filter(|(sid, _, _)| session_file_for(agent, sid).is_none())
        .map(|(sid, cwd, created_ms)| {
            let note = notes.get(sid).cloned();
            SessionView {
                // 文件还没落盘 = 真标题与首条用户消息两个数据源都还没有：交给 `display_title` 的
                // 「未命名会话 MM-DD」分支；落盘后由正常解析接上（无真标题时是首条用户消息派生，
                // 与前端本地回退同口径——会话有内容后不会跳回「未命名」）
                title: display_title(note.as_ref(), "", None, *created_ms),
                project_id: owner_project(projects, cwd),
                cwd: cwd.clone(),
                timestamp: *created_ms,
                archived: false,
                corrupt: false,
                note,
                running: running.get(sid).copied().unwrap_or(false),
                notice: None,
                id: sid.clone(),
            }
        })
        .collect()
}

/// 「首发生成被 omp 拒绝」之后的走向（纯决策，不碰 IO；见 [`plan_after_rejected_params`]）。
pub enum Plan {
    /// 降级成功：用 omp 默认档建起来了，`forget` = 要从项目偏好里清掉的那对失效值。
    Degraded { sid: String, sfile: String, meta: crate::runtime::SessionMeta, fallback: FallbackNotice, forget: Option<(String, String)> },
    /// 两次都没起来：把两段原因合成一条错误。
    GiveUp(CmdError),
}

/// 首发（带项目偏好的模型 / 思考档）被 omp 拒绝后的决策。
///
/// 三档口径：
/// - 重试**成功且拿到了模型** → 偏好确实失效（omp 拒绝非法 `--model` / `--thinking` 时是
///   直接退出），降级生效，并要求把这对失效偏好从项目上清掉（不自愈的话每次新建都要
///   白失败一次）。
/// - 重试成功但**仍没有模型** → 问题不在偏好上（omp 侧压根没有可用模型），如实说明，
///   不动用户的项目偏好。
/// - 重试也失败 → 两段原因合成一条错误回给用户（只报后者会把「参数被拒」这个真因藏掉）。
fn plan_after_rejected_params(
    first_err: &CmdError,
    retry: Result<(String, String, crate::runtime::SessionMeta), CmdError>,
    model: &Option<String>,
    thinking: &Option<String>,
) -> Plan {
    match retry {
        Ok((sid, sfile, meta)) => {
            let detail = stderr_first_line(&first_err.message);
            if meta.model.is_none() {
                Plan::Degraded {
                    sid,
                    sfile,
                    meta,
                    fallback: FallbackNotice { model: None, thinking: None, fallback_model: false, detail },
                    forget: None,
                }
            } else {
                Plan::Degraded {
                    sid,
                    sfile,
                    meta,
                    fallback: FallbackNotice { model: model.clone(), thinking: thinking.clone(), fallback_model: true, detail },
                    forget: Some((model.clone().unwrap_or_default(), thinking.clone().unwrap_or_default())),
                }
            }
        }
        Err(mut e2) => {
            e2.message = format!(
                "新建会话失败：{}；去掉模型 / 思考档参数重试仍失败：{}",
                first_err.message, e2.message
            );
            Plan::GiveUp(e2)
        }
    }
}

/// 按给定参数起一个新建会话的长驻进程（`create_session` 的首发与降级重试共用一份）。
async fn spawn_new<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    bin: &str,
    cwd: &str,
    model: Option<&str>,
    thinking: Option<&str>,
) -> Result<(String, String, crate::runtime::SessionMeta), CmdError> {
    crate::runtime::spawn_long_lived(
        app,
        state.runtime.clone(),
        crate::runtime::SpawnOpts {
            bin: bin.to_string(),
            cwd: cwd.to_string(),
            resume: None,
            model: model.map(str::to_string),
            thinking: thinking.map(str::to_string),
            approval: None,
        },
    )
    .await
}

/// 新建会话的返回：视图 + （可选的）降级说明。
///
/// 为什么不让 `create_session` 直接返回 `SessionView`：参数被 omp 拒绝而降级这件事
/// 必须让用户看见（见 [`FallbackNotice`]），而 `SessionView` 是列表 / 顶栏 / 归档页
/// 共用的行结构，只有这条路径需要承载说明——所以单开一层包装，`serde` 侧 `flatten` 成
/// 平铺字段：前端拿到的仍是「视图 + `fallback`」，`SessionView` 的消费方（列表 / 顶栏）不用改。
#[derive(Debug, serde::Serialize)]
pub struct CreateSessionResult {
    #[serde(flatten)]
    pub view: SessionView,
    pub fallback: Option<FallbackNotice>,
}

/// 新建聊天会话（V32：按目录开——左栏目录行 / 会话弹窗的「新建」都传 checkout 路径；
/// 模型与思考档沿用所属项目上次的选择）。
///
/// **参数被 omp 拒绝时必须还能建起来**（用户实测的坑）：覆盖层记的 `last_model` /
/// `last_thinking` 会在上游改名 / 删除模型后变成悬空值，而 omp 对非法 `--model` /
/// `--thinking` 是**直接退出**（实测 `Error: Model "ccproxy/deepseek/deepseek-v4.1-flash-fast"
/// not found`），于是「选项目 → 新建会话」整条路失败、报「omp 进程意外退出」。
/// 这里的口径：带上项目偏好试一次；被拒就不带这两个参数重试（omp 用默认档），
/// 成功即把项目里那对失效偏好清掉（不自愈的话每次新建都要多失败一次），
/// 并把降级说明随视图回传。
#[tauri::command]
pub async fn create_session<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cwd: String,
) -> Result<CreateSessionResult, CmdError> {
    create_session_in(&app, &state, cwd).await
}

/// `create_session` 的泛型实现（命令壳只负责取 State）：单测用 mock runtime 直接调它。
pub async fn create_session_in<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    cwd: String,
) -> Result<CreateSessionResult, CmdError> {
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(cmd_err("DIR_MISSING", "目录不存在".into(), None));
    }
    // WSL 项目：Windows 壳只把**终端**接进发行版，不跨发行版启动 omp。
    // 硬跑 Windows omp 会得到 UNC 工作目录 + 两套工具链（半坏且难排查），
    // 所以这里明确拒绝并给出两条可走的路，而不是静默降级。
    if let Some(w) = crate::wsl::parse_unc(&cwd) {
        return Err(cmd_err(
            "WSL_PROJECT",
            format!(
                "项目在 WSL（{}）里：Windows 壳不会跨发行版启动 omp。请在 WSL 内运行 omp（或 DSH）聊天，或把项目放到 Windows 盘；右栏终端可直接进入该发行版。",
                w.distro
            ),
            Some("若只是想在 WSL 里跑命令，用右栏终端；omp 的会话文件在 WSL 自己的 ~/.omp 下，不与 Windows 侧共享。".into()),
        ));
    }
    let (project_model, project_thinking) = {
        let ov = state.overlay.lock().await;
        let projects: Vec<(String, String)> = ov.projects.iter().map(|p| (p.id.clone(), p.path.clone())).collect();
        let scope = projects.clone();
        match owner_project(&scope, &cwd) {
            Some(pid) => match ov.projects.iter().find(|p| p.id == pid) {
                Some(p) => (p.last_model.clone(), p.last_thinking.clone()),
                None => (None, None),
            },
            None => (None, None),
        }
    };
    let bin = state.omp_path.lock().await.clone();
    let Some(bin) = bin else {
        return Err(cmd_err("OMP_MISSING", "未找到 omp，无法新建会话".into(), Some("请先安装 oh-my-pi".into())));
    };
    let (model, thinking) = (project_model, project_thinking);
    // spawn 内部以会话 id 作 runtime 表的键（不再需要占位键换名——换名窗口会让
    // pump 的首批帧查不到表条目：命令面缓存丢、偏好回写跳过）
    let first = spawn_new(app, state, &bin, &cwd, model.as_deref(), thinking.as_deref()).await;
    let (sid, sfile, _meta, fallback) = match first {
        Ok((sid, sfile, meta)) => (sid, sfile, meta, None),
        // 没带项目偏好就失败 → 不是参数的问题，原样上抛（错误里已含 omp 的 stderr 原因）
        Err(e) if model.is_none() && thinking.is_none() => return Err(e),
        Err(e) => match plan_after_rejected_params(&e, spawn_new(app, state, &bin, &cwd, None, None).await, &model, &thinking) {
            Plan::GiveUp(e2) => return Err(e2),
            Plan::Degraded { sid, sfile, meta, fallback: notice, forget } => {
                if let Some((gone_model, gone_thinking)) = forget {
                    forget_project_prefs(state, &cwd, &gone_model, &gone_thinking).await;
                }
                (sid, sfile, meta, Some(notice))
            }
        },
    };
    let view = build_new_session_view(state, &sid, &sfile, &cwd).await;
    Ok(CreateSessionResult { view, fallback })
}

/// 清掉某项目里**已被 omp 拒绝**的模型 / 思考档偏好（只清仍等于失效值的那一项，
/// 期间用户手动改过的不动）；`save_overlay` 走 `try_lock`，所以必须放在锁外调用。
async fn forget_project_prefs(state: &AppState, cwd: &str, gone_model: &str, gone_thinking: &str) {
    // 归属口径必须与 `create_session` 取偏好时一致（`owner_project` 的**路径前缀**语义）：
    // 在子目录 / worktree 里建的会话，精确相等找不到项目，自愈就会静默失效。
    let changed = {
        let mut ov = state.overlay.lock().await;
        let scope: Vec<(String, String)> =
            ov.projects.iter().map(|p| (p.id.clone(), p.path.clone())).collect();
        let pid = owner_project(&scope, cwd);
        let target = pid.and_then(|id| ov.projects.iter_mut().find(|p| p.id == id));
        match target {
            Some(p) => {
                let mut changed = false;
                if !gone_model.is_empty() && p.last_model.as_deref() == Some(gone_model) {
                    p.last_model = None;
                    changed = true;
                }
                if !gone_thinking.is_empty() && p.last_thinking.as_deref() == Some(gone_thinking) {
                    p.last_thinking = None;
                    changed = true;
                }
                changed
            }
            None => false,
        }
    };
    if changed {
        let _ = save_overlay(state);
    }
}

/// 从「omp 输出：xxx（yyy）」这类错误消息里取回 omp 自己写的首行（诊断用，取不到就 `None`）。
///
/// 剥的是**最外层**那对括号（可能套好几层），不是「第一个右括号」：omp 自己的报错
/// 也常带括号（`Model "x" not found（Run `omp models`）`），按第一个 `）` 切会把原话截断。
fn stderr_first_line(message: &str) -> Option<String> {
    let mut raw = message.split_once("omp 输出：")?.1;
    if let Some(nl) = raw.find('\n') {
        raw = &raw[..nl];
    }
    raw = raw.trim();
    // 只有**紧跟标记的那双括号**是壳自己加的（见 `with_stderr_reason` 的拼法），只脱这一层：
    // omp 报错本身常带括号（`Model "x" not found（did you mean y?）`），循环剥会把原话里的
    // 括号也吃掉、连尾部一起截断。
    let body = match raw.strip_prefix('（') {
        Some(b) => b,
        None => raw,
    };
    raw = match body.strip_suffix('）') {
        Some(b) => b,
        None => body,
    }
    .trim();
    if raw.is_empty() {
        None
    } else {
        Some(raw.to_string())
    }
}

/// 新建会话的视图：文件头此时全空（omp 懒写盘），归属退回 spawn 的 `--cwd`、
/// 时间用建会话这一刻——直接透传 timestamp=0 会让左栏那一行显示成 1970 的「01-01」。
async fn build_new_session_view(state: &AppState, sid: &str, sfile: &str, cwd: &str) -> SessionView {
    let head = parse_session_head(std::path::Path::new(sfile));
    let session_cwd = owner_cwd(&head.cwd, cwd);
    let session_ts = if head.timestamp == 0 { chrono::Utc::now().timestamp_millis() } else { head.timestamp };
    let (projects, note) = {
        let ov = state.overlay.lock().await;
        (
            ov.projects.iter().map(|p| (p.id.clone(), p.path.clone())).collect::<Vec<(String, String)>>(),
            ov.notes.get(sid).cloned(),
        )
    };
    SessionView {
        title: display_title(note.as_ref(), &head.title, head.first_user_text.as_deref(), session_ts),
        project_id: owner_project(&projects, &session_cwd),
        cwd: session_cwd,
        timestamp: session_ts,
        archived: false,
        corrupt: false,
        note,
        // 新建 = 还没跑过任何一轮：运行标（任务在跑）为否；列表转圈只表示任务在跑，
        // 不是"进程开着"（见 running_snapshot）
        running: false,
        notice: None,
        id: sid.to_string(),
    }
}

/// 打开（或聚焦）一个聊天会话：已有长驻进程直接返回视图；否则 `omp --resume` 拉起。
#[tauri::command]
pub async fn open_session(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<SessionView, CmdError> {
    let id = ensure_session_runtime(&app, &state, &id).await?;
    // 已有长驻进程直接聚焦（含刚建好、尚未落盘的新会话）
    let rt = state.runtime.lock().await.get(&id).map(|r| (r.cwd.clone(), r.created_ms));
    if let Some((rt_cwd, rt_created)) = rt {
        let agent = state.agent_dir.lock().await.clone();
        let head = session_file_for(&agent, &id)
            .map(|p| parse_session_head(&p))
            .unwrap_or(SessionHead { id: id.clone(), cwd: String::new(), timestamp: 0, title: String::new(), first_user_text: None, file: String::new(), corrupt: false });
        let session_cwd = owner_cwd(&head.cwd, &rt_cwd);
        // 文件还没落盘时头里什么都没有：时间退回 spawn 时刻（见 create_session 同样的道理）
        let session_ts = if head.timestamp == 0 { rt_created } else { head.timestamp };
        return Ok(build_session_view(&state, &id, &head.title, head.first_user_text.as_deref(), session_cwd, session_ts).await);
    }
    Err(cmd_err("NOT_RUNNING", "会话进程已退出，请重试".into(), None))
}

/// 确保会话进程存在。并发请求共享恢复结果，包括上游返回的新身份。
async fn ensure_session_runtime<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &State<'_, AppState>,
    id: &str,
) -> Result<String, CmdError> {
    let gate = {
        let mut gates = state.runtime_recovery.lock().await;
        gates.retain(|_, weak| weak.strong_count() > 0);
        match gates.get(id).and_then(std::sync::Weak::upgrade) {
            Some(gate) => gate,
            None => {
                let gate = std::sync::Arc::new(Mutex::new(None));
                gates.insert(id.to_string(), std::sync::Arc::downgrade(&gate));
                gate
            }
        }
    };
    let mut recovered = gate.lock().await;
    let mut running = state.runtime.lock().await;
    if let Some(real_id) = recovered.as_ref() {
        if running.get(real_id).is_some_and(|r| !r.tx.is_closed()) {
            return Ok(real_id.clone());
        }
    }
    if running.get(id).is_some_and(|r| !r.tx.is_closed()) {
        return Ok(id.to_string());
    }
    // 接收端已关闭而事件泵尚未清理时，先回收旧进程，避免恢复与其竞争会话文件。
    if let Some(old) = running.get_mut(id) {
        crate::runtime::stop_failed_child(old).await
            .map_err(|e| cmd_err("RUNTIME_STOP", format!("无法确认旧会话进程已退出：{e}"), None))?;
        running.remove(id);
    }
    drop(running);
    let real_id = spawn_session_runtime(app, state, id).await?.id;
    *recovered = Some(real_id.clone());
    Ok(real_id)
}

/// resume 拉起一个没有长驻进程的会话并登记进 `runtime` 表（`open_session` 的 spawn 段
/// 与 `send_prompt` 的自动恢复共用；调用方负责先确认 runtime 里没有这个会话）。
/// 返回 jsonl 头（组装会话视图用）。
async fn spawn_session_runtime<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &State<'_, AppState>,
    id: &str,
) -> Result<SessionHead, CmdError> {
    let agent = state.agent_dir.lock().await.clone();
    let Some(path) = session_file_for(&agent, id) else {
        return Err(cmd_err("NOT_FOUND", "会话文件不存在，可能已被删除".into(), None));
    };
    let head = parse_session_head(&path);
    if head.corrupt {
        return Err(cmd_err("CORRUPT", "会话文件已损坏，可删除".into(), None));
    }
    let bin = state.omp_path.lock().await.clone();
    let Some(bin) = bin else {
        return Err(cmd_err("OMP_MISSING", "未找到 omp".into(), None));
    };
    let spawn_cwd = if head.cwd.is_empty() { "/tmp".into() } else { head.cwd.clone() };
    // 防御：历史里若残留 WSL UNC 的会话（正常路径不会建出来），不要在 Windows omp 上半跑。
    if let Some(w) = crate::wsl::parse_unc(&spawn_cwd) {
        return Err(cmd_err(
            "WSL_PROJECT",
            format!("该会话的项目在 WSL（{}）里，Windows 壳不跨发行版启动 omp", w.distro),
            Some("请在 WSL 内打开该会话；右栏终端可直接进入该发行版".into()),
        ));
    }
    let approval = state.overlay.lock().await.session_approval.get(id).cloned();
    // `--resume` 必须给**完整会话 id**（终端侧 resume 一直是全 id 口径）：omp 对前缀的
    // 解析取「最新匹配的那个」（实测），8 字符前缀在同一分钟建的两个会话间会拉起**另一个
    // 会话**——新进程以那个会话的身份登记，若它正在跑就被同 id 补位顶掉（进行中的轮次被中止）。
    let (sid, sfile, _meta) = crate::runtime::spawn_long_lived(
        app,
        state.runtime.clone(),
        crate::runtime::SpawnOpts { bin, cwd: spawn_cwd, resume: Some(id.to_string()), model: None, thinking: None, approval },
    )
    .await?;
    // 身份漂移 = omp 的保护性 fork（`Session moved to a new file / open-elsewhere`）：
    // 请求 resume 的会话已被**其他进程**持有（另一个壳实例等），omp 会把本次进程分到
    // 新身份（新 jsonl、`parentSession` 指向原会话）。视图与 runtime 表必须以**真实
    // 身份**为准——否则列表行、事件订阅与「再次打开」全部指向旧 id：点开的明明是
    // 副本，壳却以为打开的是原会话，再点一次又会拉起一个新进程。
    if sid != id {
        return Ok(parse_session_head(std::path::Path::new(&sfile)));
    }
    Ok(head)
}

// ---------- 会话消息与运行控制 ----------

/// 每页读取上限：限制文件读取量和返回行数，游标指向下一页结束位置。
const MAX_HISTORY_LINES: usize = 5000;
const MAX_HISTORY_ENTRIES: usize = 2000;
const MAX_HISTORY_BYTES: u64 = 128 * 1024 * 1024;
const HISTORY_CHUNK_BYTES: u64 = 1024 * 1024;

#[tauri::command]
pub async fn get_history(state: State<'_, AppState>, id: String, before: Option<u64>) -> Result<serde_json::Value, CmdError> {
    use std::io::{Read, Seek, SeekFrom};
    let agent = state.agent_dir.lock().await.clone();
    let Some(path) = session_file_for(&agent, &id) else {
        return Err(cmd_err("NOT_FOUND", "会话文件不存在，可能已被删除".into(), None));
    };
    let mut file = std::fs::File::open(&path).map_err(|e| cmd_err("IO", format!("读取会话失败：{e}"), None))?;
    let len = file.metadata().map_err(|e| cmd_err("IO", format!("读取会话信息失败：{e}"), None))?.len();
    let end = before.unwrap_or(len);
    if end > len {
        return Err(cmd_err("BAD_ARG", "会话文件已变化，请重新打开会话".into(), None));
    }
    // 一般页只读 1 MiB；末行跨块时向前扩展，最多读取 128 MiB。
    let mut start = end;
    let mut chunks = Vec::new();
    let mut newlines = 0usize;
    let mut needed = 1usize;
    while start > 0 && end - start < MAX_HISTORY_BYTES {
        let size = HISTORY_CHUNK_BYTES.min(start).min(MAX_HISTORY_BYTES - (end - start));
        start -= size;
        file.seek(SeekFrom::Start(start)).map_err(|e| cmd_err("IO", format!("定位会话失败：{e}"), None))?;
        let mut chunk = vec![0; size as usize];
        file.read_exact(&mut chunk).map_err(|e| cmd_err("IO", format!("读取会话失败：{e}"), None))?;
        if chunks.is_empty() && chunk.last() == Some(&b'\n') { needed = 2; }
        newlines += chunk.iter().filter(|b| **b == b'\n').count();
        chunks.push(chunk);
        if newlines >= needed { break; }
    }
    let mut buf = Vec::with_capacity((end - start) as usize);
    for chunk in chunks.into_iter().rev() { buf.extend(chunk); }
    // 从完整行边界开始，避免截断 UTF-8 或 JSON；超长单行分段跳过并提示。
    let first = if start == 0 { 0 } else {
        match buf.iter().position(|b| *b == b'\n').filter(|p| *p + 1 < buf.len()) {
            Some(p) => p + 1,
            None => return Ok(serde_json::json!({ "lines": [], "lineOffsets": [], "before": start, "end": end, "skipped": true })),
        }
    };
    let mut out = vec![];
    let mut offsets = vec![];
    let mut pos = buf.len();
    let mut scanned = 0;
    while pos > first && scanned < MAX_HISTORY_LINES && out.len() < MAX_HISTORY_ENTRIES {
        if buf[pos - 1] == b'\n' { pos -= 1; }
        let line_end = pos;
        let line_start = buf[first..pos].iter().rposition(|b| *b == b'\n').map_or(first, |p| first + p + 1);
        pos = line_start;
        scanned += 1;
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&buf[line_start..line_end]) {
            if matches!(v.get("type").and_then(|t| t.as_str()), Some("message" | "custom" | "title_change" | "model_change" | "thinking_level_change")) {
                out.push(v);
                offsets.push(start + line_start as u64);
            }
        }
    }
    out.reverse();
    offsets.reverse();
    let next = start + pos as u64;
    Ok(serde_json::json!({ "lines": out, "lineOffsets": offsets, "before": if next > 0 { Some(next) } else { None }, "end": end }))
}

#[tauri::command]
pub async fn send_message(app: AppHandle, state: State<'_, AppState>, id: String, message: String, images: Option<Vec<ImageAttachment>>) -> Result<(), CmdError> {
    send_prompt(&app, &state, &id, "prompt", message, images).await
}

/// 流式中转向（`steer`）：在下一个工具调用边界生效，不砍掉进行中的工作。
#[tauri::command]
pub async fn steer_message(app: AppHandle, state: State<'_, AppState>, id: String, message: String, images: Option<Vec<ImageAttachment>>) -> Result<(), CmdError> {
    send_prompt(&app, &state, &id, "steer", message, images).await
}

/// 流式中排队（`follow_up`）：本轮结束后按序执行。
#[tauri::command]
pub async fn follow_up_message(app: AppHandle, state: State<'_, AppState>, id: String, message: String, images: Option<Vec<ImageAttachment>>) -> Result<(), CmdError> {
    send_prompt(&app, &state, &id, "follow_up", message, images).await
}

/// `/` 命令：经 prompt 直发（`/` 开头即可，omp 侧按本地命令处理）。
#[tauri::command]
pub async fn run_slash(app: AppHandle, state: State<'_, AppState>, id: String, command: String) -> Result<(), CmdError> {
    send_prompt(&app, &state, &id, "prompt", command, None).await
}

/// 上下文压缩：历史压缩成摘要后继续本会话（满上下文时的接续手段）。
#[tauri::command]
pub async fn compact_session(app: AppHandle, state: State<'_, AppState>, id: String, custom_instructions: Option<String>) -> Result<(), CmdError> {
    let map = state.runtime.clone();
    let tx = map.lock().await.get(&id).map(|r| r.tx.clone());
    let Some(tx) = tx else {
        return Err(cmd_err("NOT_RUNNING", "会话未启动，请先打开会话".into(), None));
    };
    let mut req = serde_json::json!({"id": format!("c-{}", chrono::Utc::now().timestamp_millis()), "type": "compact"});
    if let Some(ins) = custom_instructions.filter(|s| !s.trim().is_empty()) {
        req["customInstructions"] = serde_json::Value::String(ins);
    }
    tx.send(format!("{}\n", serde_json::to_string(&req).unwrap()))
        .map_err(|_| cmd_err("RPC_IO", "压缩失败，进程可能已退出".into(), None))?;
    let _ = app;
    Ok(())
}

// ---------- V40：对标 codex / zcode 的命令面（要读返回值的 RPC 请求） ----------

/// 向会话进程发一条请求并等它的 `response` 回包（V40 新面）。
///
/// 等法 = 临时挂一个 `omp-event://<id>` 监听、按请求 `id` 匹配回包就撤监听：
/// pump 把 response 全量透传到该通道（前端对成功回包不渲染——多一个监听者不影响它），
/// 这是壳侧第一条**要读返回值**的 RPC 通路（队列撤回 / 旁问 / 统计）。
/// 超时兜底：会话正忙时命令会在 omp 内部排队，迟迟不回不能把界面卡死。
pub(crate) async fn rpc_request<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &State<'_, AppState>,
    id: &str,
    req: serde_json::Value,
    timeout_ms: u64,
) -> Result<serde_json::Value, CmdError> {
    use tauri::Listener;
    let req_id = req.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let tx = state.runtime.lock().await.get(id).map(|r| r.tx.clone());
    let Some(tx) = tx else {
        return Err(cmd_err("NOT_RUNNING", "会话未启动，请先打开会话".into(), None));
    };
    let (otx, mut orx) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
    let handle = app.listen(format!("omp-event://{id}"), move |e| {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(e.payload()) {
            let _ = otx.send(v);
        }
    });
    if tx.send(format!("{}\n", serde_json::to_string(&req).unwrap())).is_err() {
        app.unlisten(handle);
        return Err(cmd_err("RPC_IO", "请求失败，进程可能已退出".into(), None));
    }
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    let mut hit: Option<serde_json::Value> = None;
    loop {
        let remain = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remain.is_zero() {
            break;
        }
        match tokio::time::timeout(remain, orx.recv()).await {
            Ok(Some(v)) => {
                if v.get("type").and_then(|t| t.as_str()) == Some("response")
                    && v.get("id").and_then(|i| i.as_str()) == Some(req_id.as_str())
                {
                    hit = Some(v);
                    break;
                }
            }
            Ok(None) | Err(_) => break,
        }
    }
    app.unlisten(handle);
    let Some(resp) = hit else {
        return Err(cmd_err("RPC_TIMEOUT", "等待 omp 响应超时".into(), None));
    };
    if resp.get("success").and_then(|s| s.as_bool()) != Some(true) {
        let message = resp.get("error").and_then(|e| e.as_str()).unwrap_or("命令执行失败").to_string();
        let code = resp.get("code").and_then(|c| c.as_str()).unwrap_or("RPC_FAIL").to_string();
        return Err(cmd_err(&code, message, None));
    }
    Ok(resp.get("data").cloned().unwrap_or(serde_json::Value::Null))
}

/// 撤回一条尚未投递的队列消息（steering / followUp）→ `{removed, images?, imagesDropped?}`。
#[tauri::command]
pub async fn remove_queued_message(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    message: String,
    queue: String,
) -> Result<serde_json::Value, CmdError> {
    if queue != "steering" && queue != "followUp" {
        return Err(cmd_err("BAD_ARG", "队列必须是 steering 或 followUp".into(), None));
    }
    let req = serde_json::json!({
        "id": format!("rq-{}", chrono::Utc::now().timestamp_millis()),
        "type": "remove_queued_message",
        "message": message,
        "queue": queue,
    });
    rpc_request(&app, &state, &id, req, 15_000).await
}

/// 把一条 followUp 排队提升为 steering 插话 → `{promoted}`。
#[tauri::command]
pub async fn promote_queued_message(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    message: String,
) -> Result<serde_json::Value, CmdError> {
    let req = serde_json::json!({
        "id": format!("pq-{}", chrono::Utc::now().timestamp_millis()),
        "type": "promote_queued_message",
        "message": message,
    });
    rpc_request(&app, &state, &id, req, 15_000).await
}

/// 中断并交还队列（Esc 语义，= omp TUI 里按 Esc）：返回被撤回的插话 / 排队文本，
/// 调用方放回输入框。响应恒成功（队列为空时等同普通 abort）。
#[tauri::command]
pub async fn abort_and_restore_queue(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<serde_json::Value, CmdError> {
    let req = serde_json::json!({
        "id": format!("ar-{}", chrono::Utc::now().timestamp_millis()),
        "type": "abort_and_restore_queue",
    });
    rpc_request(&app, &state, &id, req, 30_000).await
}

/// 会话统计（`/status` 弹窗）：消息数 / tokens 分项 / 成本 / 上下文占用。
#[tauri::command]
pub async fn get_session_stats(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<serde_json::Value, CmdError> {
    let req = serde_json::json!({
        "id": format!("ss-{}", chrono::Utc::now().timestamp_millis()),
        "type": "get_session_stats",
    });
    rpc_request(&app, &state, &id, req, 30_000).await
}

/// 旁问（`/btw`）：一问一答、不进会话转录；`recordId` 时是对该话题的追问。
#[tauri::command]
pub async fn btw_ask(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    question: String,
    record_id: Option<String>,
) -> Result<serde_json::Value, CmdError> {
    if question.trim().is_empty() {
        return Err(cmd_err("BAD_ARG", "问题不能为空".into(), None));
    }
    let mut req = serde_json::json!({
        "id": format!("btw-{}", chrono::Utc::now().timestamp_millis()),
        "type": "btw",
        "question": question,
    });
    if let Some(r) = record_id.filter(|s| !s.is_empty()) {
        req["recordId"] = serde_json::Value::String(r);
    }
    rpc_request(&app, &state, &id, req, 30_000).await
}

/// 取消正在跑的旁问 → `{cancelled}`。
#[tauri::command]
pub async fn btw_cancel(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    record_id: Option<String>,
) -> Result<serde_json::Value, CmdError> {
    let mut req = serde_json::json!({
        "id": format!("btwx-{}", chrono::Utc::now().timestamp_millis()),
        "type": "btw_cancel",
    });
    if let Some(r) = record_id.filter(|s| !s.is_empty()) {
        req["recordId"] = serde_json::Value::String(r);
    }
    rpc_request(&app, &state, &id, req, 15_000).await
}

/// 旁问历史（最新在前；运行中的记录带部分答案）。
#[tauri::command]
pub async fn get_btw_history(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<serde_json::Value, CmdError> {
    let req = serde_json::json!({
        "id": format!("btwh-{}", chrono::Utc::now().timestamp_millis()),
        "type": "get_btw_history",
    });
    rpc_request(&app, &state, &id, req, 15_000).await
}

/// 会话改名（V40）：RPC `set_session_name` 写 omp 真名（jsonl `title` 行，source:user），
/// 成功后清掉覆盖层的旧备注（备注优先只服务存量数据，不再提供写入面），返回收敛后的视图。
#[tauri::command]
pub async fn rename_session(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<SessionView, CmdError> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(cmd_err("BAD_ARG", "会话名不能为空".into(), None));
    }
    // 改名要活跃进程：与打开和发送共用单飞恢复。
    let id = ensure_session_runtime(&app, &state, &id).await?;
    let req = serde_json::json!({
        "id": format!("rn-{}", chrono::Utc::now().timestamp_millis()),
        "type": "set_session_name",
        "name": name,
    });
    rpc_request(&app, &state, &id, req, 15_000).await?;
    {
        let removed = {
            let mut ov = state.overlay.lock().await;
            ov.notes.remove(&id).is_some()
        };
        if removed {
            save_overlay(&state).map_err(|e| cmd_err("OVERLAY_WRITE", e, None))?;
        }
    }
    open_session(app, state, id).await
}

/// 重启会话 runtime（V40）：执行模式（`--approval-mode`）是启动参数，omp 运行中改不了——
/// 会话 idle 且队列空时 kill + resume 是壳侧能给的「立即生效」路径（队列非空会丢消息，
/// 一律拒绝；running / awaiting 不打断）。
#[tauri::command]
pub async fn restart_session_runtime(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<SessionView, CmdError> {
    {
        let map = state.runtime.lock().await;
        match map.get(&id) {
            None => {}
            Some(r) => {
                if r.activity.state() != crate::runtime::ACT_IDLE {
                    return Err(cmd_err("BUSY", "会话正在工作，稍后再试".into(), None));
                }
                if r.meta.queued_count.unwrap_or(0) > 0 {
                    return Err(cmd_err("BUSY", "还有排队消息未投递，稍后再试".into(), None));
                }
            }
        }
    }
    kill_runtime(&state, &id);
    spawn_session_runtime(&app, &state, &id).await?;
    open_session(app, state, id).await
}

/// 单文件工作区 diff（`git diff HEAD -- <path>`；untracked 给文件全文当「全新增」）。
/// 输出截断上限：超大 diff 不整份进前端内存。
const GIT_DIFF_MAX: usize = 400_000;

#[tauri::command]
pub async fn git_file_diff(path: String) -> Result<serde_json::Value, CmdError> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(cmd_err("NOT_FOUND", "文件不存在".into(), None));
    }
    let dir = p
        .parent()
        .map(|d| d.to_string_lossy().to_string())
        .unwrap_or_default();
    let Some(git) = crate::git_info::git_bin().await else {
        return Ok(serde_json::json!({"kind": "error", "text": "", "truncated": false, "error": "未找到 git"}));
    };
    let status = crate::git_info::run_git(&git, &dir, &["status", "--porcelain", "--", path.as_str()]).await;
    match status {
        Ok(out) if out.trim_start().starts_with("??") => {
            let text = std::fs::read_to_string(&p).unwrap_or_default();
            let (text, truncated) = crate::git_graph::truncate_text(&text, GIT_DIFF_MAX);
            Ok(serde_json::json!({"kind": "untracked", "text": text, "truncated": truncated}))
        }
        Ok(_) => {
            let diff = crate::git_info::run_git(&git, &dir, &["diff", "HEAD", "--no-color", "--", path.as_str()])
                .await
                .unwrap_or_default();
            if diff.trim().is_empty() {
                Ok(serde_json::json!({"kind": "none", "text": "", "truncated": false}))
            } else {
                let (diff, truncated) = crate::git_graph::truncate_text(&diff, GIT_DIFF_MAX);
                Ok(serde_json::json!({"kind": "diff", "text": diff, "truncated": truncated}))
            }
        }
        Err(e) => Ok(serde_json::json!({"kind": "error", "text": "", "truncated": false, "error": e})),
    }
}

/// 子代理注册表快照（V41）：`{subagents:[…]}` 原样透传（条目形状由前端容错解析）。
#[tauri::command]
pub async fn get_subagents(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<serde_json::Value, CmdError> {
    let req = serde_json::json!({
        "id": format!("sub-{}", chrono::Utc::now().timestamp_millis()),
        "type": "get_subagents",
    });
    rpc_request(&app, &state, &id, req, 15_000).await
}

/// 取消一个运行中的子代理（V41）→ `{cancelled}`（未知 / 已结束的 id 返回 false，幂等）。
#[tauri::command]
pub async fn cancel_subagent(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    subagent_id: String,
) -> Result<serde_json::Value, CmdError> {
    if subagent_id.trim().is_empty() {
        return Err(cmd_err("BAD_ARG", "subagentId 不能为空".into(), None));
    }
    let req = serde_json::json!({
        "id": format!("sax-{}", chrono::Utc::now().timestamp_millis()),
        "type": "cancel_subagent",
        "subagentId": subagent_id,
    });
    rpc_request(&app, &state, &id, req, 20_000).await
}

/// 读子代理转录（V41；增量读：`fromByte` 复用上次返回的 `nextByte`）。
#[tauri::command]
pub async fn get_subagent_messages(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    subagent_id: String,
    from_byte: Option<i64>,
) -> Result<serde_json::Value, CmdError> {
    if subagent_id.trim().is_empty() {
        return Err(cmd_err("BAD_ARG", "subagentId 不能为空".into(), None));
    }
    let mut req = serde_json::json!({
        "id": format!("sam-{}", chrono::Utc::now().timestamp_millis()),
        "type": "get_subagent_messages",
        "subagentId": subagent_id,
    });
    if let Some(b) = from_byte {
        req["fromByte"] = serde_json::json!(b.max(0));
    }
    rpc_request(&app, &state, &id, req, 20_000).await
}

/// fast 模式开关（V41）→ `{enabled, active}`；模型不支持时失败（错误文本原样给界面）。
#[tauri::command]
pub async fn set_fast_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<serde_json::Value, CmdError> {
    let req = serde_json::json!({
        "id": format!("fm-{}", chrono::Utc::now().timestamp_millis()),
        "type": "set_fast_mode",
        "enabled": enabled,
    });
    rpc_request(&app, &state, &id, req, 15_000).await
}

/// 导出会话为 HTML（V41）：omp 把文件写到**会话 cwd**（实测），这里拼成绝对路径返回，
/// 前端用系统默认应用打开。要求进程在跑（RPC 命令），不在时明确报错。
#[tauri::command]
pub async fn export_session_html(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<serde_json::Value, CmdError> {
    let base = state.runtime.lock().await.get(&id).map(|r| r.cwd.clone());
    let Some(base) = base else {
        return Err(cmd_err("NOT_RUNNING", "会话未启动，先打开会话再导出".into(), None));
    };
    let req = serde_json::json!({
        "id": format!("ex-{}", chrono::Utc::now().timestamp_millis()),
        "type": "export_html",
    });
    let out = rpc_request(&app, &state, &id, req, 60_000).await?;
    let name = out.get("path").and_then(|p| p.as_str()).unwrap_or("").to_string();
    // 绝对路径按平台判断（`C:\...` 不以 `/` 开头），相对路径用 `Path::join`
    // 拼——字符串拼 `/` 在 Windows 上会得到 `C:\proj/C:\...`。
    let abs = if name.is_empty() || Path::new(&name).is_absolute() {
        name
    } else {
        Path::new(&base).join(&name).to_string_lossy().into_owned()
    };
    Ok(serde_json::json!({ "path": abs }))
}

/// 大段粘贴转文件引用（V41）：把一段长文本写进 `<appData>/omp-inn/paste/`，
/// 返回绝对路径——前端把它以 `@<path>` 注入草稿，omp 在 prompt 阶段读进上下文（fileMention）。
/// 随机文件名配合排他创建，跨进程并发时也不会覆盖已有文件。
#[tauri::command]
pub async fn save_paste(app: AppHandle, text: String) -> Result<serde_json::Value, CmdError> {
    use std::io::Write;

    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
        .join("omp-inn")
        .join("paste");
    std::fs::create_dir_all(&dir).map_err(|e| cmd_err("IO", format!("创建粘贴目录失败：{e}"), None))?;
    for _ in 0..16 {
        let name = format!("paste-{}-{:032x}.txt", chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ"), rand::random::<u128>());
        let path = dir.join(name);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(e) = file.write_all(text.as_bytes()) {
                    drop(file);
                    let _ = std::fs::remove_file(&path);
                    return Err(cmd_err("IO", format!("写入粘贴文件失败：{e}"), None));
                }
                return Ok(serde_json::json!({ "path": path.to_string_lossy() }));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(cmd_err("IO", format!("创建粘贴文件失败：{e}"), None)),
        }
    }
    Err(cmd_err("IO", "创建粘贴文件失败：文件名冲突，请重试".into(), None))
}

/// 本地 shell（V41，codex 的 `!` 前缀）：在**会话进程的工作目录**跑一条命令并取回输出
/// （omp 的 `bash` RPC——concurrent 分发，输出整体返回：`{exitCode, output, truncated, …}`）。
/// 超时放宽到 120s（交互式命令；`abort_bash` 的取消入口留待需要时接）。
#[tauri::command]
pub async fn run_bash(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    command: String,
) -> Result<serde_json::Value, CmdError> {
    if command.trim().is_empty() {
        return Err(cmd_err("BAD_ARG", "命令不能为空".into(), None));
    }
    let req = serde_json::json!({
        "id": format!("sh-{}", chrono::Utc::now().timestamp_millis()),
        "type": "bash",
        "command": command,
    });
    rpc_request(&app, &state, &id, req, 120_000).await
}

/// 组装会话视图（open / fork / rename 共用）：标题（覆盖层备注优先，存量兼容）、
/// 项目归属（含 worktree 口径）、归档标记、cwd、时间、运行中。
async fn build_session_view(
    state: &State<'_, AppState>,
    id: &str,
    head_title: &str,
    first_user_text: Option<&str>,
    cwd: String,
    timestamp: i64,
) -> SessionView {
    let (projects, archived, note) = {
        let ov = state.overlay.lock().await;
        (
            ov.projects.iter().map(|p| (p.id.clone(), p.path.clone())).collect::<Vec<(String, String)>>(),
            ov.archived.get(id).copied().unwrap_or(false),
            ov.notes.get(id).cloned(),
        )
    };
    let pid = owner_project(&ownership_scope(&projects).await, cwd.as_str());
    // 「运行中」= 任务在跑（与列表快照同一口径，见 running_snapshot），不是"进程在表里"：
    // 常驻进程打开着的空闲会话不该转圈，跑完的任务不该一直转。
    let running = state
        .runtime
        .lock()
        .await
        .get(id)
        .map(|r| crate::runtime::activity_is_busy(r.activity.state()))
        .unwrap_or(false);
    SessionView {
        title: display_title(note.as_ref(), head_title, first_user_text, timestamp),
        project_id: pid,
        cwd,
        timestamp,
        archived,
        corrupt: false,
        note,
        running,
        notice: None,
        id: id.to_string(),
    }
}

/// prompt 系列的统一发送：`prompt / steer / follow_up` 共用图片组装。
/// 泛型 + `pub(crate)`：runtime.rs 的真实慢测试直接调它验「回收后发送自动恢复」。
pub(crate) async fn send_prompt<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &State<'_, AppState>,
    id: &str,
    kind: &str,
    message: String,
    images: Option<Vec<ImageAttachment>>,
) -> Result<(), CmdError> {
    let map = state.runtime.clone();
    // 图片随 prompt 一起发（实测 omp `prompt{message, images}`）；字段名按 omp 的 image 内容块：
    // `{type:"image", data:<base64>, mimeType}`。
    let imgs: Vec<serde_json::Value> = images
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.data_base64.is_empty() && i.data_base64.len() <= IMAGE_MAX_BYTES * 2)
        .map(|i| serde_json::json!({"type":"image","data":i.data_base64,"mimeType":i.mime_type}))
        .collect();
    let prefix = match kind {
        "steer" => "s",
        "follow_up" => "f",
        _ => "p",
    };
    // 随机后缀防止同一毫秒的请求 id 碰撞，待处理保护按 id 对账。
    let request_id = format!("{prefix}-{}-{:032x}", chrono::Utc::now().timestamp_millis(), rand::random::<u128>());
    let mut req = serde_json::json!({"id": request_id, "type": kind, "message": message});
    if !imgs.is_empty() {
        req["images"] = serde_json::Value::Array(imgs);
    }
    let line = format!("{}\n", serde_json::to_string(&req).unwrap());
    let mut target = id.to_string();
    for attempt in 0..2 {
        {
            // 登记保护与投递必须与闲置回收共用进程表锁。
            let running = map.lock().await;
            if let Some(r) = running.get(&target).filter(|r| !r.tx.is_closed()) {
                r.activity.register_input(&request_id, kind);
                if r.tx.send(line.clone()).is_ok() {
                    return Ok(());
                }
                r.activity.cancel_input(&request_id);
            }
        }
        if kind != "prompt" || attempt == 1 {
            return Err(cmd_err("RPC_IO", "发送失败，进程可能已退出".into(), None));
        }
        // 只在通道未接收时恢复并重试，不重发已经入队的消息。
        target = ensure_session_runtime(app, state, id).await?;
    }
    Err(cmd_err("RPC_IO", "发送失败，进程可能已退出".into(), None))
}

/// 读本地图片为附件（V2 M6）：WebView 拿不到任意本地路径的内容，
/// 所以「点回形针选文件」这条入口走后端读 → base64 回前端（粘贴 / 拖拽仍在 WebView 内直接读 File）。
#[tauri::command]
pub async fn read_image_file(path: String) -> Result<ImageAttachment, CmdError> {
    let p = PathBuf::from(&path);
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let mime = match p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => {
            return Err(cmd_err(
                "BAD_TYPE",
                format!("{name}：只支持 PNG / JPEG / WebP / GIF"),
                Some("换一张图片，或先用图片工具转成 PNG".into()),
            ))
        }
    };
    let meta = std::fs::metadata(&p)
        .map_err(|e| cmd_err("NOT_FOUND", format!("读取 {name} 失败：{e}"), Some("确认文件仍然存在".into())))?;
    if meta.len() as usize > IMAGE_MAX_BYTES {
        return Err(cmd_err(
            "TOO_LARGE",
            format!("{name}：超过 10MB，请先压缩再发"),
            Some("压缩到 10MB 以内（建议长边 ≤ 2048）".into()),
        ));
    }
    let bytes = std::fs::read(&p)
        .map_err(|e| cmd_err("IO", format!("读取 {name} 失败：{e}"), None))?;
    Ok(ImageAttachment {
        data_base64: crate::runtime::b64encode(&bytes),
        mime_type: mime.to_string(),
        name: Some(name),
        bytes: Some(bytes.len()),
    })
}

#[tauri::command]
pub async fn stop_session(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), CmdError> {
    let map = state.runtime.clone();
    let tx = map.lock().await.get(&id).map(|r| r.tx.clone());
    let Some(tx) = tx else {
        return Err(cmd_err("NOT_RUNNING", "会话未运行".into(), None));
    };
    let req = serde_json::json!({"id": format!("a-{}", chrono::Utc::now().timestamp_millis()), "type": "abort"});
    tx.send(format!("{}\n", serde_json::to_string(&req).unwrap()))
        .map_err(|_| cmd_err("RPC_IO", "停止失败，进程可能已退出".into(), None))?;
    let _ = app;
    Ok(())
}

/// 杀掉一个会话的长驻进程（归档 / 删除 / 移除项目前调用）。
pub fn kill_runtime(state: &State<AppState>, id: &str) {
    if let Ok(mut m) = state.runtime.try_lock() {
        if let Some(r) = m.remove(id) {
            let _ = r.tx.send(String::new());
            // child kill 需要 async；此处发哨兵让 pump 退出，进程随 stdin 关闭退出（code 0）
        }
    }
}

#[tauri::command]
pub async fn approve(app: AppHandle, state: State<'_, AppState>, id: String, ui_id: String, decision: String) -> Result<(), CmdError> {
    let map = state.runtime.clone();
    let tx = map.lock().await.get(&id).map(|r| r.tx.clone());
    let Some(tx) = tx else {
        return Err(cmd_err("NOT_RUNNING", "会话未运行，审批已失效".into(), None));
    };
    let resp = match decision.as_str() {
        "once" | "always" => serde_json::json!({"type":"extension_ui_response","id":ui_id,"value":"Approve"}),
        "deny" => serde_json::json!({"type":"extension_ui_response","id":ui_id,"cancelled":true}),
        _ => return Err(cmd_err("BAD_ARG", "审批 decision 非法".into(), None)),
    };
    if decision == "always" {
        // 会话级 yolo 意向（V1 不伪装逐工具 API）
        if let Ok(mut ov) = state.overlay.try_lock() {
            ov.session_approval.insert(id.clone(), "yolo".into());
        }
        let _ = save_overlay(&state);
    }
    tx.send(format!("{}\n", serde_json::to_string(&resp).unwrap()))
        .map_err(|_| cmd_err("RPC_IO", "审批发送失败，进程可能已退出".into(), None))?;
    // 审批放行即视为「等待结束」：活动态改回 running，与广播保持一致（回收只认 idle）
    if let Some(r) = state.runtime.lock().await.get(&id) {
        r.activity.set_state(crate::runtime::ACT_RUNNING);
    }
    crate::remote::emit_event(&app, &format!("omp-status://{id}"), &serde_json::json!({"state":"running"}));
    Ok(())
}

/// 通用 UI 请求回包（V2 M5）：omp `extension_ui_request` 里非审批的交互方法。
/// 回包语义按方法区分（实测 omp 18.1.22 内嵌源码）：
/// `confirm` → `{confirmed:bool}`；`input`/`editor`/非审批 `select` → `{value:string}`；
/// 取消/跳过 → `{cancelled:true}`；`ask`（V40）→ `{answers:[{id,selectedOptions,customInput}]}`
/// （每个问题一条、顺序与请求一致；单选至多一项且不与 customInput 并存）。审批仍走 `approve`。
#[tauri::command]
pub async fn respond_ui(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    ui_id: String,
    kind: String,
    value: Option<String>,
    confirmed: Option<bool>,
    answers: Option<serde_json::Value>,
) -> Result<(), CmdError> {
    let map = state.runtime.clone();
    let tx = map.lock().await.get(&id).map(|r| r.tx.clone());
    let Some(tx) = tx else {
        return Err(cmd_err("NOT_RUNNING", "会话未运行，该请求已失效".into(), None));
    };
    let resp = match kind.as_str() {
        "value" => serde_json::json!({"type":"extension_ui_response","id":ui_id,"value":value.unwrap_or_default()}),
        "confirm" => serde_json::json!({"type":"extension_ui_response","id":ui_id,"confirmed":confirmed.unwrap_or(false)}),
        "cancel" => serde_json::json!({"type":"extension_ui_response","id":ui_id,"cancelled":true}),
        "answers" => serde_json::json!({"type":"extension_ui_response","id":ui_id,"answers":answers.unwrap_or_else(|| serde_json::json!([]))}),
        _ => return Err(cmd_err("BAD_ARG", "UI 回包类型非法".into(), None)),
    };
    tx.send(format!("{}\n", serde_json::to_string(&resp).unwrap()))
        .map_err(|_| cmd_err("RPC_IO", "回包发送失败，进程可能已退出".into(), None))?;
    // 回包即视为「等待结束」，与 approve 一致把状态推回 running（omp 会继续跑）；
    // 活动态同步落 running（回收只认 idle）。
    if let Some(r) = state.runtime.lock().await.get(&id) {
        r.activity.set_state(crate::runtime::ACT_RUNNING);
    }
    crate::remote::emit_event(&app, &format!("omp-status://{id}"), &serde_json::json!({"state":"running"}));
    Ok(())
}

/// `check_paths` 的单条结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathCheck {
    pub path: String,
    pub exists: bool,
    pub is_dir: bool,
    /// **短标签还原出的真实相对路径**（`components/` → `src/views/…/components/`）。
    /// 直接可解析（本来就是真实路径）时为 None——不需要替换；解不出来（歧义 / 没有）也是 None。
    pub resolved: Option<String>,
}

/// 相对路径按 base 解析并做**词法归一**（不触碰文件系统）：`.` 丢弃、`..` 回退一层。
/// 绝对路径原样使用。
pub fn resolve_path(base: &str, p: &str) -> PathBuf {
    // 绝对路径的三种写法：POSIX `/...`、Windows 盘符 `C:\...` / `C:/...`、
    // UNC `\\server\share`。`Path::is_absolute()` 在 Windows 上认后两种，
    // 但 POSIX 风格在 Windows 上不是 absolute（没有盘符），所以显式补 `/`。
    let absolute = Path::new(p).is_absolute() || p.starts_with('/') || p.starts_with('\\');
    let raw = if absolute { PathBuf::from(p) } else { PathBuf::from(base).join(p) };
    let mut out = PathBuf::new();
    for c in raw.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `@` 路径补全的单条候选（只读目录列举，不读文件内容）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathCandidate {
    /// 展示 / 定位用的路径（相对 base；短标签补全时保持用户写的前缀）。
    pub path: String,
    /// **真实相对路径**：写进输入框芯片、最终交给 omp 的形态（一层列举时可能与 `path` 不同，
    /// 例如用户写的 `@components/` 前缀挡在前面，真实路径是 `src/views/…/components`）。
    pub real: String,
    pub is_dir: bool,
    /// 输入框里显示的**短标签**（最短唯一后缀；目录由前端补尾斜杠）。
    pub label: String,
}

/// 候选批量补标签：一次索引查询（`entries_for` 有 30s 缓存）。
fn with_labels(base: &str, rows: Vec<(String, String, bool)>) -> Vec<PathCandidate> {
    let targets: Vec<String> = rows.iter().map(|(_, real, _)| real.clone()).collect();
    let all = crate::workspace_fs::entries_for(base);
    let labels = crate::workspace_fs::unique_labels(&all, &targets);
    rows.into_iter()
        .map(|(path, real, is_dir)| {
            let label = labels.get(&real).cloned().unwrap_or_else(|| real.clone());
            PathCandidate { path, real, is_dir, label }
        })
        .collect()
}

/// 输入框 `@` 补全的取词（同步纯逻辑，便于单测）：按当前 token 给候选（最多 `limit` 条）。
///
/// 两种口径：
/// - **一层**（空 token 的 `@`、带目录的 `@src/components/`）→ 列那个目录（快，够用）；
///   目录名也可能是**短标签**（`@components/`）——直接解析不到时按后缀反解出真实目录再列，
///   候选仍按用户写的前缀展示（这样「选中短标签后继续往里打」的链路是连贯的）。
/// - **有名字、还没写目录**（`@baselin`）→ 递归搜名字（忽略大小写、名字包含，浅层与前缀命中优先）。
///   ——只列一层的话，目标在子目录里（`tracsys_web/baseline/`）时补全永远搜不到，
///   用户只能手打整条路径；这也正是「`@` 有弹窗、继续输入就消失」的根因。
pub fn complete_candidates(base: &str, prefix: &str, limit: usize) -> Vec<PathCandidate> {
    if base.is_empty() || prefix.contains('\0') || limit == 0 {
        return vec![];
    }
    // token 含目录分隔符时按最后一段做前缀，搜索目录为前面部分
    let (dir_rel, file_prefix) = match prefix.rsplit_once('/') {
        Some((d, f)) => (d.to_string(), f.to_string()),
        None => (String::new(), prefix.to_string()),
    };
    if file_prefix.contains("..") || dir_rel.contains("..") {
        return vec![];
    }
    // 有名字、没写目录：递归搜（`search_entries` 自带扫描预算与相关度排序）
    if dir_rel.is_empty() && !file_prefix.is_empty() {
        let rows: Vec<(String, String, bool)> = crate::workspace_fs::search_entries(base, &file_prefix, limit)
            .0
            .into_iter()
            .map(|hit| (hit.rel.clone(), hit.rel, hit.is_dir))
            .collect();
        return with_labels(base, rows);
    }
    // 一层：先按真实目录解析；解析不到再当短标签反解（`@components/`）
    let direct = if dir_rel.is_empty() {
        Some(PathBuf::from(base))
    } else {
        let candidate = resolve_path(base, &dir_rel);
        candidate.is_dir().then_some(candidate)
    };
    let (dir, real_prefix) = match direct {
        Some(dir) => (dir, dir_rel.clone()),
        None => {
            let all = crate::workspace_fs::entries_for(base);
            match crate::workspace_fs::resolve_suffix(&all, &dir_rel) {
                Some((rel, true)) => (resolve_path(base, &rel), rel),
                _ => return vec![],
            }
        }
    };
    let entries = std::fs::read_dir(&dir)
        .map(|rd| rd.filter_map(|e| e.ok()).take(200).collect::<Vec<_>>())
        .unwrap_or_default();
    let needle = file_prefix.to_lowercase();
    let mut rows: Vec<(String, String, bool)> = entries
        .into_iter()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || !name.to_lowercase().starts_with(&needle) {
                return None;
            }
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            // `path` = 用户视角（保持他写的前缀）；`real` = 真实相对路径（算标签用）
            let path = if dir_rel.is_empty() { name.clone() } else { format!("{dir_rel}/{name}") };
            let real = if real_prefix.is_empty() { name } else { format!("{real_prefix}/{name}") };
            Some((path, real, is_dir))
        })
        .collect();
    rows.sort_by(|a, b| match (a.2, b.2) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.0.cmp(&b.0),
    });
    rows.truncate(limit);
    with_labels(base, rows)
}

/// 输入框 `@` 补全：只读目录 / 名字，不读文件内容（取词见 `complete_candidates`）。
#[tauri::command]
pub async fn complete_path(base: String, prefix: String) -> Vec<PathCandidate> {
    if base.is_empty() || prefix.contains('\0') {
        return vec![];
    }
    // 递归搜索 / 后缀反解是磁盘活：放阻塞线程池，不占 tokio worker
    tauri::async_runtime::spawn_blocking(move || complete_candidates(&base, &prefix, 20))
        .await
        .unwrap_or_default()
}

/// 引用注入用的**短标签**：路径 → 最短唯一后缀（`components`、`FileTree.tsx`）。
///
/// 入参可以是绝对路径，也可以是相对 `base` 的路径；会话目录之外的条目原样返回
/// （跨项目引用仍用绝对路径，见 `lib/workspaceFiles.ts`）。
#[tauri::command]
pub async fn mention_label(base: String, path: String) -> String {
    if base.is_empty() || path.is_empty() {
        return path;
    }
    let abs = if Path::new(&path).is_absolute() || path.starts_with('/') || path.starts_with('\\') {
        path.clone()
    } else {
        resolve_path(&base, &path).to_string_lossy().into_owned()
    };
    let Some(rel) = crate::workspace_fs::rel_to(&base, &abs) else {
        return path;
    };
    let fallback = rel.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let all = crate::workspace_fs::entries_for(&base);
        let labels = crate::workspace_fs::unique_labels(&all, std::slice::from_ref(&rel));
        labels.get(&rel).cloned().unwrap_or(rel)
    })
    .await
    .unwrap_or(fallback)
}

/// 直接解析（相对 / 绝对路径）命中时的回执；解析不到返回 None 交给后缀反解。
fn check_direct(base: &str, token: &str) -> Option<PathCheck> {
    let meta = std::fs::metadata(resolve_path(base, token)).ok()?;
    Some(PathCheck { path: token.to_string(), exists: true, is_dir: meta.is_dir(), resolved: None })
}

/// 短标签后缀反解：唯一命中就是它（`resolved` 给出真实相对路径），歧义 / 没有一律记不存在。
fn check_suffix(base: &str, token: &str, table: &[(String, bool)]) -> PathCheck {
    match crate::workspace_fs::resolve_suffix(table, token) {
        // 表是缓存的，落盘状态再确认一次（文件可能刚被删 / 刚加）
        Some((rel, is_dir)) if std::fs::metadata(resolve_path(base, &rel)).is_ok() => {
            PathCheck { path: token.to_string(), exists: true, is_dir, resolved: Some(rel) }
        }
        _ => PathCheck { path: token.to_string(), exists: false, is_dir: false, resolved: None },
    }
}

/// 输入框 `@提及` 的存在性提示（V2 M6b）：只 stat，不读内容、不写任何东西。
///
/// 解析两级：**直接解析**（相对 / 绝对路径）→ **短标签后缀反解**（唯一才认）→ 记不存在。
/// 前者命中时 `resolved` 为 None（本来就是真路径）；后者给 `resolved`（发送前按它展开）。
#[tauri::command]
pub async fn check_paths(base: String, paths: Vec<String>) -> Vec<PathCheck> {
    let tokens: Vec<String> = paths.into_iter().take(50).collect();
    if tokens.is_empty() {
        return vec![];
    }
    tauri::async_runtime::spawn_blocking(move || {
        // 后缀反解要全库条目（有 30s 缓存）：只在「直接解析失败」时才取，省掉常见路径的那一趟
        let mut table: Option<std::sync::Arc<Vec<(String, bool)>>> = None;
        let mut out = Vec::with_capacity(tokens.len());
        for token in tokens {
            let check = match check_direct(&base, &token) {
                Some(hit) => hit,
                None => {
                    let entries = table
                        .get_or_insert_with(|| crate::workspace_fs::entries_for(&base))
                        .clone();
                    check_suffix(&base, &token, &entries)
                }
            };
            out.push(check);
        }
        out
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn set_model(app: AppHandle, state: State<'_, AppState>, id: String, provider: String, model_id: String) -> Result<(), CmdError> {
    let map = state.runtime.clone();
    let tx = map.lock().await.get(&id).map(|r| r.tx.clone());
    let Some(tx) = tx else {
        return Err(cmd_err("NOT_RUNNING", "会话未运行，无法切换模型".into(), None));
    };
    let req = serde_json::json!({"id": format!("m-{}", chrono::Utc::now().timestamp_millis()), "type": "set_model", "provider": provider, "modelId": model_id});
    tx.send(format!("{}\n", serde_json::to_string(&req).unwrap()))
        .map_err(|_| cmd_err("RPC_IO", "切换模型失败，进程可能已退出".into(), None))?;
    let _ = app;
    Ok(())
}

#[tauri::command]
pub async fn set_thinking(app: AppHandle, state: State<'_, AppState>, id: String, level: String) -> Result<(), CmdError> {
    if !["off","minimal","low","medium","high","xhigh","max","auto"].contains(&level.as_str()) {
        return Err(cmd_err("BAD_ARG", "思考档非法".into(), None));
    }
    let map = state.runtime.clone();
    let tx = map.lock().await.get(&id).map(|r| r.tx.clone());
    let Some(tx) = tx else {
        return Err(cmd_err("NOT_RUNNING", "会话未运行，无法切换思考档".into(), None));
    };
    let req = serde_json::json!({"id": format!("t-{}", chrono::Utc::now().timestamp_millis()), "type": "set_thinking_level", "level": level});
    tx.send(format!("{}\n", serde_json::to_string(&req).unwrap()))
        .map_err(|_| cmd_err("RPC_IO", "切换思考档失败，进程可能已退出".into(), None))?;
    let _ = app;
    Ok(())
}

/// 会话运行时真值（模型 / 可用思考档 / 当前档）。会话未运行返回 `None`。
/// 前端打开会话后拉一次做回填；其后的变化经 `omp-state://<id>` 推送。
#[tauri::command]
pub async fn get_session_runtime(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<crate::runtime::SessionMeta>, CmdError> {
    let map = state.runtime.lock().await;
    Ok(map.get(&id).map(|r| {
        let mut meta = r.meta.clone();
        // 活动态真值：状态事件是推送，前端切走期间收不到——回读把当前状态带上，
        // 切回一个正在跑的会话才不会被显示成 idle（见 `SessionMeta.status`）。
        meta.status = Some(crate::runtime::activity_state_label(r.activity.state()).to_string());
        meta
    }))
}

/// 全局权限档（`tools.approvalMode`，读 omp 全局配置；cwd 钉 agentDir 与设置页同层）。
///
/// omp 定位走 `discover_omp_path`（唯一入口）而不是 `state.omp_path`：前端**启动时**就水合档位，
/// 那一刻健康检查（`locate_omp`）还没落位 `state.omp_path`——读它会拿到「未找到 omp」，
/// 输入卡上的档位就一直卡在「读取中…」，直到用户打开菜单补读成功。
#[tauri::command]
pub async fn get_global_approval(state: State<'_, AppState>) -> Result<String, CmdError> {
    let Some(p) = discover_omp_path(&state) else {
        return Err(cmd_err("OMP_MISSING", "未找到 omp".into(), None));
    };
    // 顺手落定位缓存（与 `load_catalog` 同口径）：诊断还没跑完时，读 `state.omp_path` 的
    // 路径（新建会话 / 起 runtime）也能直接用
    *state.omp_path.lock().await = Some(p.clone());
    let dir = state.agent_dir.lock().await.clone();
    let cwd = dir.is_dir().then_some(dir.as_path());
    let out = crate::providers::run_omp_in(cwd, &p, &["config", "get", "tools.approvalMode", "--json"])
        .await
        .map_err(|e| cmd_err("CONFIG_READ", format!("读取权限失败：{e}"), None))?;
    let v: serde_json::Value = serde_json::from_str(out.trim()).map_err(|e| cmd_err("CONFIG_PARSE", format!("解析失败：{e}"), None))?;
    Ok(v.get("value").and_then(|x| x.as_str()).unwrap_or("write").to_string())
}

/// omp 全局「默认思考等级」（`defaultThinkingLevel`，读 omp 全局配置；cwd 钉 agentDir 与设置页同层）。
/// 前端思考档选择器的默认显示与壳侧切模型兜底（`runtime::auto_think_level`）共用这一份配置。
#[tauri::command]
pub async fn get_default_thinking_level(
    state: State<'_, AppState>,
) -> Result<Option<String>, CmdError> {
    Ok(crate::settings::read_default_thinking_level(&state).await)
}

/// 写全局权限档（`omp config set tools.approvalMode`）。
#[tauri::command]
pub async fn set_global_approval(state: State<'_, AppState>, mode: String) -> Result<(), CmdError> {
    if !["always-ask", "write", "yolo"].contains(&mode.as_str()) {
        return Err(cmd_err("BAD_ARG", "权限档必须是 always-ask/write/yolo".into(), None));
    }
    let Some(p) = discover_omp_path(&state) else {
        return Err(cmd_err("OMP_MISSING", "未找到 omp".into(), None));
    };
    let dir = state.agent_dir.lock().await.clone();
    let cwd = dir.is_dir().then_some(dir.as_path());
    crate::providers::run_omp_in(cwd, &p, &["config", "set", "tools.approvalMode", "--", &mode])
        .await
        .map(|_| ())
        .map_err(|e| cmd_err("CONFIG_WRITE", format!("写入权限失败：{e}"), None))
}

/// 会话级权限覆盖（覆盖层 `sessionApproval`；None = 移除覆盖回全局档）。
#[tauri::command]
pub async fn set_session_approval(state: State<'_, AppState>, id: String, mode: Option<String>) -> Result<(), CmdError> {
    if let Some(m) = &mode {
        if !["always-ask", "write", "yolo"].contains(&m.as_str()) {
            return Err(cmd_err("BAD_ARG", "权限档必须是 always-ask/write/yolo".into(), None));
        }
    }
    {
        let mut ov = state.overlay.lock().await;
        match mode {
            Some(m) => {
                ov.session_approval.insert(id, m);
            }
            None => {
                ov.session_approval.remove(&id);
            }
        }
    }
    save_overlay(&state).map_err(|e| cmd_err("OVERLAY_WRITE", e, None))?;
    Ok(())
}

/// 输入框上方上下文条的 git **只读**查询：当前分支 + 本地分支清单 + 脏工作区标记。
/// 目录不存在 / 不是仓库 / 找不到 git 都返回降级值（`isRepo:false`），不算命令失败——
/// 前端据此只隐藏分支展示，绝不把「这里不是 git 仓库」变成一条错误横幅。
#[tauri::command]
pub async fn get_git_info(path: String) -> Result<crate::git_info::GitInfo, CmdError> {
    if !crate::git_info::dir_exists(&path) {
        return Ok(crate::git_info::GitInfo::not_repo(Some("目录不存在".into())));
    }
    let Some(git) = crate::git_info::git_bin().await else {
        return Ok(crate::git_info::GitInfo::not_repo(Some("未找到 git".into())));
    };
    Ok(crate::git_info::read_git_info(&git, &path).await)
}

pub fn load_state<R: tauri::Runtime>(app: &AppHandle<R>) -> AppState {
    let dir = app.path().app_data_dir().ok();
    let overlay_path = dir
        .clone()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join("omp-inn")
        .join("overlay.json");
    let (ov, reset) = load_overlay(&overlay_path);
    if reset {
        let _ = std::fs::create_dir_all(overlay_path.parent().unwrap());
        let _ = std::fs::write(&overlay_path, serde_json::to_string_pretty(&ov).unwrap());
    }
    // 使用统计账本：拿不到应用数据目录就退化成空账本（统计照跑，只少「已删除会话」那一块）
    let usage_ledger = match dir {
        Some(d) => crate::usage::UsageLedger::new(d.join("omp-inn").join("usage-ledger.jsonl")),
        None => crate::usage::UsageLedger::disabled(),
    };
    AppState {
        overlay_path,
        overlay: Mutex::new(ov),
        agent_dir: Mutex::new(resolve_agent_dir(None)),
        omp_path: Mutex::new(None),
        omp_version: Mutex::new(None),
        models_cache: Mutex::new(None),
        models_fetch: Mutex::new(()),
        login: std::sync::Arc::new(Mutex::new(None)),
        login_status: std::sync::Arc::new(Mutex::new(Default::default())),
        roles_edit: Mutex::new(()),
        retry_edit: Mutex::new(()),
        models_edit: Mutex::new(()),
        constraints_edit: Mutex::new(()),
        extensions_edit: Mutex::new(()),
        runtime: std::sync::Arc::new(Mutex::new(HashMap::new())),
        runtime_recovery: Mutex::new(HashMap::new()),
        terminals: std::sync::Arc::new(std::sync::Mutex::new(HashMap::new())),
        commit_tasks: std::sync::Arc::new(std::sync::Mutex::new(HashMap::new())),
        omp_update_task: std::sync::Arc::new(std::sync::Mutex::new(None)),
        usage_ledger,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_project_order, assign_members, catalog_fresh, check_direct, check_suffix, clean_workspace_name,
        complete_candidates,
        derived_title, display_title, discover_omp_path, get_global_approval, kill_runtime, list_archived_in,
        load_cached, load_state, owner_project, plan_after_rejected_params, rpc_request, scan_window,
        session_file_for, spawn_session_runtime, stderr_first_line, AppState, Plan, MODELS_TTL_MS,
    };
    use crate::overlay::{Overlay, Project};
    use std::collections::HashMap;

    /// `@` 补全取词：一层列举 / 递归搜索两条口径。
    /// 用户实测的坑：只列一层时，目标在子目录里就「`@` 有弹窗、继续输入就消失」。
    #[test]
    fn complete_mentions_search_nested_names() {
        let root = std::env::temp_dir().join(format!("omp-inn-complete-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("Baseline")).unwrap();
        std::fs::write(root.join("src/baseline_utils.ts"), "x").unwrap();
        std::fs::write(root.join("README.md"), "x").unwrap();
        let base = root.to_str().unwrap();

        // 空 token（刚打 `@`）：只列一层，目录优先、不递归
        let top = complete_candidates(base, "", 20);
        assert_eq!(top.first().map(|c| c.path.as_str()), Some("Baseline"), "{top:?}");
        assert!(top.iter().all(|c| !c.path.contains('/')), "空 token 不该递归：{top:?}");

        // 有名字、没写目录：递归搜 + 忽略大小写（一层里的 Baseline 与子目录里的文件都出）
        let hits = complete_candidates(base, "baselin", 20);
        let paths: Vec<&str> = hits.iter().map(|c| c.path.as_str()).collect();
        assert!(paths.contains(&"Baseline"), "{paths:?}");
        assert!(paths.contains(&"src/baseline_utils.ts"), "子目录里的匹配也要出：{paths:?}");
        assert!(complete_candidates(base, "BASELIN", 20).iter().any(|c| c.path == "Baseline"));

        // 带目录（`@src/`）：只列那一层，路径带目录前缀
        let in_src = complete_candidates(base, "src/", 20);
        assert!(!in_src.is_empty());
        assert!(in_src.iter().all(|c| c.path.starts_with("src/")), "{in_src:?}");

        // 越界 / 空 base / limit 的边界
        assert!(complete_candidates(base, "../x", 20).is_empty());
        assert!(complete_candidates("", "x", 20).is_empty());
        assert!(complete_candidates(base, "baselin", 0).is_empty());
        assert_eq!(complete_candidates(base, "baselin", 1).len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 短标签（尾段式 mention）：标签唯一、后缀反解、歧义不猜、补全能沿短标签继续往里打。
    #[test]
    fn mention_short_labels_round_trip() {
        let root = std::env::temp_dir().join(format!("omp-inn-label-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let deep = root.join("src/views/engineering/baseline/components");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("FileTree.tsx"), "x").unwrap();
        std::fs::write(root.join("README.md"), "x").unwrap();
        let base = root.to_str().unwrap();
        let table = crate::workspace_fs::collect_entries(base);

        // 最短唯一后缀：目录给 `components`、文件给 `FileTree.tsx`（尾段唯一就用尾段）
        let labels = crate::workspace_fs::unique_labels(
            &table,
            &[
                "src/views/engineering/baseline/components".to_string(),
                "src/views/engineering/baseline/components/FileTree.tsx".to_string(),
            ],
        );
        assert_eq!(labels["src/views/engineering/baseline/components"], "components");
        assert_eq!(labels["src/views/engineering/baseline/components/FileTree.tsx"], "FileTree.tsx");

        // 存在性：绝对路径直接命中（resolved 为 None）；短标签走反解并给出真实相对路径
        assert!(check_direct(base, &deep.to_string_lossy()).is_some());
        let dir_check = check_suffix(base, "components/", &table);
        assert!(dir_check.exists && dir_check.is_dir);
        assert_eq!(dir_check.resolved.as_deref(), Some("src/views/engineering/baseline/components"));
        let file_check = check_suffix(base, "FileTree.tsx", &table);
        assert!(file_check.exists && !file_check.is_dir);
        assert_eq!(
            file_check.resolved.as_deref(),
            Some("src/views/engineering/baseline/components/FileTree.tsx")
        );
        assert!(!check_suffix(base, "nope", &table).exists);

        // 短标签后继续往里打：候选按用户写的前缀展示，同时带上自己的标签
        let nested = complete_candidates(base, "components/", 20);
        assert_eq!(nested.len(), 1);
        assert_eq!(nested[0].path, "components/FileTree.tsx");
        assert_eq!(nested[0].label, "FileTree.tsx");

        // 同名目录出现 → 标签歧义 → 不存在（不猜）；加一层父目录就唯一了
        std::fs::create_dir_all(root.join("other/components")).unwrap();
        let table2 = crate::workspace_fs::collect_entries(base);
        assert!(!check_suffix(base, "components/", &table2).exists);
        assert!(check_suffix(base, "baseline/components/", &table2).exists);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `stderr_first_line`：从「omp 输出：xxx（yyy）」里取回 omp 的原话；
    /// 没有那段标记（不是启动失败类错误）就回 `None`，不许瞎猜。
    #[test]
    fn stderr_first_line_extracts_omp_reason() {
        assert_eq!(
            stderr_first_line("omp 在就绪前退出（omp 输出：Model \"a/b\" not found（did you mean a/c?））").as_deref(),
            Some("Model \"a/b\" not found（did you mean a/c?）"),
            "只脱壳加的那一层：omp 原话里的括号要留着"
        );
        // 单层括号（单行 stderr）：括号是壳加的，一并剥掉
        assert_eq!(
            stderr_first_line("omp 在就绪前退出（omp 输出：No models available）").as_deref(),
            Some("No models available")
        );
        // 消息里那层包裹括号与 omp 自己的括号同在：只脱壳加的那一层，
        // omp 原话（含它自己的括号）完整留下
        assert_eq!(
            stderr_first_line("omp 在就绪前退出（omp 输出：Model \"x\" not found（Run omp models find））").as_deref(),
            Some("Model \"x\" not found（Run omp models find）")
        );
        assert_eq!(stderr_first_line("目录不存在"), None);
        assert_eq!(stderr_first_line("omp 输出：").as_deref(), None);
    }

    /// 参数被 omp 拒绝后的三档决策（用户实测的坑：覆盖层里的失效模型让新建会话整条失败）。
    #[test]
    fn rejected_params_decision_paths() {
        let err = crate::commands::cmd_err(
            "RPC_EOF",
            "omp 在就绪前退出（omp 输出：Model \"ccproxy/deepseek/deepseek-v4.1-flash-fast\" not found）".into(),
            None,
        );
        let model = Some("ccproxy/deepseek/deepseek-v4.1-flash-fast".to_string());
        let thinking = Some("max".to_string());
        let ok = |with_model: bool| {
            let mut meta = crate::runtime::SessionMeta::default();
            if with_model {
                meta.model = Some(crate::runtime::ModelRef { provider: "deepseek".into(), id: "deepseek-flash".into(), name: None });
            }
            Ok(("sid-1".to_string(), "/tmp/x.jsonl".to_string(), meta))
        };

        // ① 重试成功且拿到模型 = 偏好失效：降级成立，且要求清掉那对失效偏好（自愈）
        match plan_after_rejected_params(&err, ok(true), &model, &thinking) {
            Plan::Degraded { fallback, forget, .. } => {
                assert!(fallback.fallback_model, "拿到模型 ⇒ 是偏好被拒");
                assert_eq!(fallback.model.as_deref(), Some("ccproxy/deepseek/deepseek-v4.1-flash-fast"));
                assert_eq!(fallback.thinking.as_deref(), Some("max"));
                assert!(fallback.detail.as_deref().unwrap_or("").contains("not found"), "说明里要带 omp 原话");
                assert_eq!(forget, Some(("ccproxy/deepseek/deepseek-v4.1-flash-fast".to_string(), "max".to_string())));
            }
            _ => panic!("应判定为降级成功"),
        }

        // ② 重试成功但没模型 = 问题不在偏好上：不走「偏好失效」那档，也不动用户的项目偏好
        match plan_after_rejected_params(&err, ok(false), &model, &thinking) {
            Plan::Degraded { fallback, forget, .. } => {
                assert!(!fallback.fallback_model, "omp 侧就没有可用模型 ⇒ 不能把责任推给项目偏好");
                assert_eq!(forget, None, "不许清用户偏好");
            }
            _ => panic!("应判定为降级成功"),
        }

        // ③ 两次都失败：两段原因都要在（只报后者会把「参数被拒」这个真因藏掉）
        let e2 = crate::commands::cmd_err("SPAWN_FAILED", "启动 omp 失败：权限不足".into(), None);
        match plan_after_rejected_params(&err, Err(e2), &model, &thinking) {
            Plan::GiveUp(e) => {
                assert!(e.message.contains("not found"), "要带首发被拒的原因：{}", e.message);
                assert!(e.message.contains("权限不足"), "要带重试失败的原因：{}", e.message);
            }
            _ => panic!("应判定为放弃"),
        }
    }

    /// 显示标题的兜底链（V44）：备注 > omp 真标题 > 首条用户消息派生（12 字 + 省略号）> 未命名 + 日期。
    /// 派生档服务的是 rpc-ui 会话——omp 在该模式强制 `PI_NO_TITLE=1`，从来没有自动标题。
    #[test]
    fn display_title_fallback_chain() {
        let note = "我的备注".to_string();
        let ts = 1_760_000_000_000_i64; // 2025-10-09（UTC）
        // 备注最优先（即便 omp 真标题与派生源都在）
        assert_eq!(display_title(Some(&note), "真标题", Some("首条消息"), ts), "我的备注");
        // 空白备注不算
        let blank = "   ".to_string();
        assert_eq!(display_title(Some(&blank), "真标题", None, ts), "真标题");
        // 真标题 > 派生
        assert_eq!(display_title(None, "真标题", Some("首条消息"), ts), "真标题");
        // 无真标题：首条用户消息派生
        assert_eq!(display_title(None, "", Some("  帮我把登录页重构一下  "), ts), "帮我把登录页重构一下");
        assert_eq!(display_title(None, "  ", Some("帮我把登录页重构一下登录页重构一下"), ts), "帮我把登录页重构一下登录…");
        // 都没有：未命名 + 日期
        assert!(display_title(None, "", None, ts).starts_with("未命名会话 "));
        assert!(display_title(None, "", Some("   "), ts).starts_with("未命名会话 "), "纯空白派生源不算");
    }

    #[test]
    fn derived_title_folds_and_truncates() {
        assert_eq!(derived_title("第一行\n第二行   第三行").as_deref(), Some("第一行 第二行 第三行"));
        // 恰好 12 字符：原样
        assert_eq!(derived_title("一二三四五六七八九十一二").as_deref(), Some("一二三四五六七八九十一二"));
        // 13 字符：截到 12 + 省略号（按字符不按字节——中文不许切坏）
        assert_eq!(derived_title("一二三四五六七八九十一二三").as_deref(), Some("一二三四五六七八九十一二…"));
        assert_eq!(derived_title("   "), None);
    }

    /// V21 工作区成员重设：在列表里的进组（跨组则改归属），其余原成员回归未分组。
    #[test]
    fn assign_members_moves_and_releases() {
        let mk = |id: &str, ws: Option<&str>| Project {
            id: id.into(),
            path: format!("/{id}"),
            workspace_id: ws.map(|s| s.to_string()),
            ..Default::default()
        };
        let mut ov = Overlay {
            version: 1,
            projects: vec![mk("p1", None), mk("p2", Some("w1")), mk("p3", Some("w2"))],
            ..Default::default()
        };
        // p1 进 w1、p2 留在 w1、p3 从 w2 改归 w1；未知 id 静默忽略
        assign_members(&mut ov, "w1", &["p1".into(), "p2".into(), "p3".into(), "ghost".into()]);
        assert_eq!(ov.projects[0].workspace_id.as_deref(), Some("w1"));
        assert_eq!(ov.projects[1].workspace_id.as_deref(), Some("w1"));
        assert_eq!(ov.projects[2].workspace_id.as_deref(), Some("w1"));
        // 再用只含 p2 的列表更新 w1：p1 / p3 回归未分组
        assign_members(&mut ov, "w1", &["p2".into()]);
        assert_eq!(ov.projects[0].workspace_id, None);
        assert_eq!(ov.projects[1].workspace_id.as_deref(), Some("w1"));
        assert_eq!(ov.projects[2].workspace_id, None);
    }

    /// 左栏拖拽排序（V26）：`order` 认得的按序在前、认不得的忽略、缺席的按原相对顺序补末尾。
    #[test]
    fn apply_project_order_keeps_every_project() {
        let mk = |id: &str| Project { id: id.into(), path: format!("/{id}"), ..Default::default() };
        let out = apply_project_order(
            vec![mk("a"), mk("b"), mk("c")],
            &["c".into(), "ghost".into(), "a".into()],
        );
        let ids: Vec<&str> = out.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["c", "a", "b"]);
        // 空 order 原样返回
        let same = apply_project_order(vec![mk("a"), mk("b")], &[]);
        assert_eq!(same.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
    }

    /// 工作区名清洗：首尾空白裁掉、内部换行折成空格；全空白 = 空（调用方拒绝）。
    #[test]
    fn clean_workspace_name_trims_and_flattens() {
        assert_eq!(clean_workspace_name("  全栈  "), "全栈");
        assert_eq!(clean_workspace_name("front\nback"), "front back");
        assert_eq!(clean_workspace_name(" \t \n "), "");
    }

    /// 会话归属：与 `list_sessions` 同一条规则（真实路径前缀匹配、最长优先）。
    #[test]
    fn owner_project_matches_by_real_prefix() {
        // 用**真实存在**的临时目录：路径归一依赖 canonicalize，纯字符串造的数据在
        // macOS（/tmp 是 /private/tmp 的符号链接）与 Linux 上行为不同——CI 的 Linux
        // runner 上翻过车（不存在的 /tmp/x 被当成 /private/tmp/x）。
        let root = std::env::temp_dir().join(format!("omp-owner-test-{}", std::process::id()));
        let demo = root.join("demo");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(demo.join("sub")).unwrap();
        std::fs::create_dir_all(root.join("other")).unwrap();
        let p = |x: &std::path::Path| x.to_string_lossy().to_string();

        let projects = vec![
            ("p1".to_string(), p(&root)),
            ("p2".to_string(), p(&demo)),
        ];
        // 子目录归最长的那个项目，父目录归父项目
        assert_eq!(owner_project(&projects, &p(&demo.join("sub"))).as_deref(), Some("p2"));
        assert_eq!(owner_project(&projects, &p(&root.join("other"))).as_deref(), Some("p1"));
        // 符号链接写法与真实路径必须归到同一个项目（macOS 的 /tmp ↔ /private/tmp 同一机制）
        #[cfg(unix)]
        {
            let link = root.join("link");
            std::os::unix::fs::symlink(&demo, &link).unwrap();
            std::fs::create_dir_all(link.join("sub")).unwrap();
            assert_eq!(owner_project(&projects, &p(&link.join("sub"))).as_deref(), Some("p2"));
        }
        // 读不到 cwd（新会话懒写盘）不归属，由调用方决定兜底
        assert_eq!(owner_project(&projects, ""), None);
        assert_eq!(owner_project(&[], &p(&demo)), None);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 在临时目录里造一个 sessions/<slug>/*.jsonl 结构（归档清单的测试用）。
    fn tmp_sessions_root(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("omp-search-test-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("--tmp-demo--")).unwrap();
        root
    }

    fn write_session(root: &std::path::Path, file: &str, id: &str, title: &str, lines: &[&str]) {
        let mut body = format!(
            "{}\n",
            serde_json::json!({"type":"session","id":id,"timestamp":"2026-09-15T10:00:00.000Z","cwd":"/tmp/demo","title":title})
        );
        for l in lines {
            body.push_str(l);
            body.push('\n');
        }
        std::fs::write(root.join("--tmp-demo--").join(file), body).unwrap();
    }

    #[test]
    fn list_archived_in_lists_only_archived_and_maps_project() {
        let root = tmp_sessions_root("arch");
        write_session(&root, "2026-09-15T10-00-00_s-keep.jsonl", "s-keep", "保住的会话", &[]);
        write_session(&root, "2026-09-15T11-00-00_s-live.jsonl", "s-live", "没归档的会话", &[]);
        let archived = HashMap::from([
            ("s-keep".to_string(), true),
            ("s-live".to_string(), false),
            // 覆盖层里的失效 id（文件已删）：定位不到就落空，不该冒出一条空壳
            ("s-gone".to_string(), true),
        ]);
        let projects = vec![("p1".to_string(), "/tmp/demo".to_string())];
        let notes = HashMap::from([("s-keep".to_string(), "备注名".to_string())]);
        let out = list_archived_in(&root, &archived, &projects, &HashMap::new(), &notes);
        assert_eq!(out.len(), 1, "只列归档的：没归档与失效 id 都不进");
        assert_eq!(out[0].id, "s-keep");
        assert_eq!(out[0].title, "备注名", "备注覆盖标题，与左栏同一口径");
        assert_eq!(out[0].project_id.as_deref(), Some("p1"), "按 cwd 归属回项目 id");
        assert!(out[0].archived);
        assert!(!out[0].corrupt);
    }

    #[test]
    fn list_archived_in_sorts_newest_first_and_keeps_orphans() {
        let root = tmp_sessions_root("arch-sort");
        let head = |id: &str, title: &str, ts: &str| {
            format!(
                "{}\n",
                serde_json::json!({"type":"session","id":id,"timestamp":ts,"cwd":"/tmp/demo","title":title})
            )
        };
        let dir = root.join("--tmp-demo--");
        // 文件名按真实布局带会话 id（`<时间戳>_<id>.jsonl`）：覆盖层里的 id 靠文件名里的前缀定位
        std::fs::write(dir.join("2026-09-14T10-00-00Z_s-old.jsonl"), head("s-old", "旧的", "2026-09-14T10:00:00.000Z")).unwrap();
        std::fs::write(dir.join("2026-09-16T10-00-00Z_s-new.jsonl"), head("s-new", "新的", "2026-09-16T10:00:00.000Z")).unwrap();
        let archived = HashMap::from([("s-old".to_string(), true), ("s-new".to_string(), true)]);
        let out = list_archived_in(&root, &archived, &[], &HashMap::new(), &HashMap::new());
        assert_eq!(
            out.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec!["s-new", "s-old"],
            "最新归档排前面"
        );
        assert!(out.iter().all(|s| s.project_id.is_none()), "没有项目时全部算未归属");
    }

    /// 会话定位（`session_file_for`）只认**完整 id**：8 字符前缀在同一分钟内建的两个会话间
    /// 必然相同（uuid v7 前 8 位 = 毫秒时间戳高 32 位），拿前缀找文件会命中「文件名更大的
    /// 那个」= **另一个会话**——真机表现：读历史读错文件、删除删错文件、`--resume` 拉起
    /// 另一个会话（omp 侧同口径取最新，实测）。
    #[test]
    fn session_file_for_matches_full_id_only() {
        let root = std::env::temp_dir().join(format!("omp-session-id-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sessions").join("--tmp-demo--")).unwrap();
        let dir = root.join("sessions");
        // 同一分钟建的两个会话（真机形状：id 前 8 位相同）
        let old_id = "01a123c6-9b8c-76a4-85ab-10ba5ee9d179";
        let new_id = "01a123c6-f958-7524-b1be-53b4fb030bf6";
        let old_file = "2026-10-10T03-06-20-940Z_01a123c6-9b8c-76a4-85ab-10ba5ee9d179.jsonl";
        let new_file = "2026-10-10T03-06-44-952Z_01a123c6-f958-7524-b1be-53b4fb030bf6.jsonl";
        write_session(&dir, old_file, old_id, "旧会话", &[]);
        write_session(&dir, new_file, new_id, "新会话", &[]);

        assert_eq!(session_file_for(&root, old_id).unwrap(), dir.join("--tmp-demo--").join(old_file));
        assert_eq!(session_file_for(&root, new_id).unwrap(), dir.join("--tmp-demo--").join(new_file));
        // 8 字符前缀不再命中任何文件（旧的 contains 口径会命中更大的那个 = 新会话）
        assert!(session_file_for(&root, "01a123c6").is_none());
        // 损坏兜底给的「文件名主干」id 也能定位自己
        assert_eq!(
            session_file_for(&root, "2026-10-10T03-06-20-940Z_01a123c6-9b8c-76a4-85ab-10ba5ee9d179").unwrap(),
            dir.join("--tmp-demo--").join(old_file)
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 整条修复的端到端回归（用户实测的现场）：项目里留着 omp 已不认的模型，
    /// 「选项目 → 新建会话」必须还能建起来。
    ///
    /// 桩 omp 精确复现现场：**带 `--model` 就拒绝并退出**（真实 omp 对非法模型就是这个行为，
    /// `Error: Model "…" not found`，stdout 一帧都没有），不带就正常三行握手。
    /// 断言三件事：① 会话真的建起来了（降级重试生效）；② 说明里带上失效的模型名（用户看得见）；
    /// ③ 项目里那对失效偏好被清掉（下次新建不再白失败一次）。
    ///
    /// 隔离：`load_state` 的覆盖层默认落在 `app_data_dir()`，而 mock runtime 下那是**全局共享**
    /// 路径（实测多个测试会互相抹掉对方的文件），所以这里把 `overlay_path` 也换到测试自己的
    /// 临时目录——既不干扰别的测试，也绝不碰用户的真实配置。
    #[ignore = "慢测试：起真实子进程（桩 omp，不调用 AI）"]
    #[tokio::test]
    async fn create_session_falls_back_when_model_rejected() {
        use std::os::unix::fs::PermissionsExt;
        use tauri::Manager;

        let root = std::env::temp_dir().join(format!("omp-inn-fallback-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sessions").join("--tmp-demo--")).unwrap();
        let project_dir = root.join("proj");
        // 用**子目录**建会话：自愈必须按归属（owner_project 前缀语义）找到项目，
        // 按「路径精确相等」定位会静默失效（这个测试顺带钉住它）
        let spawn_dir = project_dir.join("sub");
        std::fs::create_dir_all(&spawn_dir).unwrap();
        let sid = "01a13d6b-fc49-721f-af8b-6e90ac9aa97a";
        // 会话文件得像真的一样（会话 id 从文件头读出来，视图与归属都靠它）
        write_session(
            &root.join("sessions"),
            "2026-10-16T00-00-00-000Z_01a13d6b-fc49-721f-af8b-6e90ac9aa97a.jsonl",
            sid,
            "新建会话",
            &[],
        );
        let sfile = root.join("sessions").join("--tmp-demo--").join(format!("2026-10-16T00-00-00-000Z_{sid}.jsonl"));

        // 桩 omp：带 --model → 照真 omp 的样子把原因写 stderr 再退出；不带 → 回 ready + 身份
        let argv_path = root.join("argv.txt");
        let resp = serde_json::json!({
            "id": "h-state",
            "type": "response",
            "success": true,
            "data": {
                "sessionId": sid,
                "sessionFile": sfile.to_string_lossy(),
                "model": {"provider": "deepseek", "id": "deepseek-flash", "name": "DeepSeek Flash"},
                "thinkingLevel": "max",
            },
        })
        .to_string();
        let stub = root.join("stub-omp.sh");
        std::fs::write(
            &stub,
            format!(
                "#!/bin/sh\n\
for a in \"$@\"; do\n\
  case \"$a\" in --model) echo 'Error: Model \"ccproxy/deepseek/deepseek-v4.1-flash-fast\" not found' 1>&2; exit 1;; esac\n\
done\n\
printf '%s\\n' \"$@\" >> '{argv}'\n\
printf '{{\"type\":\"ready\"}}\\n'\n\
while IFS= read -r line; do\n\
  case \"$line\" in *h-state*) printf '%s\\n' '{resp}' ;; esac\n\
done\n",
                argv = argv_path.display(),
                resp = resp,
            ),
        )
        .unwrap();
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();

        // 覆盖层落在测试自己的临时目录（默认路径是 mock 下全局共享的 app_data_dir）
        let stale_model = "ccproxy/deepseek/deepseek-v4.1-flash-fast";
        let overlay_path = root.join("overlay.json");
        let seeded = serde_json::json!({
            "version": 1,
            "projects": [{
                "id": "p-e2e",
                "path": project_dir.to_string_lossy(),
                "added_at": 1_791_000_000_000_i64,
                "last_model": stale_model,
                "last_thinking": "max",
                "workspace_id": null,
            }],
            "workspaces": [],
            "archived": {},
            "notes": {},
            "session_approval": {},
            "omp_path": null,
        });
        std::fs::write(&overlay_path, serde_json::to_string_pretty(&seeded).unwrap()).unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app 构建失败");
        let state = load_state(app.handle());
        let mut state = state;
        state.overlay_path = overlay_path.clone();
        let (ov, _) = super::load_overlay(&overlay_path);
        state.overlay = tokio::sync::Mutex::new(ov);
        *state.agent_dir.lock().await = root.clone();
        *state.omp_path.lock().await = Some(stub.to_string_lossy().to_string());
        let state = std::sync::Arc::new(state);
        app.manage(state.clone());

        let out = super::create_session_in(app.handle(), &state, spawn_dir.to_string_lossy().to_string()).await;
        let out = out.expect("项目里的失效模型不该让新建会话整个失败（应降级重试）");

        // 收尾：进程与临时目录
        state.runtime.lock().await.clear();
        let cleanup = || {
            let _ = std::fs::remove_dir_all(&root);
        };

        assert_eq!(out.view.id, sid, "视图身份取自握手回包");
        let fb = out.fallback.expect("降级时必须带回说明（用户要知道为什么换了模型）");
        assert!(fb.fallback_model, "降级后进程拿到了模型 ⇒ 是项目偏好被 omp 拒绝");
        assert_eq!(fb.model.as_deref(), Some(stale_model));
        assert!(fb.detail.as_deref().unwrap_or("").contains("not found"), "说明里要带 omp 原话：{:?}", fb.detail);

        // 自愈：失效偏好从项目上清掉（下次新建不必再多失败一次），且真的落盘
        let saved = std::fs::read_to_string(&overlay_path).expect("自愈后覆盖层应已写回");
        let p0 = &serde_json::from_str::<serde_json::Value>(&saved).unwrap()["projects"][0];
        assert!(p0["last_model"].is_null(), "失效模型应被清掉，实际：{}", p0["last_model"]);

        // 桩进程记录：第一次带 --model（被拒），第二次不带（成功）
        let argv = std::fs::read_to_string(&argv_path).unwrap_or_default();
        assert!(argv.lines().count() >= 2, "应有两次 spawn（首发 + 降级重试），实际记录：{argv:?}");
        assert!(!argv.contains("--model"), "降级那一次不许再带 --model，实际：{argv:?}");

        cleanup();
    }

    /// 真实 omp 的降级回归（慢测试，**默认忽略**）：不存在的模型 → 降级建起来。
    ///
    /// 与桩测试的区别：这里是真的 `omp --model <不存在>`（上游行为可能变），验证
    /// 「用户那条路」在真机上也通。依赖本机 omp，覆盖层与 sessions 都落在临时目录。
    /// 跑法：`cargo test --manifest-path src-tauri/Cargo.toml -- --ignored real_omp_fallback`
    #[ignore = "慢测试：真实 omp（本地无 AI 调用，只走启动 + 握手）"]
    #[tokio::test]
    async fn real_omp_fallback_when_model_missing() {
        use tauri::Manager;
        // omp 定位与 `runtime.rs` 的真实 RPC 测试同一口径（OMP_BIN 覆盖 → HOME 常见路径）
        let Some(bin) = ["/opt/homebrew/bin/omp", "/usr/local/bin/omp"]
            .iter()
            .map(|p| std::path::PathBuf::from(p))
            .find(|p| p.is_file())
            .or_else(|| std::env::var("OMP_BIN").ok().map(std::path::PathBuf::from))
            .map(|p| p.to_string_lossy().to_string())
        else {
            eprintln!("[real_omp_fallback] 跳过：本机找不到 omp（可用 OMP_BIN 指定）");
            return;
        };
        let root = std::env::temp_dir().join(format!("omp-real-fallback-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let agent = root.join("agent");
        std::fs::create_dir_all(agent.join("sessions")).unwrap();
        let project_dir = root.join("proj");
        let spawn_dir = project_dir.join("sub"); // 子目录建会话：验证自愈按归属定位项目
        std::fs::create_dir_all(&spawn_dir).unwrap();

        let stale_model = "definitely/not-a-real-model-9f3a";
        let overlay_path = root.join("overlay.json");
        std::fs::write(
            &overlay_path,
            serde_json::to_string_pretty(&serde_json::json!({
                "version": 1,
                "projects": [{
                    "id": "p-real",
                    "path": project_dir.to_string_lossy(),
                    "added_at": 1_791_000_000_000_i64,
                    "last_model": stale_model,
                    "last_thinking": null,
                    "workspace_id": null,
                }],
                "workspaces": [], "archived": {}, "notes": {}, "session_approval": {}, "omp_path": null,
            }))
            .unwrap(),
        )
        .unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app 构建失败");
        let mut state = load_state(app.handle());
        state.overlay_path = overlay_path.clone();
        let (ov, _) = super::load_overlay(&overlay_path);
        state.overlay = tokio::sync::Mutex::new(ov);
        *state.agent_dir.lock().await = agent.clone();
        *state.omp_path.lock().await = Some(bin);
        let state = std::sync::Arc::new(state);
        app.manage(state.clone());

        let out = super::create_session_in(app.handle(), &state, spawn_dir.to_string_lossy().to_string()).await;
        state.runtime.lock().await.clear();
        let out = out.expect("失效模型不该让新建会话整个失败（真实 omp 也应降级重试）");
        let fb = out.fallback.expect("降级要带回说明");
        assert!(fb.fallback_model, "降级后应拿到 omp 默认模型，detail={:?}", fb.detail);
        assert_eq!(fb.model.as_deref(), Some(stale_model));
        let saved = std::fs::read_to_string(&overlay_path).unwrap();
        assert!(
            serde_json::from_str::<serde_json::Value>(&saved).unwrap()["projects"][0]["last_model"].is_null(),
            "失效模型应被清掉"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `spawn_session_runtime` 的 `--resume` 必须给**完整会话 id**（前缀会拉起同一分钟里
    /// 另一个会话，那个会话若在跑就被同 id 补位顶掉 = 进行中的轮次被中止）。
    ///
    /// 用桩 omp（把 argv 落文件 + 走三行握手回包）验证参数，不依赖真实 omp / AI 调用。
    #[tokio::test]
    async fn spawn_session_runtime_resumes_by_full_id() {
        use tauri::Manager;
        let root = std::env::temp_dir().join(format!("omp-session-spawn-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sessions").join("--tmp-demo--")).unwrap();
        let dir = root.join("sessions");
        let old_id = "01a123c6-9b8c-76a4-85ab-10ba5ee9d179";
        let new_id = "01a123c6-f958-7524-b1be-53b4fb030bf6";
        write_session(&dir, "2026-10-10T03-06-20-940Z_01a123c6-9b8c-76a4-85ab-10ba5ee9d179.jsonl", old_id, "旧会话", &[]);
        write_session(&dir, "2026-10-10T03-06-44-952Z_01a123c6-f958-7524-b1be-53b4fb030bf6.jsonl", new_id, "新会话", &[]);
        let old_file = dir.join("--tmp-demo--").join("2026-10-10T03-06-20-940Z_01a123c6-9b8c-76a4-85ab-10ba5ee9d179.jsonl");

        // 桩 omp：记录 argv → 回 ready → 对 h-state 回身份（其余握手命令忽略），直到 stdin 关闭
        let argv_path = root.join("argv.txt");
        let resp = serde_json::json!({
            "id": "h-state",
            "type": "response",
            "success": true,
            "data": {"sessionId": old_id, "sessionFile": old_file.to_string_lossy()},
        })
        .to_string();
        let stub = root.join("stub-omp.sh");
        std::fs::write(
            &stub,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{argv}'\nprintf '{{\"type\":\"ready\"}}\\n'\nwhile IFS= read -r line; do\n  case \"$line\" in\n    *h-state*) printf '%s\\n' '{resp}' ;;\n  esac\ndone\n",
                argv = argv_path.display(),
                resp = resp,
            ),
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app 构建失败");
        let state = load_state(app.handle());
        *state.agent_dir.lock().await = root.clone();
        *state.omp_path.lock().await = Some(stub.to_string_lossy().to_string());
        app.manage(state);

        let head = spawn_session_runtime(app.handle(), &app.state::<AppState>(), old_id)
            .await
            .expect("resume 拉起失败");
        assert_eq!(head.id, old_id, "读到的文件头必须是目标会话自己的");
        let argv = std::fs::read_to_string(&argv_path).unwrap();
        let args: Vec<&str> = argv.lines().collect();
        let i = args.iter().position(|a| *a == "--resume").expect("argv 里没有 --resume");
        assert_eq!(args[i + 1], old_id, "--resume 必须是完整会话 id（前缀会拉起另一个会话）");

        // 收尾：哨兵让 pump 退出（stdin 关闭 → 桩的 read 循环结束、进程退出）
        kill_runtime(&app.state::<AppState>(), old_id);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_window_defaults_and_clamps() {
        assert_eq!(scan_window(None, None), (500, 0));
        assert_eq!(scan_window(Some(1000), Some(500)), (1000, 500));
        // 过小/过大都夹回合法区间，offset 原样透传
        assert_eq!(scan_window(Some(0), None), (1, 0));
        assert_eq!(scan_window(Some(99999), None), (5000, 0));
    }

    /// 目录快照的新鲜判定：TTL 内算新鲜，刚好到 TTL 就算过期（严格小于）。
    #[test]
    fn catalog_freshness_boundary() {
        assert!(catalog_fresh(1_000, 1_000 + MODELS_TTL_MS - 1));
        assert!(!catalog_fresh(1_000, 1_000 + MODELS_TTL_MS));
        assert!(!catalog_fresh(1_000, 1_000 + MODELS_TTL_MS + 5_000));
    }

    /// 目录缓存核心：TTL 内命中、过期重拉、**并发只真拉一次**（单飞 + 等锁二次检查）。
    #[tokio::test]
    async fn load_cached_single_flight_and_ttl() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use tokio::sync::Mutex;
        let cache: Mutex<Option<(i64, i32)>> = Mutex::new(None);
        let lock = Mutex::new(());
        let calls = Arc::new(AtomicUsize::new(0));
        let fetch = |calls: Arc<AtomicUsize>| async move {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            Ok::<i32, String>(7)
        };
        let n = || calls.load(Ordering::SeqCst);

        // 冷缓存并发三个：只有第一个真拉，其余等锁后复用
        let (a, b, c) = tokio::join!(
            load_cached(&cache, &lock, false, 60_000, || fetch(calls.clone())),
            load_cached(&cache, &lock, false, 60_000, || fetch(calls.clone())),
            load_cached(&cache, &lock, false, 60_000, || fetch(calls.clone())),
        );
        assert_eq!((a.unwrap(), b.unwrap(), c.unwrap()), (7, 7, 7));
        assert_eq!(n(), 1, "并发只真拉一次");

        // 新鲜缓存：再读不拉
        assert_eq!(load_cached(&cache, &lock, false, 60_000, || fetch(calls.clone())).await.unwrap(), 7);
        assert_eq!(n(), 1);

        // 过期（ttl 0 → 任何缓存都过期）→ 真拉一次。同样睡 2ms：同一毫秒内刚写入的快照
        // 会被二次检查当成「别人刚拉过」而复用（时间戳是毫秒精度）
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        assert_eq!(load_cached(&cache, &lock, false, 0, || fetch(calls.clone())).await.unwrap(), 7);
        assert_eq!(n(), 2);

        // force：即使新鲜也真拉（用户点「刷新」的语义）。睡 2ms 让请求起点严格晚于上次
        // 写入——同一毫秒内的并发写入会被复用（等锁二次检查按毫秒判定）。
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        assert_eq!(load_cached(&cache, &lock, true, 60_000, || fetch(calls.clone())).await.unwrap(), 7);
        assert_eq!(n(), 3);
    }
    /// 写一个可执行的 stub「omp」脚本（V40 的 rpc_request 测试用）。
    fn write_v40_stub(dir: &std::path::Path, script: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join("omp-stub.sh");
        std::fs::write(&p, script).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    /// `rpc_request`（V40 新通路：临时监听 `omp-event://<sid>` + 按请求 id 匹配回包）三条路径：
    /// 成功取 `data`、失败响应转 CmdError（带 code / message）、无回包超时。
    /// 用 stub 脚本模拟 omp 的 ready / 身份 / 动态回显。
    #[tokio::test]
    async fn rpc_request_matches_by_id_ok_fail_timeout() {
        use tauri::Manager;
        let root = std::env::temp_dir().join(format!("omp-v40-rpc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // stub：ready → 身份回包（h-state）；含 "__fail" 回失败；含 "__never" 不回；其余回显 id + data
        let script = r#"#!/bin/sh
printf '{"type":"ready"}\n'
while IFS= read -r line; do
  case "$line" in
    *'"h-state"'*) printf '%s\n' '{"type":"response","id":"h-state","command":"get_state","success":true,"data":{"sessionId":"stub-old","sessionFile":"/tmp/stub-old.jsonl"}}' ;;
    *'"__fail"'*)
      id=$(printf '%s' "$line" | sed -E 's/.*"id":"([^"]+)".*/\1/')
      printf '{"type":"response","id":"%s","command":"x","success":false,"error":"stub-rejected","code":"STUB_FAIL"}\n' "$id" ;;
    *'"__never"'*) : ;;
    *)
      id=$(printf '%s' "$line" | sed -E 's/.*"id":"([^"]+)".*/\1/')
      printf '{"type":"response","id":"%s","command":"x","success":true,"data":{"echo":"ok"}}\n' "$id" ;;
  esac
done
"#;
        let stub = write_v40_stub(&root, script);
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app 构建失败");
        let state = load_state(app.handle());
        *state.omp_path.lock().await = Some(stub.to_string_lossy().to_string());
        app.manage(state);

        let (sid, _file, _meta) = crate::runtime::spawn_long_lived(
            app.handle(),
            app.state::<AppState>().runtime.clone(),
            crate::runtime::SpawnOpts {
                bin: stub.to_string_lossy().to_string(),
                cwd: root.to_string_lossy().to_string(),
                resume: None,
                model: None,
                thinking: None,
                approval: None,
            },
        )
        .await
        .expect("stub 握手失败");
        let st = app.state::<AppState>();

        // 成功路径：回包 data 原样取出
        let ok = rpc_request(app.handle(), &st, &sid, serde_json::json!({"id": "ok-1", "type": "get_state"}), 5_000)
            .await
            .expect("成功请求应取到 data");
        assert_eq!(ok.get("echo").and_then(|v| v.as_str()), Some("ok"));

        // 失败路径：转 CmdError（code / message 来自 omp 回包）
        let err = rpc_request(
            app.handle(),
            &st,
            &sid,
            serde_json::json!({"id": "bad-1", "type": "noop", "__fail": true}),
            5_000,
        )
        .await
        .expect_err("失败响应应转 CmdError");
        assert_eq!(err.code, "STUB_FAIL");
        assert_eq!(err.message, "stub-rejected");

        // 超时路径：stub 不回 → RPC_TIMEOUT
        let err = rpc_request(
            app.handle(),
            &st,
            &sid,
            serde_json::json!({"id": "never-1", "type": "noop", "__never": true}),
            400,
        )
        .await
        .expect_err("无回包应超时");
        assert_eq!(err.code, "RPC_TIMEOUT");

        kill_runtime(&st, &sid);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `spawn_session_runtime` 的身份漂移分支（open-elsewhere 保护性 fork）：
    /// omp 对「已被其他进程持有的会话」会把本次 resume 分到新身份——壳必须以
    /// 返回的真实身份（新 jsonl）为准，而不是请求的 id。
    #[tokio::test]
    async fn spawn_session_runtime_adopts_forked_identity() {
        use tauri::Manager;
        let root = std::env::temp_dir().join(format!("omp-drift-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let agent = root.join("agent");
        let dir = agent.join("sessions").join("--tmp-demo--");
        std::fs::create_dir_all(&dir).unwrap();
        let req_id = "01a123c6-1111-7524-b1be-53b4fb030bf6";
        let new_id = "01a123c6-f958-7524-b1be-53b4fb030bf7";
        // 请求会话的文件（resume 目标）：session_file_for 按完整 id 找得到
        std::fs::write(
            dir.join(format!("2026-10-12T10-00-00Z_{req_id}.jsonl")),
            format!(
                "{}\n",
                serde_json::json!({
                    "type":"session","id":req_id,"timestamp":"2026-10-12T10:00:00.000Z","cwd":"/tmp/demo","title":"原会话"
                })
            ),
        )
        .unwrap();
        // omp 分叉出的新身份文件（标题继承原会话——与真实 open-elsewhere 产物同形）
        let new_file = dir.join(format!("2026-10-12T10-00-01Z_{new_id}.jsonl"));
        std::fs::write(
            &new_file,
            format!(
                "{}\n{}\n",
                serde_json::json!({"type":"title","v":1,"title":"原会话","source":"user","updatedAt":"2026-10-12T10:00:01.000Z"}),
                serde_json::json!({
                    "type":"session","id":new_id,"timestamp":"2026-10-12T10:00:01.000Z","cwd":"/tmp/demo",
                    "title":"原会话","titleSource":"user","parentSession":req_id
                })
            ),
        )
        .unwrap();

        // stub：握手 get_state 回**新身份**（模拟 omp 的保护性 fork）
        let script = format!(
            r#"#!/bin/sh
printf '{{"type":"ready"}}\n'
while IFS= read -r line; do
  case "$line" in
    *'"h-state"'*)
      printf '%s\n' '{{"type":"response","id":"h-state","command":"get_state","success":true,"data":{{"sessionId":"{new}","sessionFile":"{newfile}"}}}}' ;;
    *) : ;;
  esac
done
"#,
            new = new_id,
            newfile = new_file.to_string_lossy(),
        );
        let stub = write_v40_stub(&root, &script);
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app 构建失败");
        let state = load_state(app.handle());
        *state.agent_dir.lock().await = agent.clone();
        *state.omp_path.lock().await = Some(stub.to_string_lossy().to_string());
        app.manage(state);

        let st = app.state::<AppState>();
        let head = super::spawn_session_runtime(app.handle(), &st, req_id)
            .await
            .expect("resume 应成功");
        assert_eq!(head.id, new_id, "身份漂移：头必须按 omp 的真实身份（新副本）读");
        assert_eq!(head.title, "原会话", "标题继承自原会话（open-elsewhere 产物同形）");
        // runtime 表登记的也应是真实身份（后续 send_prompt / 再次打开都按它定位）
        let keys: Vec<String> = st.runtime.lock().await.keys().cloned().collect();
        assert!(keys.contains(&new_id.to_string()));

        kill_runtime(&st, new_id);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 配置读取（权限档 / 默认思考档）不许依赖诊断是否跑完——前端**启动时**就并发发起
    /// `loadApprovalState` / `ensureOmpDefaultThinking` 与健康检查（`locate_omp`）。
    ///
    /// 老实现读 `state.omp_path`：那一刻诊断还没落位，读到的是「未找到 omp」→ 输入卡上的
    /// 权限档一直卡在「读取中…」、默认思考档退成兜底的最高档，直到用户打开菜单才补读成功
    /// （用户报的「必须点开下拉框才加载出来」就是这个）。这里把「定位走 `discover_omp_path`」
    /// 这条链钉死，并验缓存命中的快路径。
    #[tokio::test]
    async fn config_reads_work_before_diagnostics() {
        use tauri::Manager;
        let root = std::env::temp_dir().join(format!("omp-boot-config-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // stub omp：`config get <key> --json` 按 key（$3）回固定值
        let script = r#"#!/bin/sh
case "$3" in
  tools.approvalMode) printf '%s\n' '{"key":"tools.approvalMode","value":"yolo"}' ;;
  defaultThinkingLevel) printf '%s\n' '{"key":"defaultThinkingLevel","value":"medium"}' ;;
  *) printf '%s\n' '{"key":"other","value":null}' ;;
esac
"#;
        let stub = write_v40_stub(&root, script);
        let stub_path = stub.to_string_lossy().to_string();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app 构建失败");
        let state = load_state(app.handle());
        // 覆盖层里的显式 omp 路径：定位的唯一入口先看它，测试因此不看本机真实的 omp
        state.overlay.try_lock().unwrap().omp_path = Some(stub_path.clone());
        app.manage(state);
        let st = app.state::<AppState>();
        assert!(st.omp_path.try_lock().unwrap().is_none(), "前置：诊断（locate_omp）还没跑");

        assert_eq!(
            get_global_approval(app.state()).await.expect("诊断跑完前也要能读到权限档"),
            "yolo"
        );
        assert_eq!(
            crate::settings::read_default_thinking_level(&st).await.as_deref(),
            Some("medium")
        );
        // 顺手落定位缓存：读 `state.omp_path` 的路径（新建会话 / 起 runtime）也能直接用
        assert_eq!(st.omp_path.try_lock().unwrap().clone(), Some(stub_path.clone()));
        // 覆盖层被清掉（用户改回自动探测）后缓存仍命中，不必再起一次登录 shell 探测
        st.overlay.try_lock().unwrap().omp_path = None;
        assert_eq!(discover_omp_path(&st), Some(stub_path.clone()));

        let _ = std::fs::remove_dir_all(&root);
    }
}
