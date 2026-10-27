//! 上下文分解（输入框工具行「上下文容量」面板的数据源）。
//!
//! 真值与估算的分界必须写清楚，免得把估算当读数用（omp 18.x 实测）：
//!
//! - **已用 / 窗口**：omp `get_state.contextUsage` = `{tokens, contextWindow, percent}`，
//!   `percent` 实测是 **0–100**（不是 0–1）。同一个 `tokens` 也落在会话 jsonl 的
//!   `message.contextSnapshot.promptTokens` 上，运行时读不到真值时用它兜底。
//! - **非消息总量**：`message.contextSnapshot.nonMessageTokens` = 系统提示词 + 工具 + 技能 +
//!   系统上下文，是 omp 用自己的 tokenizer 算出来的**真值**；它只落盘到会话 jsonl，
//!   RPC 事件流与 `get_state` **都不带**（实时 `message_end` 实测 `contextSnapshot` 为 null），
//!   所以只能按需读一次会话文件。
//! - **分项**：omp 只在 TUI 侧算（`/context` 斜杠命令 / 状态行），RPC 没有对应方法。
//!   这里按字符类估算（ASCII 字母数字 ≈ 4 字符 1 token、CJK ≈ 0.8 token/字），再把非消息
//!   各档**整体缩放到 `nonMessageTokens`**——于是「消息 = 已用 − 非消息」是真值，
//!   各档之和恒等于真值，只有档与档之间的切分是估算。界面必须写明这一点。
//! - **缓存命中率**：会话文件里逐轮 `usage` 的累计，口径与设置页「使用统计」一致
//!   （`cacheRead / (input + cacheRead)`，见 `usage.rs`）。
//!
//! 本模块只读：不写 omp 配置、不写覆盖层、不改会话文件（读一次文件是用户点开面板时的
//! 一次性动作，不是轮询——会话列表与历史回放之外，这是唯一读会话文件的地方）。

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::Path;
use tauri::State;

use crate::commands::{session_file_for, AppState, CmdError};
use crate::runtime::ModelRef;

// ---------- 视图类型 ----------

/// 分项 id（前端按 id 取文案，后端不给展示名——文案一律走字典）。
pub const PART_MESSAGES: &str = "messages";
pub const PART_SYSTEM_PROMPT: &str = "systemPrompt";
pub const PART_SKILLS: &str = "skills";
pub const PART_TOOLS: &str = "tools";
pub const PART_MCP_TOOLS: &str = "mcpTools";
pub const PART_SYSTEM_CONTEXT: &str = "systemContext";

/// 一档上下文占用（`id` 见上面的常量）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPart {
    pub id: &'static str,
    pub tokens: i64,
}

/// 会话累计缓存用量（逐轮 `usage` 求和；`hit_rate` 为 0–1 比例）。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextCache {
    pub input: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub hit_rate: Option<f64>,
}

/// 上下文分解面板的全部数据。
///
/// 不变量：`parts` 各档之和 = `usedTokens`（有锚点时），其中
/// `messages` = `usedTokens − nonMessageTokens` 与 `nonMessageTokens` 都是 omp 真值，
/// 其余五档是按字符量估算后缩放到 `nonMessageTokens` 的结果。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBreakdown {
    /// 已用 token（omp 真值）。
    pub used_tokens: Option<i64>,
    /// 模型上下文窗口（omp 真值）。
    pub context_window: Option<i64>,
    /// 占用百分比（0–100，与 omp 的 `contextUsage.percent` 同式同值）。
    pub percent: Option<f64>,
    /// 非消息部分合计（omp 真值 `contextSnapshot.nonMessageTokens`）。
    pub non_message_tokens: Option<i64>,
    /// 分项（估算，见模块头）；读不到锚点时为**空数组**（前端只画总量条）。
    pub parts: Vec<ContextPart>,
    pub cache: ContextCache,
}

// ---------- 字符量估算 ----------

/// 非消息各档的字符量估算权重（来自 `get_state`，**未缩放**，缩放发生在 `build`）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Weights {
    /// 系统提示词（`systemPrompt[0]` 去掉 `<skills>` 段）。
    pub system_prompt: f64,
    /// 技能清单（`systemPrompt[0]` 里的 `<skills>…</skills>` 段）。
    pub skills: f64,
    /// 系统上下文（`systemPrompt[1..]`：工作目录、仓库规则、git 状态等）。
    pub system_context: f64,
    /// 内置工具（`dumpTools` 里名字不带 `mcp__` 的）。
    pub tools: f64,
    /// MCP 工具（名字带 `mcp__<server>_<tool>` 前缀的，上游实测命名规则）。
    pub mcp_tools: f64,
}

impl Weights {
    /// 非消息各档之和（缩放的分子）。
    pub fn total(&self) -> f64 {
        self.system_prompt + self.skills + self.system_context + self.tools + self.mcp_tools
    }
}

/// 判断是否 CJK / 全角（这些字符在 BPE 里普遍接近 1 token 一字，不能按 4 字符折算）。
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3000..=0x30FF      // CJK 标点（、。「」…）与日文假名
        | 0x3400..=0x4DBF    // CJK 扩展 A
        | 0x4E00..=0x9FFF    // CJK 基本区
        | 0xF900..=0xFAFF    // 兼容表意
        | 0xFF00..=0xFFEF    // 全角字符
        | 0x20000..=0x2FA1F  // 扩展 B 及以后
    )
}

/// 字符类 token 估算：ASCII 字母数字每 4 字符 1 token、CJK 每字 0.8、其余每 4 字符 1。
///
/// 系数是拿真机 omp 的 `/context` 输出校准的（1M 窗口的默认工作区：系统提示词 /
/// 系统上下文 / 工具 / 技能四档真值对字符构成做最小二乘），单样本实测各档误差 ≤5%
/// ——够支撑「哪一档在吃上下文」的判断，但不值得当读数看，界面已按估算标注。
pub fn estimate_tokens(s: &str) -> f64 {
    let (mut ascii, mut cjk, mut other) = (0u32, 0u32, 0u32);
    for c in s.chars() {
        if is_cjk(c) {
            cjk += 1;
        } else if c.is_ascii_alphanumeric() {
            ascii += 1;
        } else {
            other += 1;
        }
    }
    ascii as f64 / 4.0 + cjk as f64 * 0.8 + other as f64 / 4.0
}

/// 把 `systemPrompt[0]` 拆成（技能段估算, 其余估算）。
/// 剥不出 `<skills>…</skills>` 时技能记 0，其余照常——标记漂移只会让技能档消失，不会算错别的档。
fn split_skills(p0: &str) -> (f64, f64) {
    let Some(start) = p0.find("<skills>") else {
        return (0.0, estimate_tokens(p0));
    };
    let Some(rel) = p0[start..].find("</skills>") else {
        return (0.0, estimate_tokens(p0));
    };
    let end = start + rel + "</skills>".len();
    let skills = estimate_tokens(&p0[start..end]);
    // 头尾两段分开估，省一次拼接分配（总和一致）
    (skills, estimate_tokens(&p0[..start]) + estimate_tokens(&p0[end..]))
}

/// 从 `get_state` 的 data 段提取非消息各档的字符权重。
///
/// 缺 `systemPrompt`（老 omp / 异常回包）返回 None——面板退回只显示总量，不硬凑分项。
pub fn weights_from_state(d: &serde_json::Value) -> Option<Weights> {
    let parts: Vec<&str> = d
        .get("systemPrompt")?
        .as_array()?
        .iter()
        .filter_map(|x| x.as_str())
        .collect();
    let first = parts.first()?;
    let (skills, system_prompt) = split_skills(first);
    let mut w = Weights {
        system_prompt,
        skills,
        system_context: estimate_tokens(&parts[1..].join("")),
        ..Default::default()
    };
    for t in d.get("dumpTools").and_then(|x| x.as_array()).into_iter().flatten() {
        let name = t.get("name").and_then(|x| x.as_str()).unwrap_or("");
        // 与 omp 送给模型的形状对齐：name + description + parameters（实测 dumpTools 只有这三个键）
        let mut buf = String::with_capacity(256);
        buf.push_str(name);
        buf.push_str(t.get("description").and_then(|x| x.as_str()).unwrap_or(""));
        if let Some(p) = t.get("parameters") {
            buf.push_str(&p.to_string());
        }
        let est = estimate_tokens(&buf);
        if name.starts_with("mcp__") {
            w.mcp_tools += est;
        } else {
            w.tools += est;
        }
    }
    Some(w)
}

// ---------- 会话文件事实 ----------

/// 单个会话文件的字节上限。超过就整块放弃（宁可面板少几行，也不读半个文件给出偏低的数字）。
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// 会话文件里读出来的事实（全部是 omp 真值）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FileFacts {
    /// 最后一条带 `contextSnapshot` 的 assistant 消息的非消息 token 数。
    pub non_message_tokens: Option<i64>,
    /// 同一处的 `promptTokens`（omp 的 usedTokens 落盘形态，运行时真值缺失时兜底）。
    pub prompt_tokens: Option<i64>,
    /// 文件里有没有 assistant 消息——区分「刚新建的会话」与「有历史但读不到锚点」。
    pub has_assistant: bool,
    pub cache: ContextCache,
}

/// 扫一个会话 jsonl，取最后一条 assistant 的 `contextSnapshot` 并累计逐轮 `usage`。
///
/// 只前置筛 `"assistant"` 子串再解析 JSON：绝大多数行（工具输出、custom 行）能整批跳过。
/// 文件不存在 / 读不动 / 超过字节上限一律返回 None（调用方按「什么都不知道」处理）。
pub fn scan_session_file(path: &Path) -> Option<FileFacts> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    let mut out = FileFacts::default();
    let mut input = 0i64;
    let mut cache_read = 0i64;
    let mut cache_write = 0i64;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        if !line.contains("\"assistant\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        let Some(m) = v.get("message") else { continue };
        if m.get("role").and_then(|r| r.as_str()) != Some("assistant") {
            continue;
        }
        out.has_assistant = true;
        if let Some(u) = m.get("usage").filter(|u| !u.is_null()) {
            input += u.get("input").and_then(|x| x.as_i64()).unwrap_or(0);
            cache_read += u.get("cacheRead").and_then(|x| x.as_i64()).unwrap_or(0);
            cache_write += u.get("cacheWrite").and_then(|x| x.as_i64()).unwrap_or(0);
        }
        if let Some(s) = m.get("contextSnapshot").filter(|s| !s.is_null()) {
            if let Some(n) = s.get("nonMessageTokens").and_then(|x| x.as_i64()) {
                out.non_message_tokens = Some(n);
            }
            if let Some(p) = s.get("promptTokens").and_then(|x| x.as_i64()) {
                out.prompt_tokens = Some(p);
            }
        }
    }
    let denom = input + cache_read;
    out.cache = ContextCache {
        input,
        cache_read,
        cache_write,
        hit_rate: (denom > 0).then(|| cache_read as f64 / denom as f64),
    };
    Some(out)
}

// ---------- 组装 ----------

fn push(parts: &mut Vec<ContextPart>, id: &'static str, tokens: f64) {
    if tokens > 0.0 {
        parts.push(ContextPart { id, tokens: tokens.round() as i64 });
    }
}

/// 组装面板数据。
///
/// `non_message` 是锚点（omp 真值）：为 None 时不出分项（`parts` 为空），只给总量与缓存。
/// 有锚点时先定「消息 = 已用 − 非消息」，再把非消息各档缩放后依次填入，
/// **最后一档用减法收尾**，保证各档之和精确等于总量（不因四舍五入漂移）。
pub fn build(
    weights: Option<&Weights>,
    used: Option<i64>,
    context_window: Option<i64>,
    non_message: Option<i64>,
    cache: ContextCache,
) -> ContextBreakdown {
    let percent = match (used, context_window) {
        (Some(u), Some(w)) if w > 0 => Some(u as f64 / w as f64 * 100.0),
        _ => None,
    };
    let mut parts = Vec::new();
    if let (Some(u), Some(anchor), Some(w)) = (used, non_message, weights) {
        // 锚点可能大于已用（系统提示词在最后一轮之后又长过），钳一下保住「各档之和 = 已用」
        let anchor = anchor.clamp(0, u.max(0));
        let raw = w.total();
        let scale = if raw > 0.0 { anchor as f64 / raw } else { 0.0 };
        push(&mut parts, PART_MESSAGES, (u - anchor).max(0) as f64);
        push(&mut parts, PART_SYSTEM_PROMPT, w.system_prompt * scale);
        push(&mut parts, PART_SKILLS, w.skills * scale);
        push(&mut parts, PART_TOOLS, w.tools * scale);
        push(&mut parts, PART_MCP_TOOLS, w.mcp_tools * scale);
        // 减法收尾：把四舍五入的误差全部落到最后一档，保证各档之和 = usedTokens
        let so_far: i64 = parts.iter().map(|p| p.tokens).sum();
        push(&mut parts, PART_SYSTEM_CONTEXT, (u - so_far).max(0) as f64);
    }
    ContextBreakdown {
        used_tokens: used,
        context_window,
        percent,
        non_message_tokens: non_message,
        parts,
        cache,
    }
}

// ---------- 命令 ----------

/// 从模型目录缓存里查当前模型的上下文窗口（运行时真值缺失时的兜底）。
async fn catalog_window(state: &State<'_, AppState>, model: Option<&ModelRef>) -> Option<i64> {
    let m = model?;
    let (_, catalog) = state.models_cache.lock().await.clone()?;
    catalog
        .get("models")?
        .as_array()?
        .iter()
        .find(|x| {
            x.get("provider").and_then(|p| p.as_str()) == Some(m.provider.as_str())
                && x.get("id").and_then(|p| p.as_str()) == Some(m.id.as_str())
        })
        .and_then(|x| x.get("contextWindow"))
        .and_then(|x| x.as_i64())
}

/// 上下文分解（输入框工具行的「上下文容量」面板）。
///
/// 数据来源是三处 omp 真值的拼装：运行时的 `get_state` 上下文占用与字符权重、
/// 会话文件里的 `contextSnapshot` 锚点与逐轮 `usage` 累计。**只读**——不启动进程、
/// 不下发命令；会话没运行 / 文件还没落盘时，能读到多少给多少。
#[tauri::command]
pub async fn get_context_breakdown(
    state: State<'_, AppState>,
    id: String,
) -> Result<ContextBreakdown, CmdError> {
    let (weights, live_usage, model) = {
        let map = state.runtime.lock().await;
        match map.get(&id) {
            Some(r) => (
                r.meta.ctx_weights.clone(),
                r.meta.context_usage.clone(),
                r.meta.model.clone(),
            ),
            None => (None, None, None),
        }
    };
    let agent = state.agent_dir.lock().await.clone();
    let facts = session_file_for(&agent, &id)
        .and_then(|p| scan_session_file(&p))
        .unwrap_or_default();

    let used = live_usage.as_ref().and_then(|c| c.tokens).or(facts.prompt_tokens);
    let window = live_usage
        .as_ref()
        .and_then(|c| c.context_window)
        .or(catalog_window(&state, model.as_ref()).await);
    // 锚点：文件里的真值优先；文件还没有 assistant 消息（新建会话）说明整段已用都是非消息，
    // 此时锚点 = 已用（消息 0）是**准确**的；有历史却读不到快照则宁可不给分项。
    let anchor = facts
        .non_message_tokens
        .or_else(|| (!facts.has_assistant).then_some(used).flatten());
    Ok(build(weights.as_ref(), used, window, anchor, facts.cache))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_json() -> serde_json::Value {
        serde_json::json!({
            "systemPrompt": [
                "§ Runtime\n<skills>\n- a: does a\n- b: does b\n</skills>\n\nRest of the prompt.",
                "<critical>\n- rule one\n</critical>"
            ],
            "dumpTools": [
                {"name": "read", "description": "Read a file", "parameters": {"type": "object"}},
                {"name": "bash", "description": "Run a command", "parameters": {"type": "object"}},
                {"name": "mcp__context7_query_docs", "description": "Query docs", "parameters": {"type": "object"}}
            ]
        })
    }

    #[test]
    fn estimate_counts_ascii_cjk_and_other_separately() {
        // 8 个 ASCII 字母数字 = 2 token；7 个 CJK / 全角（含表意空格与句号）= 5.6；1 个半角空格 = 0.25
        let n = estimate_tokens("abcd efgh\u{3000}中文测试，。");
        assert!((n - 7.85).abs() < 1e-9, "got {n}");
        assert_eq!(estimate_tokens(""), 0.0);
    }

    #[test]
    fn weights_split_skills_out_of_the_first_prompt_part() {
        let w = weights_from_state(&state_json()).expect("有权重");
        assert!(w.skills > 0.0, "skills 段应被单列");
        // 技能段被剥掉后系统提示词应明显小于整段
        assert!(w.system_prompt > 0.0 && w.system_prompt < w.system_context + w.system_prompt + w.skills);
        assert!(w.system_context > 0.0, "systemPrompt[1..] 应计入系统上下文");
    }

    #[test]
    fn weights_classify_mcp_tools_by_name_prefix() {
        let w = weights_from_state(&state_json()).expect("有权重");
        assert!(w.mcp_tools > 0.0, "mcp__ 前缀应归 MCP 工具");
        assert!(w.tools > 0.0 && w.tools > w.mcp_tools, "两个内置工具应大于一个 MCP 工具");
    }

    #[test]
    fn weights_absent_without_system_prompt() {
        assert!(weights_from_state(&serde_json::json!({"dumpTools": []})).is_none());
        assert!(weights_from_state(&serde_json::json!({"systemPrompt": []})).is_none());
    }

    #[test]
    fn parts_sum_exactly_to_used_tokens() {
        let w = weights_from_state(&state_json()).unwrap();
        let b = build(Some(&w), Some(100_000), Some(1_000_000), Some(28_500), ContextCache::default());
        let sum: i64 = b.parts.iter().map(|p| p.tokens).sum();
        assert_eq!(sum, 100_000, "各档之和必须精确等于已用 token");
        // 五档非消息 + 消息都必须出现（漏推一档会让残差全落到收尾档，是真出过的 bug）
        let ids: Vec<&str> = b.parts.iter().map(|p| p.id).collect();
        for id in [PART_MESSAGES, PART_SYSTEM_PROMPT, PART_SKILLS, PART_TOOLS, PART_MCP_TOOLS, PART_SYSTEM_CONTEXT] {
            assert!(ids.contains(&id), "缺少分项 {id}");
        }
        let msg = b.parts.iter().find(|p| p.id == PART_MESSAGES).unwrap();
        assert_eq!(msg.tokens, 100_000 - 28_500, "消息 = 已用 − 非消息（真值）");
        // 收尾档必须是最后一项（减法闭合点），否则残差会落到中间的档上
        assert_eq!(ids.last().copied(), Some(PART_SYSTEM_CONTEXT));
    }

    #[test]
    fn parts_are_empty_without_an_anchor() {
        let w = weights_from_state(&state_json()).unwrap();
        let b = build(Some(&w), Some(100_000), Some(1_000_000), None, ContextCache::default());
        assert!(b.parts.is_empty(), "读不到锚点时不硬凑分项");
        assert_eq!(b.used_tokens, Some(100_000));
    }

    #[test]
    fn percent_matches_omp_formula_and_survives_zero_window() {
        let b = build(None, Some(28_529), Some(1_000_000), None, ContextCache::default());
        assert!((b.percent.unwrap() - 2.8529).abs() < 1e-6, "percent 与 omp 同式（0–100）");
        let z = build(None, Some(10), Some(0), None, ContextCache::default());
        assert!(z.percent.is_none(), "窗口为 0 时不给百分比");
    }

    #[test]
    fn scan_reads_snapshot_and_sums_cache_usage() {
        let dir = std::env::temp_dir().join(format!("omp-ctx-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("s.jsonl");
        let lines = [
            r#"{"type":"session","id":"x","cwd":"/tmp"}"#,
            r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#,
            r#"{"type":"message","message":{"role":"assistant","usage":{"input":100,"output":5,"cacheRead":300,"cacheWrite":0},"contextSnapshot":{"promptTokens":400,"nonMessageTokens":26703,"compactionEpoch":0}}}"#,
            r#"{"type":"message","message":{"role":"assistant","stopReason":"aborted"}}"#,
            r#"{"type":"message","message":{"role":"assistant","usage":{"input":50,"output":5,"cacheRead":700,"cacheWrite":10},"contextSnapshot":{"promptTokens":760,"nonMessageTokens":26703,"compactionEpoch":0}}}"#,
        ];
        std::fs::write(&f, lines.join("\n")).unwrap();
        let facts = scan_session_file(&f).expect("文件可读");
        assert_eq!(facts.non_message_tokens, Some(26703));
        assert_eq!(facts.prompt_tokens, Some(760), "取最后一条带快照的消息");
        assert!(facts.has_assistant);
        assert_eq!((facts.cache.input, facts.cache.cache_read, facts.cache.cache_write), (150, 1000, 10));
        // 命中率 = cacheRead / (input + cacheRead) = 1000 / 1150
        assert!((facts.cache.hit_rate.unwrap() - 1000.0 / 1150.0).abs() < 1e-9);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_reports_fresh_session_and_missing_file() {
        let dir = std::env::temp_dir().join(format!("omp-ctx-fresh-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("s.jsonl");
        std::fs::write(&f, r#"{"type":"session","id":"x"}"#).unwrap();
        let facts = scan_session_file(&f).expect("文件可读");
        assert!(!facts.has_assistant && facts.non_message_tokens.is_none());
        assert!(facts.cache.hit_rate.is_none(), "没有 usage 时不给命中率");
        assert!(scan_session_file(&dir.join("nope.jsonl")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fresh_session_anchors_non_message_at_used() {
        // 新建会话：文件里还没有 assistant 消息 → 整段已用都是非消息，消息为 0
        let w = Weights { system_prompt: 100.0, tools: 20.0, ..Default::default() };
        let b = build(Some(&w), Some(120), Some(1_000_000), Some(120), ContextCache::default());
        assert!(b.parts.iter().all(|p| p.id != PART_MESSAGES), "0 值档不渲染");
        assert_eq!(b.parts.iter().map(|p| p.tokens).sum::<i64>(), 120);
    }
}
