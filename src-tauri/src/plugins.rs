//! 插件（Plugin，设置 ›「插件」）：把 omp 的插件管理映射进设置页。
//!
//! 上游事实（omp 18.3.5 实测）：
//! - `omp plugin list --json` → `{npm: [...], marketplace: [...]}`：
//!   - npm / link 条目 `{name, version, path, manifest{description?, features?}, enabledFeatures, enabled}`；
//!   - 市场条目 `{id, scope, entries[{version, enabled, installPath}], shadowedBy?}`。
//! - `omp plugin enable|disable <name> [--scope user|project]`：同一 `名字@市场名` 双份安装时
//!   上游要求显式 scope（不给直接报错）。
//! - `omp plugin features <name> [--enable f1,f2] [--disable f1] [--set f1,f2]`：
//!   `enabledFeatures: null` = **按 manifest 里每个特性自己的 `default` 走**；一旦写过就成显式列表
//!   （不再回落默认）。所以壳侧一律按「当前生效集合」算整组、走 `--set` —— 从 null 出发逐项
//!   `--enable` 会把默认开启的特性一起丢掉（上游行为）。
//! - `omp plugin install <source> [--scope user|project]`：npm / git / 本地路径装进用户插件目录
//!   （这时 `--scope` 被忽略并告警），只有市场条目（`名字@市场名`）认 scope；而 scope=project
//!   解析的是「**当前 cwd** 最近的项目」的 `.omp/plugins/installed_plugins.json` —— 项目级安装
//!   必须把 cwd 钉到那个项目目录。
//! - `--dry-run` 只对 npm / git / 本地路径可靠；**市场条目上游会照装**（官方文档写明 dry-run
//!   不适用于市场安装），所以壳侧不提供「预览」，安装前用确认与提示替代。
//! - `omp plugin doctor [--fix] --json` → `[{name, status: ok|warning|error, message, fixed?}]`，
//!   带 `--json` 时即使有 error 也是退出码 0（人读模式才 exit 1）。
//! - `omp plugin list` 的 cwd 有语义：项目 `package.json` 里装的插件与项目级市场插件都按 cwd
//!   解析，所以命令面统一带可选 `cwd`（缺省 = 钉 agentDir = 用户级视图）。
//!
//! **只碰插件**：不直接读 / 写 omp 的 lock 与注册文件、不自己调 npm / git，全部经 `omp plugin`；
//! 写操作共用 `state.extensions_edit` 串行（并发 install / uninstall 会互相踩插件目录）。

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::State;

use crate::commands::{cmd_err, AppState, CmdError};
use crate::providers::{omp_bin, run_omp_capture, run_omp_in_timeout};

/// 读类命令（list / enable / disable / features / doctor）的超时。
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// 安装类命令的超时：`omp plugin install` 会下载并跑包管理器（网络 + 依赖解析），
/// 上游没有可预期的上界，给足 10 分钟；超时是可取消的等待，不是挂死。
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);
/// 插件名（可含 `@scope/name`）长度上限。
pub const NAME_MAX_LEN: usize = 256;
/// 安装源（npm / git / 路径 / 市场条目）长度上限。
pub const SOURCE_MAX_LEN: usize = 512;
/// 一次写入的特性数量上限（manifest 里的可选特性是「个位数」量级的清单）。
pub const FEATURES_MAX: usize = 200;

// ---------- 视图类型 ----------

/// 插件声明的一个可选特性（manifest 的 `features` 项）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFeature {
    pub name: String,
    /// manifest 里的说明（上游英文，原样透传）。
    pub description: String,
    /// manifest 的 `default`：未写显式列表时是否生效。
    pub default_enabled: bool,
    /// **当前是否生效**（显式列表 ? 列表里有没有 : default）——界面只照着画开关。
    pub enabled: bool,
}

/// 一个 npm / link 插件。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginItem {
    pub name: String,
    pub version: String,
    /// 插件安装路径（link 的是软链目标）。
    pub path: String,
    pub description: String,
    pub features: Vec<PluginFeature>,
    /// `enabledFeatures` 已被显式写过（界面据此标「特性已自定义」）。
    pub features_customized: bool,
    pub enabled: bool,
}

/// 一个市场插件（`名字@市场名`；user / project 两个 scope 各是一条）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPluginItem {
    pub id: String,
    pub version: String,
    pub scope: String,
    /// 被项目级同名安装遮住时的说明（上游 `shadowedBy`）。
    pub shadowed_by: Option<String>,
    pub enabled: bool,
}

/// 插件清单（`cwd` = 这次读取钉的工作目录，界面上标明「项目级可见范围」）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginsView {
    pub cwd: String,
    pub npm: Vec<PluginItem>,
    pub marketplace: Vec<MarketPluginItem>,
}

/// 一个插件的特性集合（写回后回读的真相）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFeatures {
    pub plugin: String,
    pub enabled_features: Vec<String>,
    pub available_features: Vec<String>,
}

/// 体检结论（doctor 的一行）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDoctorFinding {
    pub name: String,
    /// `ok` / `warning` / `error`（上游值原样；未知值也原样回，界面按中性色显示）。
    pub status: String,
    pub message: String,
    /// `--fix` 下上游标了「已修复」的项。
    pub fixed: bool,
}

// ---------- 校验（纯函数，单测锁着） ----------

/// 插件名 / 插件 id 的形状：非空、长度受限、无控制字符。
///
/// 校验的意义不在防命令注入（`run_omp_*` 用 `Command::args` 传参、不经 shell），而在
/// 别把前端 bug 变成对插件目录的随意操作：`omp plugin` 只认真实装过的名字，先钉形状。
pub fn valid_plugin_ref(s: &str) -> bool {
    let t = s.trim();
    !t.is_empty() && t == s && s.len() <= NAME_MAX_LEN && !s.chars().any(char::is_control)
}

/// 安装源的形状：比插件名宽松（URL / 路径 / `名字@市场名` 都合法），同样钉长度与控制字符。
pub fn valid_source(s: &str) -> bool {
    let t = s.trim();
    !t.is_empty() && t.len() <= SOURCE_MAX_LEN && !t.chars().any(char::is_control)
}

/// scope 只认上游的两个字面量。
pub fn valid_scope(s: &str) -> bool {
    s == "user" || s == "project"
}

/// 把界面传来的 scope 归一：`None` / 空串 = 用户级视图（钉 agentDir）；给了就校验。
///
/// 返回的是**这次命令要用的工作目录**：`cwd` 给的是项目目录时，`omp plugin list` 会连带把
/// 那个项目里 npm 安装的插件与项目级市场插件一起列出来（上游按 cwd 解析项目注册表）。
pub fn scope_cwd(agent_dir: &Path, cwd: Option<&str>) -> Result<PathBuf, String> {
    let Some(raw) = cwd.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(agent_dir.to_path_buf());
    };
    let p = Path::new(raw);
    if !p.is_absolute() {
        return Err(format!("项目目录必须是绝对路径：{raw}"));
    }
    if !p.is_dir() {
        return Err(format!("项目目录不存在：{raw}"));
    }
    Ok(std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()))
}

// ---------- 解析（纯函数，单测锁着） ----------

fn str_of(v: Option<&serde_json::Value>) -> String {
    v.and_then(|x| x.as_str()).unwrap_or_default().to_string()
}

fn opt_str(v: Option<&serde_json::Value>) -> Option<String> {
    v.and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 一个特性的生效判定：显式列表优先，没写显式列表就按 manifest 的 `default`。
fn feature_enabled(explicit: Option<&Vec<String>>, name: &str, default_enabled: bool) -> bool {
    match explicit {
        Some(list) => list.iter().any(|f| f == name),
        None => default_enabled,
    }
}

/// 解析 npm / link 条目里的特性：`manifest.features` 的键序即展示序。
fn parse_features(
    manifest: Option<&serde_json::Value>,
    explicit: Option<&Vec<String>>,
) -> Vec<PluginFeature> {
    let Some(map) = manifest
        .and_then(|m| m.get("features"))
        .and_then(|f| f.as_object())
    else {
        return vec![];
    };
    map.iter()
        .map(|(name, spec)| {
            let default_enabled = spec.get("default").and_then(|d| d.as_bool()).unwrap_or(false);
            PluginFeature {
                name: name.clone(),
                description: str_of(spec.get("description")),
                default_enabled,
                enabled: feature_enabled(explicit, name, default_enabled),
            }
        })
        .collect()
}

/// 显式特性列表：`null` → `None`（回落默认）；数组 → 只留字符串项。
fn explicit_features(v: Option<&serde_json::Value>) -> Option<Vec<String>> {
    let arr = v?.as_array()?;
    Some(
        arr.iter()
            .filter_map(|x| x.as_str())
            .map(str::to_string)
            .collect(),
    )
}

/// 解析 `omp plugin list --json`（`cwd` 由调用方填进视图）。
///
/// 容错口径：整份输出不是 JSON 才算失败；**单个条目结构异常就跳过它**（上游换形状时
/// 界面少一行，不该整页报错）。
pub fn parse_plugin_list(out: &str, cwd: &str) -> Result<PluginsView, String> {
    let v: serde_json::Value =
        serde_json::from_str(out.trim()).map_err(|e| format!("插件清单解析失败：{e}"))?;
    let npm = v
        .get("npm")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    let name = opt_str(p.get("name"))?;
                    let explicit = explicit_features(p.get("enabledFeatures"));
                    let manifest = p.get("manifest");
                    Some(PluginItem {
                        description: str_of(manifest.and_then(|m| m.get("description"))),
                        features: parse_features(manifest, explicit.as_ref()),
                        features_customized: explicit.is_some(),
                        name,
                        version: str_of(p.get("version")),
                        path: str_of(p.get("path")),
                        enabled: p.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let marketplace = v
        .get("marketplace")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    let id = opt_str(p.get("id"))?;
                    let entries = p.get("entries").and_then(|e| e.as_array());
                    let first = entries.and_then(|e| e.first());
                    // 「启用」= 没有安装记录被标 false。注册表按 scope 存一份、正常就一条；entries
                    // 缺省或为空（登记坏了）也按启用显示——「无从判定」不该谎报成「已停用」。
                    let enabled = entries
                        .map(|e| e.iter().all(|x| x.get("enabled").and_then(|y| y.as_bool()) != Some(false)))
                        .unwrap_or(true);
                    Some(MarketPluginItem {
                        id,
                        version: str_of(first.and_then(|f| f.get("version"))),
                        scope: opt_str(p.get("scope")).unwrap_or_else(|| "user".into()),
                        shadowed_by: opt_str(p.get("shadowedBy")),
                        enabled,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(PluginsView { cwd: cwd.to_string(), npm, marketplace })
}

/// 解析 `omp plugin features <p> --json` 的回读。
pub fn parse_plugin_features(out: &str) -> Result<PluginFeatures, String> {
    let v: serde_json::Value =
        serde_json::from_str(out.trim()).map_err(|e| format!("插件特性解析失败：{e}"))?;
    let list = |key: &str| {
        v.get(key)
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    Ok(PluginFeatures {
        plugin: str_of(v.get("plugin")),
        enabled_features: list("enabledFeatures"),
        available_features: list("availableFeatures"),
    })
}

/// 解析 `omp plugin doctor --json`。
pub fn parse_doctor(out: &str) -> Result<Vec<PluginDoctorFinding>, String> {
    let v: serde_json::Value =
        serde_json::from_str(out.trim()).map_err(|e| format!("插件体检结果解析失败：{e}"))?;
    let arr = v.as_array().ok_or_else(|| "插件体检结果不是数组".to_string())?;
    Ok(arr
        .iter()
        .filter_map(|f| {
            let name = opt_str(f.get("name"))?;
            Some(PluginDoctorFinding {
                name,
                status: str_of(f.get("status")),
                message: str_of(f.get("message")),
                fixed: f.get("fixed").and_then(|x| x.as_bool()).unwrap_or(false),
            })
        })
        .collect())
}

/// `--set` 的参数值。
///
/// 上游只在 `--set` 的值**为真**时才写（空串会走「只读」分支），而它的解析是
/// `值.split(",").map(trim).filter(Boolean)` —— 所以一个空格解析成**空集合**，正是
/// 「关掉最后一个可选特性」需要的写形（空数组 = 一个可选特性都不开；实测 18.3.5 有效）。
/// 非空集合按逗号连接（上游就是这么拆的，特性名里的逗号本来就没法表达——入口处已拒绝）。
pub fn features_set_arg(features: &[String]) -> String {
    if features.is_empty() {
        " ".to_string()
    } else {
        features.join(",")
    }
}

// ---------- 命令 ----------

/// 读插件清单（`cwd` 缺省 = 用户级视图）。
async fn read_plugins(
    state: &State<'_, AppState>,
    bin: &str,
    cwd: Option<&str>,
) -> Result<PluginsView, CmdError> {
    let agent = state.agent_dir.lock().await.clone();
    let dir = scope_cwd(&agent, cwd)
        .map_err(|e| cmd_err("PLUGIN_CWD_INVALID", e, None))?;
    let out = run_omp_in_timeout(Some(&dir), bin, &["plugin", "list", "--json"], READ_TIMEOUT)
        .await
        .map_err(|e| cmd_err("PLUGIN_LIST_FAILED", format!("读取插件清单失败：{e}"), None))?;
    parse_plugin_list(&out, &dir.to_string_lossy())
        .map_err(|e| cmd_err("PLUGIN_LIST_FAILED", e, None))
}

/// 插件清单：npm / link 一组、市场安装一组（`cwd` 决定项目级可见范围）。
#[tauri::command]
pub async fn list_plugins(
    state: State<'_, AppState>,
    cwd: Option<String>,
) -> Result<PluginsView, CmdError> {
    let bin = omp_bin(&state)?;
    read_plugins(&state, &bin, cwd.as_deref()).await
}

/// 启用 / 禁用（npm 与 link 插件不认 scope；市场插件双份时必须给）。
#[tauri::command]
pub async fn set_plugin_enabled(
    state: State<'_, AppState>,
    name: String,
    scope: Option<String>,
    enabled: bool,
    cwd: Option<String>,
) -> Result<PluginsView, CmdError> {
    if !valid_plugin_ref(&name) {
        return Err(cmd_err("PLUGIN_NAME_INVALID", format!("非法的插件名：{name}"), None));
    }
    if let Some(s) = scope.as_deref().filter(|s| !s.is_empty()) {
        if !valid_scope(s) {
            return Err(cmd_err("PLUGIN_SCOPE_INVALID", format!("未知的 scope：{s}"), None));
        }
    }
    let bin = omp_bin(&state)?;
    let project = scope.as_deref() == Some("project");
    // 项目级插件（市场双份安装的一份）必须有项目目录：cwd 缺省会被解析到 agentDir 附近的
    // 无关目录——宁可报错不猜（与 install / uninstall 同款守卫）。
    if project && cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()).is_none() {
        return Err(cmd_err("PLUGIN_CWD_INVALID", "项目级插件需要指定项目目录".into(), None));
    }
    let verb = if enabled { "enable" } else { "disable" };
    let mut args = vec!["plugin", verb, name.as_str()];
    if let Some(s) = scope.as_deref().filter(|s| !s.is_empty()) {
        args.push("--scope");
        args.push(s);
    }
    let agent = state.agent_dir.lock().await.clone();
    let dir = scope_cwd(&agent, if project { cwd.as_deref() } else { None })
        .map_err(|e| cmd_err("PLUGIN_CWD_INVALID", e, None))?;
    let _guard = state.extensions_edit.lock().await;
    run_omp_in_timeout(Some(&dir), &bin, &args, READ_TIMEOUT).await.map_err(|e| {
        cmd_err(
            "PLUGIN_WRITE_FAILED",
            format!("{}插件失败：{e}", if enabled { "启用" } else { "禁用" }),
            None,
        )
    })?;
    read_plugins(&state, &bin, cwd.as_deref()).await
}

/// 写一个插件的特性集合（**整组覆盖**，见模块头注释）。
#[tauri::command]
pub async fn set_plugin_features(
    state: State<'_, AppState>,
    plugin: String,
    features: Vec<String>,
) -> Result<PluginFeatures, CmdError> {
    if !valid_plugin_ref(&plugin) {
        return Err(cmd_err("PLUGIN_NAME_INVALID", format!("非法的插件名：{plugin}"), None));
    }
    // 特性名只做形状校验（上游自己会拒绝不认识的特性——报错原样透传）；逗号是上游的分隔符，
    // 带逗号的名字没法经 CLI 表达，直接拒绝而不是悄悄拆错。名称 / 数量都设上限：
    // 超长参数列表会在 spawn 时撞 OS 的 ARG_MAX，报一个和特性毫无关系的错。
    if features.len() > FEATURES_MAX
        || features.iter().any(|f| {
            let t = f.trim();
            t.is_empty()
                || t != f
                || f.len() > NAME_MAX_LEN
                || f.contains(',')
                || f.chars().any(char::is_control)
        })
    {
        return Err(cmd_err("PLUGIN_FEATURE_INVALID", "非法的特性名".into(), None));
    }
    let bin = omp_bin(&state)?;
    let set = features_set_arg(&features);
    let agent = state.agent_dir.lock().await.clone();
    let _guard = state.extensions_edit.lock().await;
    run_omp_in_timeout(
        Some(&agent),
        &bin,
        &["plugin", "features", plugin.as_str(), "--set", &set],
        READ_TIMEOUT,
    )
    .await
    .map_err(|e| cmd_err("PLUGIN_FEATURES_FAILED", format!("写入插件特性失败：{e}"), None))?;
    let out = run_omp_in_timeout(
        Some(&agent),
        &bin,
        &["plugin", "features", plugin.as_str(), "--json"],
        READ_TIMEOUT,
    )
    .await
    .map_err(|e| cmd_err("PLUGIN_FEATURES_FAILED", format!("回读插件特性失败：{e}"), None))?;
    parse_plugin_features(&out).map_err(|e| cmd_err("PLUGIN_FEATURES_FAILED", e, None))
}

/// 安装一个插件（源 = npm 包 / git 仓库 / 本地目录 / `名字@市场名`）。
///
/// `scope = project` 时 `cwd` 必须是目标项目目录：上游按 cwd 找最近项目的
/// `.omp/plugins/installed_plugins.json`（见模块头注释），cwd 缺省则退回用户级。
#[tauri::command]
pub async fn install_plugin(
    state: State<'_, AppState>,
    source: String,
    scope: Option<String>,
    cwd: Option<String>,
) -> Result<PluginsView, CmdError> {
    if !valid_source(&source) {
        return Err(cmd_err("PLUGIN_SOURCE_INVALID", format!("非法的安装源：{source}"), None));
    }
    if let Some(s) = scope.as_deref().filter(|s| !s.is_empty()) {
        if !valid_scope(s) {
            return Err(cmd_err("PLUGIN_SCOPE_INVALID", format!("未知的 scope：{s}"), None));
        }
    }
    let src = source.trim();
    let bin = omp_bin(&state)?;
    let project = scope.as_deref() == Some("project");
    // 项目级安装**必须**指定项目目录：上游按 cwd 找最近项目的
    // `.omp/plugins/installed_plugins.json`，cwd 缺省会被解析到无关目录，宁可报错不猜。
    if project && cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()).is_none() {
        return Err(cmd_err("PLUGIN_CWD_INVALID", "项目级安装需要指定项目目录".into(), None));
    }
    let agent = state.agent_dir.lock().await.clone();
    let dir = scope_cwd(&agent, if project { cwd.as_deref() } else { None })
        .map_err(|e| cmd_err("PLUGIN_CWD_INVALID", e, None))?;
    let mut args = vec!["plugin", "install", src];
    if let Some(s) = scope.as_deref().filter(|s| !s.is_empty()) {
        args.push("--scope");
        args.push(s);
    }
    let _guard = state.extensions_edit.lock().await;
    run_omp_in_timeout(Some(&dir), &bin, &args, INSTALL_TIMEOUT)
        .await
        .map_err(|e| cmd_err("PLUGIN_INSTALL_FAILED", format!("安装插件失败：{e}"), None))?;
    read_plugins(&state, &bin, cwd.as_deref()).await
}

/// 卸载一个插件（市场插件双份安装时用 `scope` 指定那一份）。
#[tauri::command]
pub async fn uninstall_plugin(
    state: State<'_, AppState>,
    id: String,
    scope: Option<String>,
    cwd: Option<String>,
) -> Result<PluginsView, CmdError> {
    if !valid_plugin_ref(&id) {
        return Err(cmd_err("PLUGIN_NAME_INVALID", format!("非法的插件名：{id}"), None));
    }
    if let Some(s) = scope.as_deref().filter(|s| !s.is_empty()) {
        if !valid_scope(s) {
            return Err(cmd_err("PLUGIN_SCOPE_INVALID", format!("未知的 scope：{s}"), None));
        }
    }
    let bin = omp_bin(&state)?;
    let project = scope.as_deref() == Some("project");
    if project && cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()).is_none() {
        return Err(cmd_err("PLUGIN_CWD_INVALID", "项目级插件需要指定项目目录".into(), None));
    }
    let mut args = vec!["plugin", "uninstall", id.as_str()];
    if let Some(s) = scope.as_deref().filter(|s| !s.is_empty()) {
        args.push("--scope");
        args.push(s);
    }
    let agent = state.agent_dir.lock().await.clone();
    let dir = scope_cwd(&agent, if project { cwd.as_deref() } else { None })
        .map_err(|e| cmd_err("PLUGIN_CWD_INVALID", e, None))?;
    let _guard = state.extensions_edit.lock().await;
    run_omp_in_timeout(Some(&dir), &bin, &args, INSTALL_TIMEOUT)
        .await
        .map_err(|e| cmd_err("PLUGIN_UNINSTALL_FAILED", format!("卸载插件失败：{e}"), None))?;
    read_plugins(&state, &bin, cwd.as_deref()).await
}

/// 插件体检（`--fix` = 让上游尝试修复）。
///
/// 用 `run_omp_capture` 而非 `run_omp_in_timeout`：`--json` 下人读模式才会有的
/// 「有 error 就 exit 1」不该影响解析（上游当前不解，但别把退出码当解析门槛）；
/// 只有 stdout 不是 JSON 才报错，报错文本带上 stderr 尾部。
#[tauri::command]
pub async fn plugin_doctor(
    state: State<'_, AppState>,
    fix: bool,
) -> Result<Vec<PluginDoctorFinding>, CmdError> {
    let bin = omp_bin(&state)?;
    let agent = state.agent_dir.lock().await.clone();
    let mut args = vec!["plugin", "doctor", "--json"];
    if fix {
        args.push("--fix");
    }
    // `--fix` 会动插件目录：与 install / uninstall 用同一把锁串行（只读体检不需要锁）。
    let _guard = if fix {
        Some(state.extensions_edit.lock().await)
    } else {
        None
    };
    let (out, err, _code) = run_omp_capture(Some(&agent), &bin, &args, READ_TIMEOUT)
        .await
        .map_err(|e| cmd_err("PLUGIN_DOCTOR_FAILED", format!("插件体检失败：{e}"), None))?;
    parse_doctor(&out).map_err(|e| {
        let tail = err.trim();
        let hint = if tail.is_empty() { None } else { Some(tail.chars().take(400).collect()) };
        cmd_err("PLUGIN_DOCTOR_FAILED", format!("插件体检失败：{e}"), hint)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = r#"{
      "npm": [
        {
          "name": "@oh-my-pi/exa",
          "version": "1.3.3710",
          "path": "/Users/me/.omp/plugins/node_modules/@oh-my-pi/exa",
          "manifest": {
            "version": "1.3.3710",
            "description": "Exa 插件",
            "features": {
              "search": { "description": "网页搜索", "default": true },
              "web": { "description": "浏览器", "default": false }
            }
          },
          "enabledFeatures": null,
          "enabled": true
        },
        { "name": "plain", "version": "0.1.0", "path": "/tmp/plain", "manifest": {}, "enabledFeatures": ["web"], "enabled": false },
        { "noName": true }
      ],
      "marketplace": [
        { "id": "foo@market", "scope": "user", "entries": [{ "version": "2.0.0", "enabled": true, "installPath": "/x" }] },
        { "id": "bar@market", "scope": "project", "entries": [{ "version": "1.0.0", "enabled": true, "installPath": "/y" }], "shadowedBy": "project" },
        { "id": "bad@market" }
      ]
    }"#;

    #[test]
    fn list_parses_items_and_effective_features() {
        let v = parse_plugin_list(LIST, "/tmp").unwrap();
        assert_eq!(v.cwd, "/tmp");
        // 结构异常的条目（没有 name）被跳过，其余照常
        assert_eq!(v.npm.len(), 2);
        let exa = &v.npm[0];
        assert_eq!(exa.name, "@oh-my-pi/exa");
        assert_eq!(exa.description, "Exa 插件");
        assert!(!exa.features_customized);
        // enabledFeatures = null → 按每个特性的 default
        assert_eq!(
            exa.features.iter().map(|f| (f.name.as_str(), f.enabled)).collect::<Vec<_>>(),
            vec![("search", true), ("web", false)]
        );
        // 显式列表 → 列表说了算
        let plain = &v.npm[1];
        assert!(plain.features_customized);
        assert_eq!(plain.features, vec![]);
        assert!(!plain.enabled);
        assert_eq!(v.marketplace.len(), 3);
        assert_eq!(v.marketplace[0].id, "foo@market");
        assert_eq!(v.marketplace[0].version, "2.0.0");
        assert!(v.marketplace[0].enabled);
        assert_eq!(v.marketplace[1].shadowed_by.as_deref(), Some("project"));
        assert_eq!(v.marketplace[1].scope, "project");
        // entries 缺失 = 版本未知，仍然列出来（能卸载 / 启停）
        assert_eq!(v.marketplace[2].id, "bad@market");
        assert_eq!(v.marketplace[2].version, "");
        assert!(v.marketplace[2].enabled);
        // entries 里带 enabled:false 的算停用；空数组 / 缺省都是「无从判定」→ 按启用显示
        let mk = |json: &str| {
            parse_plugin_list(json, "/tmp").unwrap().marketplace[0].enabled
        };
        assert!(!mk(r#"{"npm":[],"marketplace":[{"id":"m","entries":[{"enabled":false}]}]}"#));
        assert!(mk(r#"{"npm":[],"marketplace":[{"id":"m","entries":[]}]}"#));
        assert!(mk(r#"{"npm":[],"marketplace":[{"id":"m"}]}"#));
    }

    #[test]
    fn list_rejects_non_json() {
        assert!(parse_plugin_list("No plugins installed", "/tmp").is_err());
    }

    #[test]
    fn features_roundtrip_parse() {
        let out = r#"{"plugin":"p","enabledFeatures":["web"],"availableFeatures":["search","web"]}"#;
        let f = parse_plugin_features(out).unwrap();
        assert_eq!(f.plugin, "p");
        assert_eq!(f.enabled_features, vec!["web"]);
        assert_eq!(f.available_features, vec!["search", "web"]);
    }

    #[test]
    fn doctor_parse() {
        let out = r#"[{"name":"plugins_directory","status":"ok","message":"Found at /x"},
                       {"name":"plugin:a","status":"warning","message":"m","fixed":true}]"#;
        let f = parse_doctor(out).unwrap();
        assert_eq!(f.len(), 2);
        assert_eq!(f[0].status, "ok");
        assert!(!f[0].fixed);
        assert!(f[1].fixed);
        assert!(parse_doctor("{}").is_err());
    }

    #[test]
    fn features_set_arg_covers_empty_case() {
        assert_eq!(features_set_arg(&[]), " ");
        assert_eq!(
            features_set_arg(&["search".into(), "web".into()]),
            "search,web"
        );
    }

    #[test]
    fn validation_shapes() {
        assert!(valid_plugin_ref("v23-probe-plugin"));
        assert!(valid_plugin_ref("@oh-my-pi/exa"));
        assert!(!valid_plugin_ref("   "));
        assert!(!valid_plugin_ref(" padded "));
        assert!(!valid_plugin_ref("bad\nname"));
        assert!(!valid_plugin_ref(&"x".repeat(NAME_MAX_LEN + 1)));

        assert!(valid_source("github:org/repo#v1.4.0"));
        assert!(valid_source("./my-plugin"));
        assert!(!valid_source("  "));
        assert!(!valid_source("a\u{7}b"));

        assert!(valid_scope("user") && valid_scope("project"));
        assert!(!valid_scope("global"));
    }

    #[test]
    fn scope_cwd_defaults_to_agent_dir_and_checks_project() {
        let agent = std::env::temp_dir();
        assert_eq!(scope_cwd(&agent, None).unwrap(), agent);
        assert_eq!(scope_cwd(&agent, Some("  ")).unwrap(), agent);
        assert!(scope_cwd(&agent, Some("relative/dir")).is_err());
        assert!(scope_cwd(&agent, Some("/definitely/not/here")).is_err());
        assert!(scope_cwd(&agent, Some(&agent.to_string_lossy())).is_ok());
    }
}

#[cfg(test)]
mod real_tests {
    use super::*;

    /// 真实 omp 冒烟（`cargo test -- --ignored`）：本机装了 omp 时跑一次 `omp plugin list --json`，
    /// 确认清单形状没漂（解析失败 = 上游换形状，界面会少内容）。
    /// 只读：不装 / 不卸任何插件。
    #[test]
    #[ignore]
    fn real_omp_plugin_list_parses() {
        let out = std::process::Command::new("omp")
            .args(["plugin", "list", "--json"])
            .output()
            .expect("omp 不在 PATH 上");
        assert!(out.status.success(), "omp plugin list 退出码非 0");
        let text = String::from_utf8_lossy(&out.stdout);
        let view = parse_plugin_list(&text, "/tmp").expect("清单解析失败");
        assert!(view.npm.iter().all(|p| !p.name.is_empty()));
        assert!(view.marketplace.iter().all(|m| m.id.contains('@')));
    }

    /// 真实 omp 冒烟：`omp plugin doctor --json`（只读检查，不带 `--fix`）。
    #[test]
    #[ignore]
    fn real_omp_doctor_parses() {
        let out = std::process::Command::new("omp")
            .args(["plugin", "doctor", "--json"])
            .output()
            .expect("omp 不在 PATH 上");
        assert!(out.status.success(), "带 --json 的 doctor 应为退出码 0（实测口径）");
        let text = String::from_utf8_lossy(&out.stdout);
        let findings = parse_doctor(&text).expect("体检结果解析失败");
        assert!(findings.iter().any(|f| f.name == "plugins_directory"));
    }
}
