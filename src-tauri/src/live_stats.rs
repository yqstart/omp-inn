//! 会话累计统计（输入卡底部统计条的数据源）：轮 / 步 / 用时 / 吞吐 / token 累计。
//!
//! 上游事实（omp 18.11 实测）：
//! - 真值只在会话 jsonl 的 `type == "message"` 行里：
//!   - `role == "user"`：一轮的起点（`attribution` 不区分——壳与 omp 注入的用户消息同样是「一轮」）；
//!   - `role == "assistant"`：一次模型步（工具循环里的每一步都会落一行），带
//!     `usage`（`input` 是**未缓存**输入，缓存读 / 写单独成项）、`duration`（本次调用墙钟毫秒）、
//!     `ttft`（首 token 毫秒）、`completedAt`（完成时刻毫秒）；
//!   - `role == "toolResult"`：一次工具结果（`toolCallId` / `toolName`）。
//! - **工具阶段耗时只能靠相邻消息的时间戳推**：jsonl 里没有工具自己的耗时字段。口径 =
//!   每个 `toolResult` 的 `timestamp` − 发起它的那次 assistant 的 `completedAt`，
//!   **逐个调用求和**（与上游 DeepSeek Harness 按 callId 配对求和同口径：并行工具各计一份）；
//!   用户消息到达即清掉起算点，跨轮的那段是用户思考时间，混进来会把工具用时算成整个会话的墙钟。
//! - **吞吐**：`TPS = 输出 token ÷ 解码墙钟`，解码墙钟 = Σ(`duration` − `ttft`)，且**只认
//!   「既有首 token 又有输出 token」的步**（上游 DH 同门槛）；没有可用的解码时间时不给读数
//!   （不拿 0 冒充）。TTFT 被单独减掉，所以状态条与浮层的 TPS 必然同值。
//! - **轮 / 步**：步 = assistant 消息条数（工具循环里的每次模型调用，失败 / 取消的步照算）；
//!   轮 = **真的出现过 assistant 步**的轮数（用户发了消息却没有任何步的空轮不计，
//!   与 DH 的 `turns` 口径一致——它数的是「有已关闭步的 turn」）。
//! - **缓存命中率** = `cacheRead ÷ (未缓存输入 + 缓存读 + 缓存写)`（分母含缓存写，与 DH 同式；
//!   设置页「使用统计」用的是 `cacheRead ÷ (input + cacheRead)`，两处口径不同、不互相改）。
//!
//! 只读：不写 omp 配置、不写覆盖层、不改会话文件。单文件扫描 + 按 mtime / size 的进程内缓存，
//! 统计条在运行中每几秒回读一次也不会反复啃盘。

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use tauri::State;

use crate::commands::{cmd_err, session_file_for, AppState, CmdError};
use crate::usage::parse_usage;

/// 单个会话文件的字节上限。超过就整块放弃（宁可整条统计不显示，也不读半个文件给出偏低的数字）。
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// 进程内缓存的会话条数上限（超出整表清空——统计条只看当前会话，几十条足够）。
const CACHE_MAX: usize = 64;

// ---------- 视图类型 ----------

/// 会话累计 token（逐轮 `usage` 求和；`total` 用 omp 的 `totalTokens`，缺失时按四段之和兜底）。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTokens {
    /// 未缓存输入。
    pub input: i64,
    pub output: i64,
    pub reasoning: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub total: i64,
    /// 带 usage 的 assistant 消息条数（= 参与累计的请求数）。
    pub calls: i64,
}

/// 会话累计统计条的全部读数（派生指标一律在后端算好，前端只做格式化）。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLiveStats {
    /// 轮 = 用户消息条数。
    pub turns: i64,
    /// 步 = assistant 消息条数（工具循环里的每一次模型调用）。
    pub steps: i64,
    /// 工具调用条数（toolResult 条数）。
    pub tool_calls: i64,
    /// 模型用时（Σ`duration`，毫秒）。
    pub model_ms: f64,
    /// 工具调用用时（同轮内相邻 assistant 的阶段差，毫秒；见模块头口径）。
    pub tool_ms: f64,
    /// 首 token 平均（Σ`ttft` ÷ 有 ttft 的步数，毫秒）；无样本为 None。
    pub ttft_ms: Option<f64>,
    /// 生成（解码）耗时 = `model_ms` − Σ`ttft`，毫秒；钳到非负。
    pub decode_ms: f64,
    /// 输出速度（输出 token ÷ 生成耗时）；生成耗时不可用时为 None。
    pub tps: Option<f64>,
    pub tokens: LiveTokens,
    /// 缓存命中率 = `cacheRead / (input + cacheRead)`（0–1）；分母为 0 时为 None。
    pub cache_hit_rate: Option<f64>,
    /// 累计成本（Σ`usage.cost.total`）。
    pub cost: f64,
    /// 会话里第一条消息 / 最后一条消息的时刻（毫秒；读不到为 None）。
    pub started_at: Option<i64>,
    pub last_at: Option<i64>,
    /// 读不全（文件超过字节上限）：整条统计按空处理，界面据此不显示读数。
    pub truncated: bool,
}

// ---------- 扫描 ----------

fn i64_of(v: Option<&serde_json::Value>) -> i64 {
    v.and_then(|x| x.as_i64()).unwrap_or(0)
}

fn f64_of(v: Option<&serde_json::Value>) -> f64 {
    v.and_then(|x| x.as_f64()).unwrap_or(0.0)
}

/// 扫一个会话 jsonl 聚合累计统计。
///
/// 行级预筛（先看原始行里有没有 `"message"` 再解析 JSON）让几十 MB 的长会话也能百毫秒级扫完；
/// 文件不存在 / 读不动返回 None，超过字节上限返回 `truncated`（调用方按「什么都不知道」处理）。
pub fn scan_session_stats(path: &Path) -> Option<SessionLiveStats> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_BYTES {
        return Some(SessionLiveStats { truncated: true, ..Default::default() });
    }
    let file = std::fs::File::open(path).ok()?;
    let mut out = SessionLiveStats::default();
    let mut ttft_sum = 0.0f64;
    let mut ttft_n = 0i64;
    let mut decode_tokens = 0i64;
    // 上一条 assistant 的完成时刻（工具用时的起算点）；遇到用户消息即作废（跨轮不算）。
    let mut last_assistant_end: Option<i64> = None;
    // 本轮有没有出现过 assistant 步——「轮」只数真有步的轮（与 DH 的 turn 口径一致）。
    let mut pending_turn = false;

    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        if !line.contains("\"message\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        let Some(m) = v.get("message").filter(|m| !m.is_null()) else { continue };
        let ts = m.get("timestamp").and_then(|x| x.as_i64());
        if let Some(ts) = ts {
            out.started_at.get_or_insert(ts);
            out.last_at = Some(ts);
        }
        match m.get("role").and_then(|r| r.as_str()) {
            Some("user") => {
                pending_turn = true;
                last_assistant_end = None;
            }
            Some("toolResult") => {
                out.tool_calls += 1;
                // 工具用时：结果落盘时刻 − 发起它的那次 assistant 完成时刻（逐个调用求和，
                // 与上游「按 callId 逐个配对求和」同口径——并行工具会各自计一份，不合并成墙钟）。
                if let (Some(end), Some(at)) = (last_assistant_end, ts) {
                    let d = at - end;
                    if d > 0 {
                        out.tool_ms += d as f64;
                    }
                }
            }
            Some("assistant") => {
                out.steps += 1;
                if pending_turn {
                    out.turns += 1;
                    pending_turn = false;
                }
                let dur = f64_of(m.get("duration"));
                out.model_ms += dur;
                let output = i64_of(m.get("usage").and_then(|u| u.get("output")));
                if let Some(raw) = m.get("usage").filter(|u| !u.is_null()) {
                    let u = parse_usage(raw);
                    out.tokens.input += u.input as i64;
                    out.tokens.output += u.output as i64;
                    out.tokens.cache_read += u.cache_read as i64;
                    out.tokens.cache_write += u.cache_write as i64;
                    out.tokens.total += u.total as i64;
                    out.tokens.reasoning += i64_of(raw.get("reasoningTokens"));
                    out.tokens.calls += 1;
                }
                out.cost += m
                    .get("usage")
                    .and_then(|u| u.get("cost"))
                    .and_then(|c| c.get("total"))
                    .and_then(|x| x.as_f64())
                    .unwrap_or(0.0);
                // 吞吐只认「既有首 token 又有输出」的步（与 DH 同门槛）：解码时间 = 本次调用
                // 墙钟 − 首 token 等待，输出 token 取该步的 output。
                if let Some(ttft) = m.get("ttft").and_then(|x| x.as_f64()) {
                    ttft_sum += ttft;
                    ttft_n += 1;
                    let decode = dur - ttft;
                    if decode > 0.0 && output > 0 {
                        out.decode_ms += decode;
                        decode_tokens += output;
                    }
                }
                // 完成时刻优先用 completedAt（实测与 duration 自洽），缺失才退回 timestamp + duration
                last_assistant_end = m
                    .get("completedAt")
                    .and_then(|x| x.as_i64())
                    .or_else(|| ts.map(|t| t + dur as i64));
            }
            _ => {}
        }
    }

    // 命中率分母 = 三桶计费输入之和（含缓存写，与上游 DH 同式；
    // 设置页「使用统计」用的是 cacheRead/(input+cacheRead)，两处口径不同，见模块头）。
    let denom = out.tokens.input + out.tokens.cache_read + out.tokens.cache_write;
    out.cache_hit_rate = (denom > 0).then(|| out.tokens.cache_read as f64 / denom as f64);
    out.ttft_ms = (ttft_n > 0).then(|| ttft_sum / ttft_n as f64);
    // 生成耗时读不出来时不给吞吐——0 不是读数
    out.tps = (out.decode_ms > 0.0).then(|| decode_tokens as f64 / (out.decode_ms / 1000.0));
    Some(out)
}

// ---------- 缓存 ----------

struct CacheEntry {
    mtime: i64,
    size: u64,
    stats: SessionLiveStats,
}

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------- 命令 ----------

/// 会话累计统计（输入卡底部统计条）：轮 / 步 / 模型用时 / 工具用时 / TTFT / 吞吐 / token 累计。
///
/// **只读**——不启动进程、不下发命令，只读会话文件；同一份文件（mtime + size 未变）直接回缓存，
/// 运行中每几秒回读一次也不会反复扫盘。会话文件读不到（已删 / 还没落盘）返回
/// `NO_SESSION_FILE`，前端按「没有读数」处理，不弹错。
#[tauri::command]
pub async fn get_session_live_stats(
    state: State<'_, AppState>,
    id: String,
) -> Result<SessionLiveStats, CmdError> {
    let agent = state.agent_dir.lock().await.clone();
    let Some(path) = session_file_for(&agent, &id) else {
        return Err(cmd_err("NO_SESSION_FILE", format!("找不到会话文件：{id}"), None));
    };
    let meta = std::fs::metadata(&path)
        .map_err(|e| cmd_err("NO_SESSION_FILE", format!("会话文件读不到：{e}"), None))?;
    let (mtime, size) = (mtime_ms(&meta), meta.len());

    if let Ok(c) = cache().lock() {
        if let Some(e) = c.get(&id) {
            if e.mtime == mtime && e.size == size {
                return Ok(e.stats.clone());
            }
        }
    }
    let Some(stats) = scan_session_stats(&path) else {
        return Err(cmd_err("NO_SESSION_FILE", "会话文件读不动".into(), None));
    };
    if let Ok(mut c) = cache().lock() {
        if c.len() >= CACHE_MAX {
            c.clear();
        }
        c.insert(id, CacheEntry { mtime, size, stats: stats.clone() });
    }
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例一个独立文件（用例并行跑，同名文件会互相覆盖）。
    fn write(name: &str, lines: &[&str]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("omp-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join(format!("{name}.jsonl"));
        std::fs::write(&f, lines.join("\n")).unwrap();
        f
    }

    #[test]
    fn counts_turns_steps_tools_and_sums_usage() {
        let f = write("counts", &[
            r#"{"type":"session","id":"x","cwd":"/tmp"}"#,
            r#"{"type":"message","message":{"role":"user","timestamp":1000}}"#,
            r#"{"type":"message","message":{"role":"assistant","timestamp":1100,"completedAt":2100,"duration":1000,"ttft":200,"usage":{"input":100,"output":50,"cacheRead":300,"cacheWrite":10,"totalTokens":460,"cost":{"total":0.5}}}}"#,
            r#"{"type":"message","message":{"role":"toolResult","timestamp":2600,"toolName":"bash"}}"#,
            r#"{"type":"message","message":{"role":"assistant","timestamp":3000,"completedAt":5000,"duration":2000,"ttft":400,"usage":{"input":10,"output":150,"cacheRead":900,"cacheWrite":0,"totalTokens":1060,"cost":{"total":0.25}}}}"#,
            r#"{"type":"message","message":{"role":"user","timestamp":9000}}"#,
            r#"{"type":"message","message":{"role":"assistant","timestamp":9100,"completedAt":10100,"duration":1000,"ttft":100,"usage":{"input":1,"output":10,"cacheRead":9,"cacheWrite":0,"totalTokens":20,"cost":{"total":0.1}}}}"#,
        ]);
        let s = scan_session_stats(&f).expect("文件可读");
        assert_eq!((s.turns, s.steps, s.tool_calls), (2, 3, 1));
        assert_eq!(s.model_ms, 4000.0);
        // 工具用时 = 2600 − 2100（发起它的那次 assistant 完成时刻）；跨轮那段（9000 − 5000）是用户思考时间，不算
        assert_eq!(s.tool_ms, 500.0, "只算紧跟上一次 assistant 的工具结果");
        assert_eq!(s.ttft_ms, Some((200.0 + 400.0 + 100.0) / 3.0));
        // 解码墙钟 = (1000−200) + (2000−400) + (1000−100) = 3300，对应输出 50+150+10 = 210
        assert_eq!(s.decode_ms, 3300.0);
        assert!((s.tps.unwrap() - 210.0 / 3.3).abs() < 1e-9);
        assert_eq!(s.tokens.total, 1540);
        assert_eq!(s.tokens.calls, 3);
        assert_eq!(s.tokens.reasoning, 0);
        // 命中率 = 1209 / (111 + 1209 + 10)（分母含缓存写）
        assert!((s.cache_hit_rate.unwrap() - 1209.0 / 1330.0).abs() < 1e-9);
        assert!((s.cost - 0.85).abs() < 1e-9);
        assert_eq!((s.started_at, s.last_at), (Some(1000), Some(9100)));
        assert!(!s.truncated);
    }

    #[test]
    fn turns_count_only_rounds_with_a_step() {
        // 用户发了消息但没有任何 assistant 步（立即中断 / 空轮）：不算一轮（与 DH 的 turns 口径一致）
        let f = write("turns", &[
            r#"{"type":"message","message":{"role":"user","timestamp":1000}}"#,
            r#"{"type":"message","message":{"role":"user","timestamp":2000}}"#,
            r#"{"type":"message","message":{"role":"assistant","timestamp":2100,"completedAt":2200,"duration":100,"ttft":10,"usage":{"input":1,"output":5,"totalTokens":6}}}"#,
        ]);
        let s = scan_session_stats(&f).unwrap();
        assert_eq!((s.turns, s.steps), (1, 1), "只有出现过步的那一轮才算数");
    }

    #[test]
    fn parallel_tool_results_each_count_their_own_time() {
        // 一次 assistant 发起两个工具：两个 toolResult 各自从同一完成时刻起算（与上游按 callId 求和同口径）
        let f = write("parallel", &[
            r#"{"type":"message","message":{"role":"user","timestamp":0}}"#,
            r#"{"type":"message","message":{"role":"assistant","timestamp":100,"completedAt":200,"duration":100,"ttft":10,"usage":{"input":1,"output":5,"totalTokens":6}}}"#,
            r#"{"type":"message","message":{"role":"toolResult","timestamp":700,"toolName":"a"}}"#,
            r#"{"type":"message","message":{"role":"toolResult","timestamp":900,"toolName":"b"}}"#,
        ]);
        let s = scan_session_stats(&f).unwrap();
        assert_eq!(s.tool_calls, 2);
        assert_eq!(s.tool_ms, 500.0 + 700.0);
    }

    #[test]
    fn empty_session_has_no_readings() {
        let f = write("empty", &[r#"{"type":"session","id":"x","cwd":"/tmp"}"#]);
        let s = scan_session_stats(&f).expect("文件可读");
        assert_eq!((s.turns, s.steps, s.tool_calls), (0, 0, 0));
        assert!(s.tps.is_none(), "没有生成耗时就不给吞吐（0 不是读数）");
        assert!(s.ttft_ms.is_none());
        assert!(s.cache_hit_rate.is_none());
        assert!(s.started_at.is_none());
        assert!(scan_session_stats(&f.with_file_name("nope.jsonl")).is_none());
    }

    #[test]
    fn tps_absent_without_decode_time() {
        // 只有 ttft、没有 duration：解码时间算不出来，宁可不给吞吐
        let f = write("tps", &[
            r#"{"type":"message","message":{"role":"assistant","timestamp":1000,"ttft":300,"usage":{"input":5,"output":40,"totalTokens":45}}}"#,
        ]);
        let s = scan_session_stats(&f).unwrap();
        assert!(s.tps.is_none());
        assert_eq!(s.ttft_ms, Some(300.0));
    }

    #[test]
    fn reasoning_tokens_and_missing_total_fallback() {
        let f = write("reasoning", &[
            r#"{"type":"message","message":{"role":"assistant","timestamp":1,"completedAt":2,"duration":100,"ttft":10,"usage":{"input":10,"output":20,"cacheRead":30,"cacheWrite":40,"reasoningTokens":7}}}"#,
        ]);
        let s = scan_session_stats(&f).unwrap();
        assert_eq!(s.tokens.reasoning, 7);
        assert_eq!(s.tokens.total, 100, "没有 totalTokens 时按四段之和兜底");
    }

    /// 真实会话文件冒烟（人工核对读数用，默认跳过）：
    /// `OMP_BENCH=1 cargo test --manifest-path src-tauri/Cargo.toml --lib real_session -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_session_scan_for_bench() {
        if std::env::var("OMP_BENCH").ok().as_deref() != Some("1") {
            return;
        }
        let agent = crate::session_scan::resolve_agent_dir(None);
        let sessions = agent.join("sessions");
        let mut best: Option<(u64, std::path::PathBuf)> = None;
        let Ok(dirs) = std::fs::read_dir(&sessions) else {
            println!("没有 sessions 目录：{}", sessions.display());
            return;
        };
        for d in dirs.flatten() {
            let Ok(files) = std::fs::read_dir(d.path()) else { continue };
            for f in files.flatten() {
                let p = f.path();
                if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let size = f.metadata().map(|m| m.len()).unwrap_or(0);
                if best.as_ref().map(|(s, _)| size > *s).unwrap_or(true) {
                    best = Some((size, p));
                }
            }
        }
        let Some((size, path)) = best else {
            println!("sessions 目录里没有 jsonl");
            return;
        };
        let started = std::time::Instant::now();
        let s = scan_session_stats(&path).expect("文件可读");
        println!(
            "{}（{:.1}MB，耗时 {}ms）：{} 轮 {} 步 · {} 次工具调用 · 模型用时 {:.1}s / 工具用时 {:.1}s · TTFT 平均 {:?}ms · 解码 {:.1}s · TPS {:?}",
            path.file_name().and_then(|n| n.to_str()).unwrap_or("?"),
            size as f64 / 1e6,
            started.elapsed().as_millis(),
            s.turns,
            s.steps,
            s.tool_calls,
            s.model_ms / 1000.0,
            s.tool_ms / 1000.0,
            s.ttft_ms.map(|v| v.round()),
            s.decode_ms / 1000.0,
            s.tps.map(|v| v.round()),
        );
        println!(
            "tokens：未缓存输入 {} / 缓存读 {} / 缓存写 {} / 输出 {} / 推理 {} / 合计 {}（{} 次请求）· 命中率 {:?} · 成本 ${:.4}",
            s.tokens.input,
            s.tokens.cache_read,
            s.tokens.cache_write,
            s.tokens.output,
            s.tokens.reasoning,
            s.tokens.total,
            s.tokens.calls,
            s.cache_hit_rate,
            s.cost,
        );
        // 不变量：轮不会多于步；有解码时间就有吞吐
        assert!(s.turns <= s.steps.max(1), "轮数不该超过步数");
        assert!(s.decode_ms >= 0.0);
        assert_eq!(s.tps.is_some(), s.decode_ms > 0.0);
    }
}
