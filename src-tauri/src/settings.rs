//! 设置页后端（设置 ›「常用设置」）：omp 全局配置（`config.yml`）的读 / 写——catalog 命令给
//! 页面完整目录（前端按 `src/lib/settingsList.ts` 的展示清单过滤），set / reset 写单键。
//! **读写走 `omp config` CLI 子进程**（与供应商页走 `omp auth-broker` 同款），
//! 壳侧不直接解析 / 改写 `config.yml` —— YAML 的合并、类型解析、schema 默认值都是 omp 的事。
//!
//! 上游事实（omp 18.2.1 实测）：
//! - `omp config list --json` 输出**扁平点路径** → `{value, type, description}`（本机 519 项、
//!   约 93KB、实测 ~0.2s）。`type` 是 `boolean|number|enum|string|array|record`；**enum 的合法
//!   取值不在 JSON 里**（只在人读的 `omp config list` 文本里，形如
//!   `edit.mode = hashline (apply_patch|…)`），所以目录命令把文本与 JSON 两路合并（文本给分组
//!   与取值表）；当前值不在表里就原样补一条，不吞信息。
//! - `omp config get <key> --json` 回 `{key, value, type, description}`；未知 key 退出码 1。
//! - `omp config set <key> <value>` 按 schema 类型解析值：boolean 接受 `true/false/yes/no/on/off/1/0`，
//!   enum 必须精确匹配（失败时 stderr 回 `Error: Invalid value: X. Valid values: …`，原样透传给用户），
//!   写入的是**全局层**（`~/.omp/agent/config.yml`），**不写** `<cwd>/.omp/config.yml`。
//! - **负数 / 以 `-` 开头的值必须用 `--` 分隔**：实测 `omp config set temperature -1` 直接报
//!   `error: Unknown option '-1'`（yargs 把它当 flag），正确写法是 `omp config set temperature -- -1`。
//!   本模块一律走 `--` 形式（对普通值无副作用，已实测）——`temperature` / `compaction.thresholdPercent`
//!   的「默认」就是 `-1`，绕不开。
//! - `omp config reset <key>` 把该键的 **schema 默认值写回**全局配置（不是删键）；界面上的
//!   「恢复默认」用它。
//! - **读数受项目层影响**：`list` / `get` 返回的是 `defaults ← global ← project` 合并后的**有效值**。
//!   本模块一律把工作目录钉在 agentDir（那里不会有 `.omp/`），读到 / 写回的就是全局层的真相。
//! - **改动何时生效未实测**：长驻的 `omp --mode rpc` 会话是否热读 `config.yml` 没能验证
//!   （试过用 `extendedContext` + `get_state.contextWindow` 对拍，该键对当前模型没有可观测差异；
//!   18.2.1 的二进制里 JS 已不再是可读源码，`strings` 取不到加载逻辑）。界面上只做**必然为真**
//!   的表述——「新建的会话一定读到新值」，不宣称已打开的会话会立刻应用。
//!
//! 壳侧**只碰全局层**：不写项目配置、不写覆盖层、不直读凭证库；后端只做**格式校验**（点分
//! 标识符）与类型序列化，不认识具体有哪些键——页面上显示哪些键由前端展示清单
//! （`src/lib/settingsList.ts`，117 项）限定；上游增删配置项时代码无须改动。
//!
//! **设置目录**（`get_omp_settings_catalog`）：后端返回上游的完整目录
//! （下述格式与数字在 omp 18.4.4 上复核，519 项 / 11 分组 / 89 枚举），页面再按展示清单过滤——
//! 全量里内部 / 细调占大头、不铺给用户；要浏览完整清单在终端里 `omp config list`。
//! `omp config list` 的**人读文本**是分组与枚举取值的唯一来源（JSON 只给 `type: "enum"`，
//! 不给合法取值）：
//! - 分组：`[appearance]` / `[context]` … 11 段的方括号标题；
//! - 行：`  edit.mode = hashline (apply_patch|hashline|patch|replace|sloppy)`——尾括号里带 `|`
//!   才是枚举取值表；普通类型是 `(boolean)` / `(number)` / `(string)` / `(array)` / `(record)`；
//! - 未设置：`(not set)`（JSON 里对应**没有 `value` 字段**，本模块映射成 `Null`）；
//! - 脱敏：令牌类键无论是否设置都显示 `********`（JSON 里是 `redacted: true` 且不带 value——
//!   实测 `searxng.token` 设置后 `config get` 能读回原值、但 `config list` 一律隐藏）。
//! 值与说明仍以 `--json` 那一路为准（文本里的值只是展示格式），两路都跑、按 key 合并：
//! 文本定顺序 / 分组 / 取值表，JSON 定类型 / 值 / 说明。文本那一路失败时退化成纯 JSON
//! （无分组 / 无取值表），不至于整页打不开。
//! - 数组 / 记录以 **JSON 文本**写入：实测 `omp config set ttsr.disabledRules -- '["a"]'` 成功、
//!   `a,b` 报 `Error: Invalid array JSON: a,b`；`config set modelTags -- '{"a":"b"}'` 同理
//!   （`Invalid record JSON`）。所以 `value_arg` 对 array / object 直接做紧凑 JSON 序列化。

use serde::Serialize;
use std::path::Path;
use tauri::State;

use crate::commands::{cmd_err, discover_omp_path, AppState, CmdError};
use crate::providers::run_omp_in;

/// key 的长度上限：omp 的 schema 路径都是短点分标识符。
const KEY_MAX_LEN: usize = 128;

// ---------- 视图类型 ----------

/// 一个设置项的当前值：`kind` 是 omp 的 schema 类型（boolean / number / enum / …），
/// `description` 是上游英文说明（原样透传，不做翻译——它是 omp 对这条设置的定义）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettingItem {
    pub key: String,
    pub value: serde_json::Value,
    pub kind: String,
    pub description: String,
}

/// 设置目录里的一项（设置页用）。`section` 是上游文本清单里的分组名
/// （`appearance` / `context` / …，空 = 只在 JSON 里出现、没归组）；`options` 是 enum 的
/// 合法取值（来自文本清单，非 enum 为空）；`redacted` = 上游隐藏了值（令牌类键）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogItem {
    pub key: String,
    /// 有效值；`Null` = 上游没有这个键的显式值（未设置 / 脱敏，配合 `redacted` 区分）。
    pub value: serde_json::Value,
    pub kind: String,
    pub description: String,
    pub section: String,
    pub options: Vec<String>,
    pub redacted: bool,
}

/// 上游设置目录：分组顺序（照上游文本清单）+ 全部项（顺序照上游文本清单）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsCatalog {
    pub sections: Vec<String>,
    pub items: Vec<CatalogItem>,
}

// ---------- 纯逻辑（单测锁着） ----------

/// key 是不是合法的点分标识符：非空、每段以**字母**开头、其余只含字母数字与 `_` / `-`。
///
/// 段内允许 `_` 与 `-` 是照着 omp 的 schema 来的（实测 18.2.1：`web_search.enabled`、
/// `generate_image.enabled` 带下划线，`providers.openai-codex.codeMode` 带连字符）。
/// 段首必须是字母：`-` 开头会被 yargs 当成 flag（`omp config set temperature -1` 就是这么
/// 翻车的，见模块头注释），从形状上先堵死。
///
/// 校验的意义不在防命令注入（`run_omp` 用 `Command::args` 传参、不经 shell），而在**别把
/// 前端 bug 变成对 omp 配置的随意写入**——`omp config set` 只认真实 schema 路径，但把
/// 用户可控字符串直接塞进命令行不是好习惯，这里先把形状钉死。
pub fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= KEY_MAX_LEN
        && key.split('.').all(|seg| {
            seg.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                && seg.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
}

/// 把界面传来的 JSON 值转成 `omp config set` 的位置参数（含负数在内的字符串形式）。
///
/// 标量按原样：bool → `true` / `false`、number → 十进制串、string → 原文（**允许空串**——
/// 实测 `omp config set browser.cdpUrl -- ''` 合法，即「显式设为空」）；array / object →
/// **紧凑 JSON**（实测上游就是按 JSON 解析这两个类型：`Invalid array JSON` / `Invalid record JSON`）。
/// `null` 与含控制字符的字符串一律拒绝——「取消设置」是 `omp config reset` 的语义，不走这里。
pub fn value_arg(value: &serde_json::Value) -> Result<String, String> {
    match value {
        serde_json::Value::Bool(b) => Ok(b.to_string()),
        serde_json::Value::Number(n) => Ok(n.to_string()),
        serde_json::Value::String(s) if !s.chars().any(char::is_control) => Ok(s.clone()),
        serde_json::Value::String(_) => Err("值不能含控制字符".into()),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            serde_json::to_string(value).map_err(|e| format!("值序列化失败：{e}"))
        }
        _ => Err("只支持布尔、数字、字符串、数组与对象类型的设置".into()),
    }
}

/// 从人读的 `omp config list` 文本行尾取出枚举取值表：`...(a|b|c)` 形式才认。
///
/// 只认**以 `|` 分隔**的尾括号——普通类型的尾括号是 `(boolean)` / `(number)` / `(string)` /
/// `(array)` / `(record)`（不含 `|`），值里的括号（如 `(not set)`）不在行尾。取不出就返回空
/// （enum 但没有取值表时，界面退化成普通文本输入，不猜）。
fn trailing_options(value_repr: &str) -> Vec<String> {
    let Some(head) = value_repr.strip_suffix(')') else {
        return vec![];
    };
    let Some(start) = head.rfind('(') else {
        return vec![];
    };
    let inner = &head[start + 1..];
    if !inner.contains('|') {
        return vec![];
    }
    inner.split('|').map(|s| s.to_string()).collect()
}

/// 从一行文本清单里拆出 `key` 与「值 + 尾括号」两段（`  key = value (…)`）。
fn split_list_row(line: &str) -> Option<(&str, &str)> {
    let rest = line.strip_prefix("  ")?;
    let (key, value_repr) = rest.split_once(" = ")?;
    valid_key(key).then_some((key, value_repr))
}

/// 一项的目录条目：值与说明取 JSON（类型化），分组与取值表由调用方给（文本那一路的产物）。
fn catalog_item(key: &str, entry: &serde_json::Value, section: &str, options: Vec<String>) -> CatalogItem {
    CatalogItem {
        key: key.to_string(),
        // 上游没有 value（未设置 / 脱敏）→ Null；界面配合 `redacted` 区分两种含义。
        value: entry.get("value").cloned().unwrap_or(serde_json::Value::Null),
        kind: entry.get("type").and_then(|t| t.as_str()).unwrap_or_default().to_string(),
        description: entry.get("description").and_then(|d| d.as_str()).unwrap_or_default().to_string(),
        section: section.to_string(),
        options,
        redacted: entry.get("redacted").and_then(|r| r.as_bool()).unwrap_or(false),
    }
}

/// 合并两路清单：**文本定顺序 / 分组 / 枚举取值**，**JSON 定类型 / 值 / 说明**。
///
/// - 文本里 `[appearance]` 这样的方括号行开一段，段内每行 `  key = value (…)` 记一项；
/// - 文本里出现但 JSON 里没有的 key（不该发生，防御）跳过；JSON 里有而文本里没有的
///   （上游改了文本格式 / 文本那一路失败）按 JSON 自身顺序补在最后，`section` 留空；
/// - 完全解析不出东西（两路都空）时返回空目录，由命令层决定是否报错。
pub fn parse_catalog(text: &str, json: &str) -> SettingsCatalog {
    let map = serde_json::from_str::<serde_json::Value>(json.trim())
        .ok()
        .and_then(|v| match v {
            serde_json::Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default();

    let mut sections: Vec<String> = Vec::new();
    let mut items: Vec<CatalogItem> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut section = String::new();

    for line in text.lines() {
        let trimmed = line.trim_end();
        if let Some(name) = trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            if !name.is_empty() && valid_key(name) {
                section = name.to_string();
                if !sections.contains(&section) {
                    sections.push(section.clone());
                }
            }
            continue;
        }
        let Some((key, value_repr)) = split_list_row(trimmed) else {
            continue;
        };
        let Some(entry) = map.get(key) else {
            continue;
        };
        seen.insert(key.to_string());
        let options = trailing_options(value_repr);
        items.push(catalog_item(key, entry, &section, options));
    }

    for (key, entry) in &map {
        if seen.contains(key) {
            continue;
        }
        items.push(catalog_item(key, entry, "", vec![]));
    }

    SettingsCatalog { sections, items }
}

// ---------- 进程调用 ----------

fn omp_bin(state: &tauri::State<'_, AppState>) -> Result<String, CmdError> {
    discover_omp_path(state).ok_or_else(|| {
        cmd_err(
            "OMP_MISSING",
            "未找到 omp，无法读写设置".into(),
            Some("请先在设置 ›「关于」里指定 omp 路径".into()),
        )
    })
}

/// 读一个键的有效值（带 `--json`，拿到 value 与 description）。
async fn read_one(dir: &Path, bin: &str, key: &str) -> Result<serde_json::Value, String> {
    let out = run_omp_in(settings_cwd(dir), bin, &["config", "get", key, "--json"]).await?;
    let v: serde_json::Value =
        serde_json::from_str(out.trim()).map_err(|e| format!("设置解析失败：{e}"))?;
    Ok(v)
}

/// 拿来做工作目录的 agentDir：**只在不存在的兜底路径上退让**。
///
/// agentDir 是「钉住全局层」的手段（见 `run_omp_in`），但它自己可能还没被 omp 建出来
/// （全新机器、omp 未初始化）——那种情况下 `current_dir` 会让 spawn 直接失败，
/// 所以退回到「不指定目录」，而不是让整个设置页报错。
fn settings_cwd(dir: &Path) -> Option<&Path> {
    dir.is_dir().then_some(dir)
}

/// 读 omp 全局层的「默认思考等级」（`defaultThinkingLevel`）——壳侧所有**思考档兜底**的唯一来源：
/// 会话里档位缺失 / 对新模型非法时落的就是它（`runtime.rs` 的 `auto_think_level` 夹到模型支持集），
/// 输入卡上的思考档选择器在真值不可用时显示的也是它。
///
/// cwd 钉 agentDir（与设置页同层，读全局层的有效值）；omp 不在 / 未设置 / 读失败返回 `None`，
/// 调用方自行兜底（最高档）——这里不猜、不硬编码默认值。
///
/// omp 定位走 `discover_omp_path`（唯一入口）而不是 `state.omp_path`：前端**启动时**就读这一档，
/// 那一刻诊断（`locate_omp`）还没落位；读 `state.omp_path` 会拿到 `None`，输入卡上的默认档
/// 就退成兜底值（最高档）——与 omp 配置里实际写的档位对不上，直到用户打开菜单才补读成功。
pub async fn read_default_thinking_level(state: &tauri::State<'_, AppState>) -> Option<String> {
    let bin = discover_omp_path(state)?;
    let dir = state.agent_dir.lock().await.clone();
    let v = read_one(&dir, &bin, "defaultThinkingLevel").await.ok()?;
    v.get("value").and_then(|x| x.as_str()).map(str::to_string)
}

/// 从 `omp config get` 的回包造一个视图项（写 / 恢复默认后回读用同一个口径）。
fn item_from_get(key: &str, v: &serde_json::Value) -> SettingItem {
    SettingItem {
        key: v.get("key").and_then(|k| k.as_str()).unwrap_or(key).to_string(),
        value: v.get("value").cloned().unwrap_or(serde_json::Value::Null),
        kind: v.get("type").and_then(|t| t.as_str()).unwrap_or_default().to_string(),
        description: v.get("description").and_then(|d| d.as_str()).unwrap_or_default().to_string(),
    }
}

// ---------- Tauri 命令 ----------

/// 设置目录（设置页用）：一次跑文本 + JSON 两路 `omp config list` 并合并。
///
/// **不惰性分页**：整份目录实测 ~90KB、两路合计 ~0.4s，前端一屏只按分组渲染、搜索在前端过滤。
/// 文本那一路失败时退化成纯 JSON（无分组 / 无枚举取值表），不把整页打不开——那部分信息
/// （分组与取值表）是锦上添花，JSON 才是值与类型的地基。
#[tauri::command]
pub async fn get_omp_settings_catalog(
    state: State<'_, AppState>,
) -> Result<SettingsCatalog, CmdError> {
    let bin = omp_bin(&state)?;
    let dir = state.agent_dir.lock().await.clone();
    let cwd = settings_cwd(&dir);
    let (text, json) = tokio::join!(
        run_omp_in(cwd, &bin, &["config", "list"]),
        run_omp_in(cwd, &bin, &["config", "list", "--json"]),
    );
    let json = json.map_err(|e| {
        cmd_err("SETTINGS_READ_FAILED", format!("读取 omp 设置失败：{e}"), None)
    })?;
    Ok(parse_catalog(&text.unwrap_or_default(), &json))
}

/// 写一个设置项：`omp config set <key> -- <value>`（`--` 是必需的，见模块头注释），
/// 写完**回读**返回真相——omp 静默丢弃写入时界面不该显示一个其实没生效的值。
#[tauri::command]
pub async fn set_omp_setting(
    state: State<'_, AppState>,
    key: String,
    value: serde_json::Value,
) -> Result<SettingItem, CmdError> {
    if !valid_key(&key) {
        return Err(cmd_err("SETTING_KEY_INVALID", format!("非法的设置键：{key}"), None));
    }
    let arg = value_arg(&value).map_err(|e| cmd_err("SETTING_VALUE_INVALID", e, None))?;
    let bin = omp_bin(&state)?;
    let dir = state.agent_dir.lock().await.clone();
    run_omp_in(settings_cwd(&dir), &bin, &["config", "set", &key, "--", &arg])
        .await
        .map_err(|e| cmd_err("SETTINGS_WRITE_FAILED", format!("写入设置失败：{e}"), None))?;
    let back = read_one(&dir, &bin, &key)
        .await
        .map_err(|e| cmd_err("SETTINGS_READ_FAILED", format!("回读设置失败：{e}"), None))?;
    Ok(item_from_get(&key, &back))
}

/// 恢复一个设置项的 schema 默认值（`omp config reset`，把默认值写回全局配置）。
#[tauri::command]
pub async fn reset_omp_setting(
    state: State<'_, AppState>,
    key: String,
) -> Result<SettingItem, CmdError> {
    if !valid_key(&key) {
        return Err(cmd_err("SETTING_KEY_INVALID", format!("非法的设置键：{key}"), None));
    }
    let bin = omp_bin(&state)?;
    let dir = state.agent_dir.lock().await.clone();
    run_omp_in(settings_cwd(&dir), &bin, &["config", "reset", &key])
        .await
        .map_err(|e| cmd_err("SETTINGS_RESET_FAILED", format!("恢复默认失败：{e}"), None))?;
    let back = read_one(&dir, &bin, &key)
        .await
        .map_err(|e| cmd_err("SETTINGS_READ_FAILED", format!("回读设置失败：{e}"), None))?;
    Ok(item_from_get(&key, &back))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_key_accepts_schema_paths() {
        assert!(valid_key("extendedContext"));
        assert!(valid_key("tools.approvalMode"));
        assert!(valid_key("bash.allowCompoundCommands"));
        assert!(valid_key("eval.py"));
        assert!(valid_key("task.isolation.merge"));
        // 实测 18.2.1 的真实键：下划线与连字符都出现在 schema 路径里
        assert!(valid_key("web_search.enabled"));
        assert!(valid_key("generate_image.enabled"));
        assert!(valid_key("providers.openai-codex.codeMode"));
        assert!(valid_key("providers.ollama-cloud.maxConcurrency"));
    }

    #[test]
    fn valid_key_rejects_shapes_that_are_not_schema_paths() {
        assert!(!valid_key(""));
        assert!(!valid_key(".leading.dot"));
        assert!(!valid_key("trailing."));
        assert!(!valid_key("double..dot"));
        assert!(!valid_key("has space"));
        assert!(!valid_key("-startsWithDash"));
        assert!(!valid_key("semi;colon"));
        assert!(!valid_key("quote\"inside"));
        assert!(!valid_key("newline\ninside"));
        // 段内可以有 `-`，但段首不行（会被 yargs 当 flag）
        assert!(valid_key("openai-codex.codeMode"));
        assert!(!valid_key("bad.-segment"));
        assert!(!valid_key(&"a".repeat(KEY_MAX_LEN + 1)));
    }

    #[test]
    fn value_arg_serializes_scalars() {
        assert_eq!(value_arg(&serde_json::json!(true)).unwrap(), "true");
        assert_eq!(value_arg(&serde_json::json!(false)).unwrap(), "false");
        // 负数与小数：omp 侧要 `--` 才不会当 flag，这里必须先给出正确的字符串
        assert_eq!(value_arg(&serde_json::json!(-1)).unwrap(), "-1");
        assert_eq!(value_arg(&serde_json::json!(0.7)).unwrap(), "0.7");
        assert_eq!(value_arg(&serde_json::json!(300)).unwrap(), "300");
        assert_eq!(value_arg(&serde_json::json!("apply_patch")).unwrap(), "apply_patch");
    }

    #[test]
    fn value_arg_serializes_containers_and_empties() {
        // array / record 走紧凑 JSON（实测上游按 JSON 解析：Invalid array JSON / Invalid record JSON）
        assert_eq!(value_arg(&serde_json::json!(["a", "b"])).unwrap(), r#"["a","b"]"#);
        assert_eq!(value_arg(&serde_json::json!({ "a": 1 })).unwrap(), r#"{"a":1}"#);
        assert_eq!(value_arg(&serde_json::json!([])).unwrap(), "[]");
        assert_eq!(value_arg(&serde_json::json!({})).unwrap(), "{}");
        // 空串 = 「显式设为空」（`omp config set browser.cdpUrl -- ''` 实测合法）
        assert_eq!(value_arg(&serde_json::json!("")).unwrap(), "");
    }

    #[test]
    fn value_arg_rejects_null_and_control_chars() {
        assert!(value_arg(&serde_json::json!(null)).is_err());
        assert!(value_arg(&serde_json::json!("bad\nvalue")).is_err());
    }

    /// 本机实测（omp 18.4.4）`omp config list` 人读文本的真实片段：分组标题 + 各类型行
    /// （枚举带取值表、`(not set)`、脱敏 `********`）逐字节照抄（截断）。
    const TEXT: &str = r#"Settings:

[appearance]
  theme.dark = dark-catppuccin (string)
  symbolPreset = nerd (unicode|nerd|ascii)
  colorBlindMode = false (boolean)

[context]
  workspace.additionalDirectories = [] (array)
  compaction.enabled = true (boolean)

[files]
  edit.mode = hashline (apply_patch|hashline|patch|replace|sloppy)
  read.defaultLimit = 300 (number)

[internal]
  modelTags = {} (record)
  statusLine.leftSegments = ["vim","model","mode","path","git","pr"] (array)
  images.urls.credentials = ******** (record)

[tools]
  browser.cdpUrl = (not set) (string)
"#;

    /// 与 `TEXT` 对拍的 `omp config list --json` 片段（同一次实测：omp 18.4.4）。
    const CATALOG_JSON: &str = r#"{
      "theme.dark": { "value": "dark-catppuccin", "type": "string", "description": "Theme used when the terminal has a dark background" },
      "symbolPreset": { "value": "nerd", "type": "enum", "description": "Glyph set for icons and symbols (Unicode, Nerd Font, or ASCII)" },
      "colorBlindMode": { "value": false, "type": "boolean", "description": "Use blue instead of green for diff additions" },
      "workspace.additionalDirectories": { "value": [], "type": "array", "description": "" },
      "compaction.enabled": { "value": true, "type": "boolean", "description": "Automatically compact context when it gets too large" },
      "edit.mode": { "value": "hashline", "type": "enum", "description": "Select the edit tool variant (replace, patch, hashline, or apply_patch)" },
      "read.defaultLimit": { "value": 300, "type": "number", "description": "" },
      "modelTags": { "value": {}, "type": "record", "description": "" },
      "statusLine.leftSegments": { "value": ["vim", "model", "mode", "path", "git", "pr"], "type": "array", "description": "" },
      "images.urls.credentials": { "redacted": true, "type": "record", "description": "" },
      "browser.cdpUrl": { "type": "string", "description": "Default HTTP CDP discovery endpoint" },
      "only.in.json": { "value": 1, "type": "number", "description": "" }
    }"#;

    #[test]
    fn parse_catalog_merges_text_order_with_json_types() {
        let c = parse_catalog(TEXT, CATALOG_JSON);
        // 分组顺序来自文本，`only.in.json` 不在文本里 → section 留空、排在最后
        assert_eq!(c.sections, vec!["appearance", "context", "files", "internal", "tools"]);
        let keys: Vec<&str> = c.items.iter().map(|i| i.key.as_str()).collect();
        assert_eq!(
            keys,
            vec![
                "theme.dark",
                "symbolPreset",
                "colorBlindMode",
                "workspace.additionalDirectories",
                "compaction.enabled",
                "edit.mode",
                "read.defaultLimit",
                "modelTags",
                "statusLine.leftSegments",
                "images.urls.credentials",
                "browser.cdpUrl",
                "only.in.json",
            ]
        );
        let by = |k: &str| c.items.iter().find(|i| i.key == k).unwrap().clone();

        // 枚举取值表来自文本，值与说明来自 JSON
        let symbol = by("symbolPreset");
        assert_eq!(symbol.section, "appearance");
        assert_eq!(symbol.options, vec!["unicode", "nerd", "ascii"]);
        assert_eq!(symbol.value, serde_json::json!("nerd"));
        assert_eq!(symbol.kind, "enum");
        assert!(symbol.description.contains("Glyph set"));
        assert_eq!(by("edit.mode").options, vec!["apply_patch", "hashline", "patch", "replace", "sloppy"]);

        // 未设置 = JSON 里没有 value → Null（配合 redacted=false 区别于脱敏）
        let cdp = by("browser.cdpUrl");
        assert_eq!(cdp.value, serde_json::Value::Null);
        assert!(!cdp.redacted);
        assert!(cdp.options.is_empty());

        // 脱敏：`********` 与 JSON 的 redacted 标记都指向同一个键
        let creds = by("images.urls.credentials");
        assert!(creds.redacted);
        assert_eq!(creds.value, serde_json::Value::Null);
        assert_eq!(by("only.in.json").section, "");

        // 复合类型按 JSON 的类型化值给出
        assert_eq!(by("read.defaultLimit").value, serde_json::json!(300));
        assert_eq!(by("modelTags").value, serde_json::json!({}));
        assert_eq!(
            by("statusLine.leftSegments").value,
            serde_json::json!(["vim", "model", "mode", "path", "git", "pr"])
        );
    }

    #[test]
    fn parse_catalog_survives_missing_text_and_bad_json() {
        // 文本那一路失败（空串）：仍能从 JSON 给出全部项，只是没有分组与取值表
        let c = parse_catalog("", CATALOG_JSON);
        assert!(c.sections.is_empty());
        assert_eq!(c.items.len(), 12);
        assert!(c.items.iter().all(|i| i.options.is_empty() && i.section.is_empty()));

        // JSON 那一路坏掉：目录为空（命令层照常返回，不 panic）
        let c = parse_catalog(TEXT, "not json");
        assert!(c.items.is_empty());
        assert_eq!(c.sections, vec!["appearance", "context", "files", "internal", "tools"]);

        // 文本里出现、JSON 里没有的 key（不该发生，防御）：跳过，不编造
        let c = parse_catalog("[appearance]\n  not.in.json = 1 (number)\n", CATALOG_JSON);
        assert!(c.items.iter().all(|i| i.key != "not.in.json"));
    }

    #[test]
    fn trailing_options_reads_only_pipe_tables() {
        assert_eq!(trailing_options("nerd (unicode|nerd|ascii)"), vec!["unicode", "nerd", "ascii"]);
        assert!(trailing_options("(not set) (string)").is_empty());
        assert!(trailing_options("false (boolean)").is_empty());
        assert!(trailing_options("{} (record)").is_empty());
        assert!(trailing_options("no-parens").is_empty());
        assert!(trailing_options("weird)").is_empty());
    }

    /// 真实 omp 只读慢测试（默认跳过；`cargo test -- --ignored` 手动跑，`OMP_BIN` 可指定路径）：
    /// 文本 + JSON 两路都跑真实命令并合并——**分组、枚举取值表、每项的类型**都要与上游实况
    /// 对得上（上游改了人读文本的格式会在这里先炸，而不是等用户打开设置页看到空分组）。
    #[test]
    #[ignore]
    fn real_omp_settings_catalog_parses() {
        let bin = std::env::var("OMP_BIN").unwrap_or_else(|_| "omp".into());
        let run = |args: &[&str]| {
            std::process::Command::new(&bin)
                .args(args)
                .stdin(std::process::Stdio::null())
                .output()
        };
        let Ok(text_out) = run(&["config", "list"]) else {
            eprintln!("跳过：无法运行 {bin}（设 OMP_BIN 指定路径）");
            return;
        };
        let Ok(json_out) = run(&["config", "list", "--json"]) else {
            eprintln!("跳过：无法运行 {bin} config list --json");
            return;
        };
        if !(text_out.status.success() && json_out.status.success()) {
            eprintln!(
                "跳过：omp config list 退出码 {:?} / {:?}",
                text_out.status.code(),
                json_out.status.code()
            );
            return;
        }
        let c = parse_catalog(
            &String::from_utf8_lossy(&text_out.stdout),
            &String::from_utf8_lossy(&json_out.stdout),
        );
        assert!(c.sections.len() >= 8, "分组过少：{:?}", c.sections);
        assert!(c.items.len() > 400, "设置项过少：{}", c.items.len());
        assert!(
            c.items.iter().all(|i| !i.kind.is_empty()),
            "每一项都要有 schema 类型（JSON 那一路接上了吗）"
        );
        let enums: Vec<_> = c.items.iter().filter(|i| i.kind == "enum").collect();
        assert!(!enums.is_empty(), "一个枚举都没有：上游改格式了");
        assert!(
            enums.iter().all(|i| !i.options.is_empty()),
            "枚举必须有取值表：{:?}",
            enums.iter().filter(|i| i.options.is_empty()).map(|i| &i.key).collect::<Vec<_>>()
        );
        println!(
            "sections={:?} items={} enums={} redacted={} notSet={}",
            c.sections,
            c.items.len(),
            enums.len(),
            c.items.iter().filter(|i| i.redacted).count(),
            c.items.iter().filter(|i| !i.redacted && i.value.is_null()).count()
        );
    }
}
