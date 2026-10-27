//! 技能（Skill，设置 ›「技能」）：把 omp 的技能发现与逐项启停映射进设置页。
//!
//! 上游事实（omp 18.3.5 实测）：
//! - `omp skill list [dir] --json` → `{skills: [{name, description, filePath, baseDir, source, hide}],
//!   warnings: []}`。`source` = `<provider>:<level>`，实测值：`native:user`（`<agentDir>/skills`）、
//!   `native:project`（`.omp/skills`）、`agents:user|project`（`~/.agents`、`.agents`）、
//!   `claude:*`、`codex:*`、`omp-plugins:user`（插件内置）、`omp-managed:user`（自动学到的）、
//!   `custom:user`（`skills.customDirectories`）、`opencode:*`、`github:*`。
//! - **发现按 cwd 走**：项目级技能 = 从该目录向上走到仓库根逐级找 `.omp/skills`、`.agents/skills`、
//!   `.claude/skills`… 所以命令面必须带范围（前端给项目目录；`None` = 家目录 = 只看用户级）。
//! - **逐项启停 = `disabledExtensions` 数组里的 `skill:<name>` 条目**（omp 的 `/extensions` 面板
//!   开关写的就是它）。**被停用的技能不会出现在 `omp skill list` 里**（上游在发现阶段就按名字过滤掉了），
//!   所以界面上的「已停用」行只能来自这个配置数组（拿不到描述与路径，这是上游行为）。
//! - 名字是**全局按名匹配**（不分 provider / scope）：同名技能 omp 只保留优先级最高的一份，
//!   停用也是名字级——界面必须照实说。
//! - 这个键是 `array` 型，`omp config set` 只接受整组 JSON 数组（与 `cycleOrder` 同款）。
//!
//! **只读写这一个键**：其它过滤（`skills.enabled` / `ignoredSkills` / `includeSkills` /
//! provider 开关）都在「常用设置」页，本模块不动；`customDirectories` 也不碰。

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::State;

use crate::commands::{cmd_err, AppState, CmdError};
use crate::providers::{config_values_global, omp_bin, run_omp_capture_env, run_omp_in_timeout};

/// 技能发现是纯本地扫描，实测 0.2–0.5s；给足余量。
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// 技能名（frontmatter `name` 或目录名）长度上限。
pub const NAME_MAX_LEN: usize = 128;
/// `SKILL.md` 预览的读取上限（与记忆页同口径：超出截断并告知）。
const READ_MAX_BYTES: usize = 1024 * 1024;
/// `disabledExtensions` 里技能条目的前缀。
const SKILL_PREFIX: &str = "skill:";
/// 全量发现的 overlay：只看这一个键——把停用名单覆盖成空数组，过滤就只剩「技能是否存在」。
const FULL_LIST_OVERLAY: &str = "disabledExtensions: []\n";

// ---------- 视图类型 ----------

/// 一个被发现的技能。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillItem {
    pub name: String,
    /// frontmatter 的 `description`（上游英文 / 用户自写，原样透传）。
    pub description: String,
    pub file_path: String,
    /// `SKILL.md` 所在目录（打开 / 复制路径用）。
    pub base_dir: String,
    /// `<provider>:<level>`（界面按表翻译，未知值原样显示）。
    pub source: String,
    /// frontmatter 的 `hide` / `disable-model-invocation`：不参与自动匹配，只能显式调用。
    pub hide: bool,
}

/// 发现过程中的警告（同名冲突、frontmatter 读不出来…）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillWarning {
    pub skill_path: String,
    pub message: String,
}

/// 技能清单：`cwd` = 这次发现钉的范围（家目录 = 用户级）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsView {
    pub cwd: String,
    pub skills: Vec<SkillItem>,
    /// 被 `disabledExtensions` 停用的技能名（上游列表里已看不到它们，只能从配置读）。
    /// 这是配置真值：其中可能混着「技能已被删掉」的旧记录（见 `stale_disabled`）。
    pub disabled: Vec<String>,
    /// `disabled` 里**已经发现不到同名技能**的那些（技能目录被删 / 改名后留下的旧记录）。
    ///
    /// 判定方式：用一份把 `disabledExtensions` 覆盖成空数组的 `PI_CONFIG_FILES` overlay
    /// 再跑一次 `omp skill list`——过滤只来自这个键，于是能拿到「全部技能」的名字全集，
    /// 停用名单里不在全集里的就是旧记录。探测失败时为空（按「仍然存在」显示，绝不误藏）。
    pub stale_disabled: Vec<String>,
    pub warnings: Vec<SkillWarning>,
}

/// `SKILL.md` 的正文（`truncated` = 超过上限被截断）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileContent {
    pub text: String,
    pub bytes: usize,
    pub truncated: bool,
}

// ---------- 纯逻辑（单测锁着） ----------

/// 技能名形状：非空、长度受限、无控制字符、首尾无空白。
///
/// 名字会被拼成 `skill:<name>` 写进 omp 配置，也是 omp 的唯一匹配键；先钉形状，
/// 别把前端 bug 变成对配置的随意写入。
pub fn valid_skill_name(s: &str) -> bool {
    let t = s.trim();
    !t.is_empty() && t.len() <= NAME_MAX_LEN && t == s && !s.chars().any(char::is_control)
}

/// `disabledExtensions` 原始值 → 其中的技能名（非数组 / 非字符串项一律丢弃，保序去重）。
pub fn disabled_skill_names(v: Option<&serde_json::Value>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    v.and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str())
                .filter_map(|s| s.strip_prefix(SKILL_PREFIX))
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .filter(|n| seen.insert(n.to_string()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 停用名单里**已经发现不到同名技能**的那些（技能被删 / 改名后留下的旧记录），保序。
///
/// 判定依据是「把停用过滤摘掉之后的全量发现」：全量里没有这个名字 = 它不指向任何技能。
/// 只做集合差，不猜目录、不猜优先级——发现的边界仍由 omp 自己划。
pub fn stale_disabled_names(disabled: &[String], discovered_all: &[String]) -> Vec<String> {
    let all: std::collections::HashSet<&str> = discovered_all.iter().map(String::as_str).collect();
    disabled
        .iter()
        .filter(|n| !all.contains(n.as_str()))
        .cloned()
        .collect()
}

/// 把探测 overlay 接到 `PI_CONFIG_FILES` 现有值的**末尾**（追加，不覆盖用户自己设的 overlay）。
///
/// omp 按平台路径分隔符切这个变量（`path.delimiter`：POSIX `:` / Windows `;`），
/// 用 `split_paths` + `join_paths` 跟着它的口径走，不手写分隔符。
pub fn overlay_chain(existing: Option<&str>, probe: &Path) -> String {
    let mut all: Vec<PathBuf> = existing
        .map(std::env::split_paths)
        .map(|p| p.filter(|x| !x.as_os_str().is_empty()).collect())
        .unwrap_or_default();
    all.push(probe.to_path_buf());
    std::env::join_paths(all)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|_| probe.to_string_lossy().into_owned())
}

/// 启停一项技能：在 `disabledExtensions` 里加 / 删 `skill:<name>`，**其余条目原样保留**。
///
/// 整组覆盖写意味着「读到什么就写回什么」：`plugin:` / `rule:` / `tool:` 等别人的停用项不能碰，
/// 连非字符串的脏条目（手编配置 / 别的工具写的）也原样带走——悄悄替用户清理配置不是壳侧的职责。
pub fn apply_skill_toggle(
    entries: &[serde_json::Value],
    name: &str,
    enabled: bool,
) -> Vec<serde_json::Value> {
    let target = format!("{SKILL_PREFIX}{name}");
    let mut out: Vec<serde_json::Value> = entries
        .iter()
        .filter(|e| e.as_str() != Some(target.as_str()))
        .cloned()
        .collect();
    if !enabled {
        out.push(serde_json::Value::String(target));
    }
    out
}

/// 解析 `omp skill list --json`：条目缺 `name` / `filePath` 就跳过（上游换形状时少一行，
/// 不该整页报错）；`warnings` 容错为空。
pub fn parse_skill_list(out: &str) -> Result<(Vec<SkillItem>, Vec<SkillWarning>), String> {
    let v: serde_json::Value =
        serde_json::from_str(out.trim()).map_err(|e| format!("技能清单解析失败：{e}"))?;
    let skills = v
        .get("skills")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| {
                    let name = s.get("name").and_then(|x| x.as_str()).filter(|n| !n.trim().is_empty())?;
                    let file_path = s.get("filePath").and_then(|x| x.as_str())?;
                    Some(SkillItem {
                        name: name.to_string(),
                        description: s
                            .get("description")
                            .and_then(|x| x.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        file_path: file_path.to_string(),
                        base_dir: s.get("baseDir").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
                        source: s.get("source").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
                        hide: s.get("hide").and_then(|x| x.as_bool()).unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let warnings = v
        .get("warnings")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|w| {
                    let message = w.get("message").and_then(|x| x.as_str())?.to_string();
                    Some(SkillWarning {
                        skill_path: w.get("skillPath").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
                        message,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok((skills, warnings))
}

/// 技能预览只允许读 `SKILL.md`（目录里的附带文件想在壳里看不是这一页的职责）。
pub fn is_skill_file(path: &Path) -> bool {
    path.file_name().and_then(|n| n.to_str()) == Some("SKILL.md")
}

/// 发现范围：给了就用（必须是存在的目录），没给就退回家目录（用户级技能一直都能看到）。
pub fn resolve_skill_cwd(home: Option<&str>, cwd: Option<&str>) -> Result<PathBuf, String> {
    let Some(raw) = cwd.map(str::trim).filter(|s| !s.is_empty()) else {
        let h = home.map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| "取不到家目录".to_string())?;
        let p = PathBuf::from(h);
        return if p.is_dir() { Ok(p) } else { Err(format!("家目录不存在：{h}")) };
    };
    let p = Path::new(raw);
    if !p.is_absolute() {
        return Err(format!("范围必须是绝对路径：{raw}"));
    }
    if !p.is_dir() {
        return Err(format!("目录不存在：{raw}"));
    }
    Ok(std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()))
}

/// 截到 `max` 字节且不切碎 UTF-8 字符（与记忆页同口径）。
fn truncate_utf8(bytes: &[u8], max: usize) -> &[u8] {
    if bytes.len() <= max {
        return bytes;
    }
    let mut end = max;
    while end > 0 && (bytes[end] & 0b1100_0000) == 0b1000_0000 {
        end -= 1;
    }
    &bytes[..end]
}

// ---------- 命令 ----------

/// 读被停用的技能名（钉 agentDir = 全局层，与写入同层）。
async fn read_disabled(
    state: &State<'_, AppState>,
    bin: &str,
) -> Result<Vec<String>, CmdError> {
    let vals = config_values_global(state, bin, &["disabledExtensions"])
        .await
        .map_err(|e| cmd_err("SKILL_CONFIG_READ_FAILED", format!("读取停用列表失败：{e}"), None))?;
    Ok(disabled_skill_names(vals.get("disabledExtensions")))
}

/// 同进程里两次探测的临时 overlay 不能撞名（并发切范围会同时跑）。
static PROBE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// 在「停用名单清空」的 overlay 下再发现一次，返回技能名全集。
///
/// 失败（写不了临时文件 / omp 跑不起来 / 输出不是 JSON）返回 `None`：调用方一律按
/// 「停用记录仍然有效」处理——宁可多留一行旧记录，不可把真实存在的停用项误藏掉。
async fn discover_all_names(agent: &Path, bin: &str, dir: &Path) -> Option<Vec<String>> {
    let probe = std::env::temp_dir().join(format!(
        "omp-inn-skill-probe-{}-{}.yml",
        std::process::id(),
        PROBE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::write(&probe, FULL_LIST_OVERLAY).ok()?;
    let chain = overlay_chain(std::env::var("PI_CONFIG_FILES").ok().as_deref(), &probe);
    let out = run_omp_capture_env(
        Some(agent),
        bin,
        &["skill", "list", &dir.to_string_lossy(), "--json"],
        READ_TIMEOUT,
        &[("PI_CONFIG_FILES", chain.as_str())],
    )
    .await;
    // 垫片只服务这一次探测，别留在临时目录里。
    let _ = std::fs::remove_file(&probe);
    let (stdout, _err, code) = out.ok()?;
    if code != Some(0) {
        return None;
    }
    let (skills, _) = parse_skill_list(&stdout).ok()?;
    Some(skills.into_iter().map(|s| s.name).collect())
}

/// 技能清单：按 `cwd`（项目目录 / 家目录）做一次发现 + 当前停用名 + 悬空停用记录。
#[tauri::command]
pub async fn list_skills(
    state: State<'_, AppState>,
    cwd: Option<String>,
) -> Result<SkillsView, CmdError> {
    let bin = omp_bin(&state)?;
    let home = std::env::var("HOME").ok();
    let dir = resolve_skill_cwd(home.as_deref(), cwd.as_deref())
        .map_err(|e| cmd_err("SKILL_CWD_INVALID", e, None))?;
    let agent = state.agent_dir.lock().await.clone();
    let out = run_omp_in_timeout(
        Some(&agent),
        &bin,
        &["skill", "list", &dir.to_string_lossy(), "--json"],
        READ_TIMEOUT,
    )
    .await
    .map_err(|e| cmd_err("SKILL_LIST_FAILED", format!("读取技能清单失败：{e}"), None))?;
    let (skills, warnings) =
        parse_skill_list(&out).map_err(|e| cmd_err("SKILL_LIST_FAILED", e, None))?;
    let disabled = read_disabled(&state, &bin).await?;
    // 停用记录可能指向已经删掉的技能（用户手动删目录 / 改过名）：再用一次「清空停用」的
    // 发现拿全量名字对账。没有停用记录时省掉这一次子进程。
    let stale_disabled = if disabled.is_empty() {
        Vec::new()
    } else {
        match discover_all_names(&agent, &bin, &dir).await {
            Some(all) => stale_disabled_names(&disabled, &all),
            None => Vec::new(),
        }
    };
    Ok(SkillsView {
        cwd: dir.to_string_lossy().to_string(),
        skills,
        disabled,
        stale_disabled,
        warnings,
    })
}

/// 启用 / 停用一项技能：写 `disabledExtensions`（读 → 改 → 整组写回 → 回读）。
///
/// 返回**回读后**的停用技能名——omp 静默丢弃写入时界面不该停在乐观值上。
#[tauri::command]
pub async fn set_skill_enabled(
    state: State<'_, AppState>,
    name: String,
    enabled: bool,
) -> Result<Vec<String>, CmdError> {
    if !valid_skill_name(&name) {
        return Err(cmd_err("SKILL_NAME_INVALID", format!("非法的技能名：{name}"), None));
    }
    let bin = omp_bin(&state)?;
    let _guard = state.extensions_edit.lock().await;
    let vals = config_values_global(&state, &bin, &["disabledExtensions"])
        .await
        .map_err(|e| cmd_err("SKILL_CONFIG_READ_FAILED", format!("读取停用列表失败：{e}"), None))?;
    let current: Vec<serde_json::Value> = vals
        .get("disabledExtensions")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let next = apply_skill_toggle(&current, &name, enabled);
    if next != current {
        let json = serde_json::to_string(&serde_json::Value::Array(next))
            .map_err(|e| cmd_err("SKILL_CONFIG_WRITE_FAILED", format!("序列化失败：{e}"), None))?;
        let agent = state.agent_dir.lock().await.clone();
        run_omp_in_timeout(
            Some(&agent),
            &bin,
            &["config", "set", "disabledExtensions", &json],
            READ_TIMEOUT,
        )
        .await
        .map_err(|e| {
            cmd_err(
                "SKILL_CONFIG_WRITE_FAILED",
                format!("{}技能失败：{e}", if enabled { "启用" } else { "停用" }),
                None,
            )
        })?;
    }
    read_disabled(&state, &bin).await
}

/// 读一个文本文件的前 `max` 个字节（不截碎 UTF-8 字符）。
///
/// 只读「上限 + 1」个字节：`SKILL.md` 正常是几 KB，但病态大文件不该整个读进内存；
/// 多读 1 字节是为了区分「正好等于上限」与「被截断」。
pub fn read_text_prefix(path: &Path, max: usize) -> Result<SkillFileContent, std::io::Error> {
    let size = std::fs::metadata(path)?.len() as usize;
    let mut buf = Vec::with_capacity(max.min(size) + 1);
    let file = std::fs::File::open(path)?;
    file.take(max as u64 + 1).read_to_end(&mut buf)?;
    let cut = truncate_utf8(&buf, max);
    Ok(SkillFileContent {
        text: String::from_utf8_lossy(cut).to_string(),
        bytes: size,
        truncated: size > cut.len(),
    })
}

/// 读一个 `SKILL.md` 的正文（超过上限截断并标记）。
#[tauri::command]
pub async fn read_skill_file(path: String) -> Result<SkillFileContent, CmdError> {
    let p = PathBuf::from(path.trim());
    if !p.is_absolute() {
        return Err(cmd_err("SKILL_PATH_INVALID", "技能文件路径必须是绝对路径".into(), None));
    }
    if !is_skill_file(&p) {
        return Err(cmd_err("SKILL_PATH_INVALID", "只能预览 SKILL.md".into(), None));
    }
    let meta = std::fs::metadata(&p).map_err(|e| {
        cmd_err("SKILL_READ_FAILED", format!("读取技能文件失败：{e}"), None)
    })?;
    if !meta.is_file() {
        return Err(cmd_err("SKILL_PATH_INVALID", "技能文件不是一个普通文件".into(), None));
    }
    read_text_prefix(&p, READ_MAX_BYTES)
        .map_err(|e| cmd_err("SKILL_READ_FAILED", format!("读取技能文件失败：{e}"), None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const LIST: &str = r#"{
      "skills": [
        {"name":"web-search","description":"联网检索","filePath":"/Users/me/.agents/skills/web-search/SKILL.md","baseDir":"/Users/me/.agents/skills/web-search","source":"agents:user","hide":false},
        {"name":"proj-skill","description":"项目技能","filePath":"/p/.omp/skills/proj-skill/SKILL.md","baseDir":"/p/.omp/skills/proj-skill","source":"native:project","hide":true},
        {"name":"  ","filePath":"/bad"},
        {"name":"noPath"}
      ],
      "warnings": [{"skillPath":"/p/.omp/skills","message":"name collision"}]
    }"#;

    #[test]
    fn list_parses_and_skips_broken_rows() {
        let (skills, warnings) = parse_skill_list(LIST).unwrap();
        assert_eq!(skills.len(), 2);
        assert_eq!(skills[0].name, "web-search");
        assert_eq!(skills[0].source, "agents:user");
        assert!(!skills[0].hide);
        assert_eq!(skills[1].source, "native:project");
        assert!(skills[1].hide);
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].skill_path, "/p/.omp/skills");
        assert!(parse_skill_list("No skills discovered.").is_err());
    }

    #[test]
    fn disabled_names_only_read_skill_entries() {
        let v = json!(["skill:a", "plugin:x", "skill:b", "skill:a", "skill:", "skill:  ", 7]);
        assert_eq!(disabled_skill_names(Some(&v)), vec!["a", "b"]);
        assert_eq!(disabled_skill_names(None), Vec::<String>::new());
        assert_eq!(disabled_skill_names(Some(&json!({"skill:a": true}))), Vec::<String>::new());
        assert_eq!(disabled_skill_names(Some(&json!([]))), Vec::<String>::new());
    }

    #[test]
    fn stale_disabled_only_keeps_names_without_a_skill() {
        let all = vec!["web".to_string(), "docs".to_string()];
        assert_eq!(
            stale_disabled_names(&["web".into(), "gone".into(), "docs".into()], &all),
            vec!["gone".to_string()]
        );
        // 全量里一个都没有（比如探测拿到了空列表）→ 全部算悬空
        assert_eq!(
            stale_disabled_names(&["web".into()], &[]),
            vec!["web".to_string()]
        );
        // 停用名单为空 → 没有悬空项
        assert!(stale_disabled_names(&[], &all).is_empty());
    }

    #[test]
    fn overlay_chain_appends_to_existing_files() {
        let probe = Path::new("/tmp/omp-inn-probe.yml");
        let joined = overlay_chain(Some("/a/one.yml"), probe);
        let parts: Vec<_> = std::env::split_paths(&joined).collect();
        assert_eq!(parts, vec![Path::new("/a/one.yml"), probe]);
        // 没设过 / 空值 → 只有探测 overlay
        for existing in [None, Some("")] {
            let parts: Vec<_> = std::env::split_paths(&overlay_chain(existing, probe)).collect();
            assert_eq!(parts, vec![probe]);
        }
    }

    #[test]
    fn toggle_keeps_other_entries_and_is_idempotent() {
        let base = json!(["plugin:x", "skill:old", 7, {"weird": true}]);
        let arr = base.as_array().unwrap();
        // 停用：追加到尾部，其余条目（含非字符串脏项）原样保留
        let off = apply_skill_toggle(arr, "web", false);
        assert_eq!(off, json!(["plugin:x", "skill:old", 7, {"weird": true}, "skill:web"]).as_array().unwrap().clone());
        // 重复停用不产生第二条
        let off2 = apply_skill_toggle(&off, "web", false);
        assert_eq!(off2, off);
        // 启用：只摘掉这一条
        let on = apply_skill_toggle(&off, "web", true);
        assert_eq!(on, arr.clone());
        // 本来就没停用 → 启用是空操作
        assert_eq!(apply_skill_toggle(arr, "web", true), arr.clone());
    }

    #[test]
    fn name_shape() {
        assert!(valid_skill_name("web-search"));
        assert!(valid_skill_name("中文技能"));
        assert!(!valid_skill_name(""));
        assert!(!valid_skill_name(" lead"));
        assert!(!valid_skill_name("trail "));
        assert!(!valid_skill_name("a\nb"));
        assert!(!valid_skill_name(&"x".repeat(NAME_MAX_LEN + 1)));
    }

    #[test]
    fn skill_file_guard_and_truncate() {
        assert!(is_skill_file(Path::new("/a/b/SKILL.md")));
        assert!(!is_skill_file(Path::new("/a/b/readme.md")));
        assert!(!is_skill_file(Path::new("/a/b/SKILL.md.bak")));
        // 截断不切碎多字节字符：7 字节落在「技」的中间 → 退到上一个完整字符
        let s = "技能".repeat(3);
        assert_eq!(String::from_utf8_lossy(truncate_utf8(s.as_bytes(), 7)), "技能");
        assert_eq!(String::from_utf8_lossy(truncate_utf8(s.as_bytes(), 9)), "技能技");
    }

    #[test]
    fn read_prefix_truncates_on_char_boundary() {
        let dir = std::env::temp_dir().join(format!("v23-skill-read-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let big = dir.join("big.md");
        std::fs::write(&big, "技能技能技能").unwrap(); // 18 字节
        let v = read_text_prefix(&big, 7).unwrap();
        assert_eq!(v.bytes, 18);
        assert_eq!(v.text, "技能");
        assert!(v.truncated);
        let small = dir.join("small.md");
        std::fs::write(&small, "# 标题\n正文").unwrap();
        let v = read_text_prefix(&small, 1024).unwrap();
        assert_eq!(v.text, "# 标题\n正文");
        assert!(!v.truncated);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cwd_resolution() {
        let home = std::env::temp_dir();
        let h = home.to_string_lossy().to_string();
        assert_eq!(resolve_skill_cwd(Some(&h), None).unwrap(), home);
        assert_eq!(resolve_skill_cwd(Some(&h), Some("  ")).unwrap(), home);
        assert!(resolve_skill_cwd(Some(&h), Some("relative")).is_err());
        assert!(resolve_skill_cwd(Some(&h), Some("/definitely/not/here")).is_err());
        assert!(resolve_skill_cwd(None, None).is_err());
        assert!(resolve_skill_cwd(Some(&h), Some(&h)).is_ok());
    }
}

#[cfg(test)]
mod real_tests {
    use super::*;

    /// 真实 omp 冒烟（`cargo test -- --ignored`）：跑一次 `omp skill list <家目录> --json`，
    /// 确认发现结果的形状没漂（只读；家目录 = 只看用户级技能）。
    #[test]
    #[ignore]
    fn real_omp_skill_list_parses() {
        let home = std::env::var("HOME").expect("取不到家目录");
        let out = std::process::Command::new("omp")
            .args(["skill", "list", &home, "--json"])
            .output()
            .expect("omp 不在 PATH 上");
        assert!(out.status.success(), "omp skill list 退出码非 0：{}", String::from_utf8_lossy(&out.stderr));
        let text = String::from_utf8_lossy(&out.stdout);
        let (skills, _warnings) = parse_skill_list(&text).expect("技能清单解析失败");
        for s in &skills {
            assert!(!s.name.trim().is_empty());
            assert!(s.file_path.ends_with("SKILL.md"), "{} 的路径不是 SKILL.md", s.name);
            assert!(s.source.contains(':'), "{} 的来源不是 provider:level", s.name);
        }
    }
}
