//! 使用统计（Usage）：把 omp 本地会话记录里的 token 用量聚合成设置页的三项指标
//! （tokens 用量 / Cache 命中率 / 活跃天数）。
//!
//! 上游事实（omp 18.x 实测）：
//! - 用量真值只在 jsonl 的 **assistant 消息**里：`message.usage` =
//!   `{input, output, cacheRead, cacheWrite, totalTokens, …}`，且实测逐条满足
//!   `totalTokens = input + output + cacheRead + cacheWrite`
//!   （`input` 是**未缓存**输入，缓存读 / 写单独成项）。
//! - `message.timestamp` 是**毫秒数字**（不是 ISO 串）。
//!
//! 扫描是**全量**的：每条 assistant 消息都可能落进任意一项统计（活跃日与热力图还会跨出所选范围），
//! 所以不能像列表那样只看文件头尾。
//! 保护手段与 `search_sessions` 同款——文件数 / 字节 / 墙钟三道预算，任何一道到点即停并把
//! `truncated` 置 true（**宁可说「可能不全」，不假装统计完了**）。行级预筛（先看原始行里有没有
//! `"usage"` 再解析 JSON）让真实目录（29MB）的整轮扫描保持在百毫秒级。
//!
//! 纯逻辑（行解析、按日聚合、范围过滤、连续天数、热力图窗口）与真实文件行为（扫描临时目录、
//! 预算截断、缺失目录）都有单测。
//!
//! 每日热力图（GitHub 贡献图口径）**独立于范围窗口**：它固定看最近 [`HEAT_WEEKS`] 周并按周日对齐，
//! 所以「今日」范围也能看到一整年日历——界面上的「每日 / 每周 / 累计」三档只是对同一份逐日数据
//! 换取值，不是三次扫描。**活跃天数与连续天数同样看全量历史、不随 `days` 裁剪**（「活跃」是使用
//! 习惯的刻画，不该因为上方切到「今日」就退回 1 天）；只有 tokens 总量与命中率按所选范围聚合。
//!
//! # 壳侧账本（已删除会话的用量不丢）
//!
//! 只扫 jsonl 的统计有个硬伤：**del 掉会话，它那部分用量就从统计里消失了**。所以壳侧另记一份
//! 账本（[`UsageLedger::record`]）：每个会话进程的每条 assistant `message_end` 一落，就把它那一轮
//! 的 usage 追加进 `app_data_dir/omp-inn/usage-ledger.jsonl`（**只追加、不修改**，键已记过就跳过，
//! 所以重放 / 重启都不会写第二遍）。
//!
//! 统计 = jsonl 扫描 **∪** 账本，两路都进同一个累加器，按**全局唯一键**（[`usage_key`]：
//! `responseId` 优先，缺失时退回 `sid|时间戳|四段用量`）去重——实测同一轮在实时帧与 jsonl 里的
//! `responseId` / `message.timestamp` / `usage` 完全一致（探针：`rid=e4445cd1… ts=1792128700867
//! total=4260` 两边同值），所以已落盘的会话不会因为账本而翻倍。**同一条消息两边都有时以先扫到的
//! 为准**（jsonl 先扫）；账本读取本身也有预算（[`LEDGER_MAX_EVENTS`] / [`LEDGER_MAX_MS`]）——
//! 到点即停并把 `truncated` 置 true，不假装统计完了。
//!
//! 账本只覆盖「本应用跑出来的会话」：omp CLI / 终端里的用量仍由 jsonl 覆盖，两者合起来才完整。
//! 失败 / 重试的调用（`responseId` 缺失且 `totalTokens = 0`）不记账——省下无意义的行与假活跃日
//! （真机验过：模型不可用时整轮 `assistant` 消息都是 `stopReason=error` + usage 全 0 + 无
//! `responseId`，账本一个字都不该写）。

use chrono::{DateTime, Datelike, Days, Local, NaiveDate};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;

use crate::commands::{AppState, CmdError};

/// 扫描文件数上限（按 mtime 取最近的一批，旧的先放弃）。
const SCAN_MAX_FILES: usize = 3000;
/// 读取字节上限。真实 sessions 目录 ~29MB，留足余量；到点即停并置 `truncated`。
const SCAN_MAX_BYTES: u64 = 256 * 1024 * 1024;
/// 墙钟时间上限（毫秒）。
const SCAN_MAX_MS: u64 = 5000;
/// 热力图窗口周数（GitHub 贡献图同款 53 列，最后一列 = 本周）。
const HEAT_WEEKS: u64 = 53;
/// 账本读取条数上限（新记录优先保留；到点即停并置 `truncated`）。
const LEDGER_MAX_EVENTS: usize = 200_000;
/// 账本读取墙钟上限（毫秒）。
const LEDGER_MAX_MS: u64 = 3000;
/// 进程内去重键保留条数（防止超长运行无界增长；最近的记录优先保留）。
const LEDGER_SEEN_CAP: usize = 50_000;

// ---------- 视图类型 ----------

/// 一组用量数字（范围总览）。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucket {
    /// 未缓存输入 token。
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// omp 的 `totalTokens` 累加（= input + output + cacheRead + cacheWrite）。
    pub total: u64,
    /// 请求数（带 usage 的 assistant 消息条数）。
    pub calls: u64,
}

impl UsageBucket {
    fn add(&mut self, u: &MsgUsage) {
        self.input += u.input;
        self.output += u.output;
        self.cache_read += u.cache_read;
        self.cache_write += u.cache_write;
        self.total += u.total;
        self.calls += 1;
    }
}

/// 范围总览。派生指标（命中率 / 活跃天数 / 连续天数）一律在**后端**算好——
/// 前端只做格式化，不自算统计（与 `omp-state` 同一条口径）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    #[serde(flatten)]
    pub bucket: UsageBucket,
    /// 有请求的天数（**全量历史**，与热力图同口径，不随所选范围裁剪）。
    pub active_days: u64,
    /// 连续活跃天数（今天还没跑但昨天跑了不断签，GitHub 口径；全量历史）。
    pub current_streak: u64,
    /// 最长连续活跃天数（全量历史）。
    pub longest_streak: u64,
    /// 缓存命中率 = cacheRead / (input + cacheRead)；分母为 0 时 null。
    pub cache_hit_rate: Option<f64>,
}

/// 热力图格子里的一个模型用量（token 降序，界面按此列读数）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageHeatModel {
    /// `model` 原样来自 jsonl；空串表示上游没给（界面显示「未知模型」）。
    pub model: String,
    pub total: u64,
}

/// 热力图的一格（`date` = 本地日期；没跑的日子补零，日历才成网格）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageHeatRow {
    pub date: String,
    /// 当日 token 合计（= `models` 各行的和）。
    pub total: u64,
    /// 当日按模型拆分（token 降序；没有用量的日子为空）。
    pub models: Vec<UsageHeatModel>,
}

/// 使用统计整体回包（`truncated` = 因扫描预算提前收手，统计可能不全）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    pub totals: UsageTotals,
    /// 热力图：最近 53 周（周日对齐、逐日补零、到今天为止），**不随 `days` 裁剪**。
    pub heat: Vec<UsageHeatRow>,
    /// 实际扫描的会话文件数。
    pub scanned_files: usize,
    /// 只由壳侧账本补上、jsonl 里已经没有的条数（= 已删除会话的用量）——界面明说数据来源。
    pub extras: u64,
    pub truncated: bool,
}

// ---------- 行解析（纯函数，可测） ----------

/// 一条 assistant 消息里的用量（omp `message.usage` 原值；缺失字段按 0）。
/// 也是**账本行的线格式**（`usage` 字段），所以序列化 / 反序列化都要有。
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MsgUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total: u64,
}

/// 一行 jsonl 里我们关心的东西。
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedMsg {
    /// `message.timestamp`（毫秒数字）。
    pub ts_ms: i64,
    /// `message.model` 原样（热力图按模型拆分读数用；缺失为空串）。
    pub model: String,
    /// `message.responseId`（成功调用的上游响应 id；缺失为空串）。
    /// 它是**去重主键**：实时帧与 jsonl 里同一个值（见模块头），账本与扫描靠它配对。
    pub response_id: String,
    /// 没有 usage 的 assistant 行（如纯工具结果回复）为 None——它不进统计。
    pub usage: Option<MsgUsage>,
}

fn u64_of(v: Option<&serde_json::Value>) -> u64 {
    v.and_then(|x| x.as_u64()).unwrap_or(0)
}

/// 一条消息的**全局去重键**（`sid` = 会话完整 uuid）：有 `responseId` 就用它（全局唯一），
/// 缺失（失败 / 重试的调用）退回 `sid|时间戳|四段用量`——jsonl 解析与账本记录**共用这一处**，
/// 口径必须完全一致，否则同一轮会被算两次（或两边互相看不见）。
fn usage_key(sid: &str, response_id: &str, ts_ms: i64, u: &MsgUsage) -> String {
    if !response_id.is_empty() {
        return format!("{sid}|{response_id}");
    }
    format!(
        "{sid}|{ts_ms}|{}|{}|{}|{}|{}",
        u.total, u.input, u.output, u.cache_read, u.cache_write
    )
}

/// 从 `message.usage` 取用量；**没有 `totalTokens` 的老数据**按四段之和兜底
/// （口径与 omp 的 `totalTokens = input + output + cacheRead + cacheWrite` 一致）。
pub fn parse_usage(v: &serde_json::Value) -> MsgUsage {
    let input = u64_of(v.get("input"));
    let output = u64_of(v.get("output"));
    let cache_read = u64_of(v.get("cacheRead"));
    let cache_write = u64_of(v.get("cacheWrite"));
    let total = match v.get("totalTokens").and_then(|x| x.as_u64()) {
        Some(t) if t > 0 => t,
        _ => input + output + cache_read + cache_write,
    };
    MsgUsage { input, output, cache_read, cache_write, total }
}

/// 解析一行 jsonl：只认 `type == "message"` 的 assistant 行。
/// 时间取 `message.timestamp`（毫秒数字），缺失时退回顶层 `timestamp`（ISO 串）；
/// 两者都读不到的行返回 None（无法按日归档，宁缺勿错算到今天头上）。
pub fn parse_message_line(line: &str) -> Option<ParsedMsg> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("message") {
        return None;
    }
    let m = v.get("message")?;
    if m.get("role").and_then(|r| r.as_str()) != Some("assistant") {
        return None;
    }
    let ts_ms = m
        .get("timestamp")
        .and_then(|t| t.as_i64())
        .or_else(|| {
            v.get("timestamp")
                .and_then(|t| t.as_str())
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.timestamp_millis())
        })?;
    Some(ParsedMsg {
        ts_ms,
        model: m.get("model").and_then(|p| p.as_str()).unwrap_or("").to_string(),
        response_id: m.get("responseId").and_then(|r| r.as_str()).unwrap_or("").to_string(),
        usage: m.get("usage").map(parse_usage),
    })
}

/// 本地日期——按用户所在时区归档，与界面上的「今天」一致。
fn local_date(ms: i64) -> Option<NaiveDate> {
    let dt = DateTime::from_timestamp_millis(ms)?;
    Some(dt.with_timezone(&Local).date_naive())
}

// ---------- 扫描 ----------

/// 扫描预算（单测用来把预算压到极小以验证截断）。
#[derive(Debug, Clone, Copy)]
struct Budget {
    max_files: usize,
    max_bytes: u64,
    max_ms: u64,
}

impl Default for Budget {
    fn default() -> Self {
        Budget { max_files: SCAN_MAX_FILES, max_bytes: SCAN_MAX_BYTES, max_ms: SCAN_MAX_MS }
    }
}

/// 扫 `sessions/` 下全部 jsonl（**不含**账本），按 `days`（None = 全部）过滤后聚合。
/// 不碰 tauri，可在临时目录上做真实行为测试——单测用它当「账本没补上时会少什么」的对照。
#[cfg(test)]
pub fn scan_usage_in(root: &Path, days: Option<u32>, now: DateTime<Local>) -> UsageStats {
    scan_usage_full(root, days, now, None)
}

/// 全量统计：jsonl 扫描 **∪** 壳侧账本（`ledger` = 账本路径，None = 只扫 jsonl）。
/// 两路都进同一个累加器并按 [`usage_key`] 去重，所以已落盘的会话不会因为账本而翻倍
/// （见模块头「壳侧账本」）。
pub fn scan_usage_full(
    root: &Path,
    days: Option<u32>,
    now: DateTime<Local>,
    ledger: Option<&Path>,
) -> UsageStats {
    scan_with(root, days, now, ledger, Budget::default())
}

/// 扫描数据源：jsonl 行与账本行进的是同一个累加器，只有「补记条数」的记账不同。
#[derive(Debug, Clone, Copy, PartialEq)]
enum Origin {
    Jsonl,
    Ledger,
}

/// 一条用量事件（jsonl 与账本归一后的同一形状）——两路共用的输入，也是**账本行的线格式**。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageEvent {
    /// 会话完整 uuid（jsonl：文件名；账本：spawn 返回的真实 id）。
    sid: String,
    /// `message.timestamp`（毫秒数字）。
    ts_ms: i64,
    /// `message.model` 原样（热力图按模型拆读数用；缺失为空串）。
    model: String,
    /// `message.responseId`（缺失为空串，见 [`usage_key`] 的兜底口径）。
    response_id: String,
    usage: MsgUsage,
}

/// 聚合累加器：范围窗口 / 活跃日 / 热力图 / 去重集合都在这里，两个数据源共用。
struct Accumulator {
    today: NaiveDate,
    cutoff: Option<NaiveDate>,
    heat_from: NaiveDate,
    totals: UsageTotals,
    /// 活跃日集合：与热力图一样在范围裁剪**之前**收集（全量历史），活跃天数 / 连续天数都从它派生
    active: BTreeSet<NaiveDate>,
    /// 热力图按「日期 → 模型 → token」存：格子的读数要按模型拆开（三项指标不用它）
    by_heat: BTreeMap<String, BTreeMap<String, u64>>,
    /// 已计入的全局去重键（jsonl 与账本共享，见 [`usage_key`]）
    seen: HashSet<String>,
    /// 只由账本补上（jsonl 里没有）的条数
    extras: u64,
    /// jsonl 扫描期**见过文件**的会话 id（判「这条账本记录的会话文件还在不在」/ 测试用）
    scanned: HashSet<String>,
}

impl Accumulator {
    fn new(today: NaiveDate, days: Option<u32>) -> Self {
        // 范围下界：今日 = 今天当天；近 N 日在内的是最近 N 个自然日（含今天）。
        // 只裁剪 tokens 总量与命中率——活跃天数 / 连续天数看全量历史（见模块头）。
        let cutoff = days.map(|d| today - Days::new(d.saturating_sub(1) as u64));
        Self {
            today,
            cutoff,
            heat_from: heat_window_start(today),
            totals: UsageTotals::default(),
            active: BTreeSet::new(),
            by_heat: BTreeMap::new(),
            seen: HashSet::new(),
            extras: 0,
            scanned: HashSet::new(),
        }
    }

    /// 计入一条事件；返回它是否是**新的**（已见过的重复条目返回 false，直接丢弃）。
    ///
    /// **两路的合并口径就在这一处**：jsonl 先扫、先把键占住；账本随后扫，凡 jsonl 里已经有的一律
    /// 在这里被去重丢掉（同一条消息在实时帧与 jsonl 里的 `responseId` / 时间戳 / 用量完全一致，
    /// 见模块头），**剩下的就是 jsonl 里已经没有的**——已删除会话的用量、或 jsonl 被截断丢掉的那
    /// 部分，都算补记（[`UsageStats::extras`]）。两条路都不看对方的状态，只认这一个全局键。
    fn add(&mut self, ev: &UsageEvent, origin: Origin) -> bool {
        // 没有时间就无法归档到某一天（宁缺勿错算到今天头上）
        let Some(date) = local_date(ev.ts_ms) else { return false };
        if !self.seen.insert(usage_key(&ev.sid, &ev.response_id, ev.ts_ms, &ev.usage)) {
            return false;
        }
        if origin == Origin::Ledger {
            self.extras += 1;
        }
        let u = &ev.usage;
        // 热力图在范围裁剪之前聚合：它固定看最近一年，不随上方范围切换
        if date >= self.heat_from {
            *self
                .by_heat
                .entry(date.format("%Y-%m-%d").to_string())
                .or_default()
                .entry(ev.model.clone())
                .or_insert(0) += u.total;
        }
        // 活跃日与热力图同口径：范围裁剪之前收全（切到「今日」不把活跃天数压成 1 天）
        self.active.insert(date);
        if self.cutoff.is_some_and(|c| date < c) {
            return true;
        }
        self.totals.bucket.add(u);
        true
    }

    /// 收尾：派生天数 / 连续天数 / 命中率，并补出完整日历。
    fn finish(self) -> (UsageTotals, Vec<UsageHeatRow>, u64) {
        let totals = finish_totals(self.totals, &self.active, self.today);
        (totals, fill_heat(&self.by_heat, self.today), self.extras)
    }
}

fn scan_with(
    root: &Path,
    days: Option<u32>,
    now: DateTime<Local>,
    ledger: Option<&Path>,
    budget: Budget,
) -> UsageStats {
    let today = now.date_naive();
    let mut acc = Accumulator::new(today, days);
    let started = std::time::Instant::now();

    let mut files: Vec<(std::time::SystemTime, PathBuf)> = vec![];
    if let Ok(rd) = std::fs::read_dir(root) {
        for entry in rd.flatten() {
            let Ok(inner) = std::fs::read_dir(entry.path()) else { continue };
            for f in inner.flatten() {
                let p = f.path();
                if p.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                    continue;
                }
                let mtime = f.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                files.push((mtime, p));
            }
        }
    }
    // 新会话优先：预算到点时，先保住最近的数据
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let mut truncated = files.len() > budget.max_files;

    let mut scanned_files = 0usize;
    let mut bytes_read = 0u64;

    for (_mtime, path) in files.into_iter().take(budget.max_files) {
        if bytes_read >= budget.max_bytes || started.elapsed().as_millis() as u64 >= budget.max_ms {
            truncated = true;
            break;
        }
        // 会话 id = jsonl 文件名里的完整 uuid（**不许退回 8 字符前缀**，见 AGENTS.md）
        let sid = path
            .file_name()
            .and_then(|s| s.to_str())
            .map(session_id_of_file)
            .unwrap_or_default()
            .to_string();
        let Ok(file) = std::fs::File::open(&path) else { continue };
        scanned_files += 1;
        // jsonl 里「见过」这个会话文件：账本遇到它的老记录时据此判重复（见 Accumulator::add）
        acc.scanned.insert(sid.clone());
        let reader = std::io::BufReader::new(file);
        for line in std::io::BufRead::lines(reader) {
            let Ok(line) = line else { break };
            bytes_read += line.len() as u64 + 1;
            if bytes_read > budget.max_bytes {
                truncated = true;
                break;
            }
            // 行级预筛：绝大多数行（用户消息 / 工具结果 / 标题变更）连解析都不用做
            if !line.contains("\"usage\"") {
                continue;
            }
            let Some(msg) = parse_message_line(&line) else { continue };
            // 没有 usage 的 assistant 行也**占去重位**：账本记的是同一条消息，两路要配对得上
            let usage = msg.usage.unwrap_or_default();
            let ev = UsageEvent {
                sid: sid.clone(),
                ts_ms: msg.ts_ms,
                model: msg.model,
                response_id: msg.response_id,
                usage,
            };
            acc.add(&ev, Origin::Jsonl);
        }
        if started.elapsed().as_millis() as u64 >= budget.max_ms {
            truncated = true;
            break;
        }
    }

    // 账本最后扫：jsonl 里已有的同一条消息已占位（键去重），账本只补「jsonl 里已经没有的」
    // ——已删除会话的用量、或 jsonl 被预算截断丢掉的那部分（见 Accumulator::add）
    let mut ledger_cut = false;
    if let Some(path) = ledger {
        if !read_ledger_events(path, &mut acc, ledger_budget(budget)) {
            ledger_cut = true;
        }
    }

    let (totals, heat, extras) = acc.finish();
    UsageStats { totals, heat, scanned_files, extras, truncated: truncated || ledger_cut }
}

/// 账本自身的读取预算：条数上限（新记录优先保留）+ 墙钟上限；到点即停并置 `truncated`。
fn ledger_budget(jsonl: Budget) -> Budget {
    Budget { max_files: LEDGER_MAX_EVENTS, max_bytes: jsonl.max_bytes, max_ms: LEDGER_MAX_MS }
}

/// 把一个会话文件名换成会话 id（去掉 `.jsonl` 后的完整 uuid；同名 `.lock` 等根本不进这里）。
fn session_id_of_file(file: &str) -> &str {
    file.strip_suffix(".jsonl").unwrap_or(file)
}

/// 读账本事件进累加器，返回是否**完整读完**（false = 到预算了，统计可能不全）。
fn read_ledger_events(path: &Path, acc: &mut Accumulator, budget: Budget) -> bool {
    let Ok(file) = std::fs::File::open(path) else {
        // 账本不存在（还没记过一条）= 没有要补的，不算不全
        return true;
    };
    let started = std::time::Instant::now();
    let reader = std::io::BufReader::new(file);
    let mut read = 0usize;
    let mut bytes = 0u64;
    for line in std::io::BufRead::lines(reader) {
        let Ok(line) = line else { break };
        bytes += line.len() as u64 + 1;
        if bytes > budget.max_bytes || started.elapsed().as_millis() as u64 >= budget.max_ms {
            return false;
        }
        if read >= budget.max_files {
            return false;
        }
        // 账本里的坏行（写了一半 / 手工改坏）跳过：统计少一行，总比整页报错强
        let Ok(ev) = serde_json::from_str::<UsageEvent>(&line) else { continue };
        read += 1;
        if ev.usage.total == 0 {
            continue;
        }
        acc.add(&ev, Origin::Ledger);
    }
    true
}

/// 收尾：从活跃日集合派生天数、连续天数与命中率。
fn finish_totals(
    mut totals: UsageTotals,
    active: &BTreeSet<NaiveDate>,
    today: NaiveDate,
) -> UsageTotals {
    // 集合的每个键都来自一条带 usage 的消息，键数即活跃天数（BTreeSet 天然按日期升序）
    let days: Vec<NaiveDate> = active.iter().copied().collect();
    totals.active_days = days.len() as u64;
    totals.longest_streak = longest_streak(&days);
    totals.current_streak = current_streak(&days, today);
    let denom = totals.bucket.input + totals.bucket.cache_read;
    totals.cache_hit_rate =
        if denom > 0 { Some(totals.bucket.cache_read as f64 / denom as f64) } else { None };
    totals
}

/// 最长连续天数（输入需按日期升序）。
fn longest_streak(days: &[NaiveDate]) -> u64 {
    let mut best = 0u64;
    let mut cur = 0u64;
    let mut prev: Option<NaiveDate> = None;
    for d in days {
        cur = match prev {
            Some(p) if *d == p + Days::new(1) => cur + 1,
            _ => 1,
        };
        best = best.max(cur);
        prev = Some(*d);
    }
    best
}

/// 当前连续天数（GitHub 口径：今天还没跑但昨天跑了不算断签，从昨天往前数）。
fn current_streak(days: &[NaiveDate], today: NaiveDate) -> u64 {
    let set: HashSet<NaiveDate> = days.iter().copied().collect();
    if set.is_empty() {
        return 0;
    }
    let mut cur = if set.contains(&today) { today } else { today - Days::new(1) };
    let mut n = 0u64;
    while set.contains(&cur) {
        n += 1;
        cur = cur - Days::new(1);
    }
    n
}

// ---------- 热力图 ----------

/// 热力图窗口起点：最近 [`HEAT_WEEKS`] 周的周日（最后一列 = 本周，今天的格子落在它自己那一行）。
fn heat_window_start(today: NaiveDate) -> NaiveDate {
    let offset = today.weekday().num_days_from_sunday() as u64;
    today - Days::new((HEAT_WEEKS - 1) * 7 + offset)
}

/// 热力图：从窗口起点到今天**逐日补零**（没跑的日子也要有格子，日历才成网格），
/// 每格的模型明细按 token 降序（界面直接照着列读数）。
fn fill_heat(by_heat: &BTreeMap<String, BTreeMap<String, u64>>, today: NaiveDate) -> Vec<UsageHeatRow> {
    let none = BTreeMap::new();
    let mut out = vec![];
    let mut cur = heat_window_start(today);
    while cur <= today {
        let key = cur.format("%Y-%m-%d").to_string();
        let mut models: Vec<UsageHeatModel> = by_heat
            .get(&key)
            .unwrap_or(&none)
            .iter()
            .map(|(model, total)| UsageHeatModel { model: model.clone(), total: *total })
            .collect();
        models.sort_by(|a, b| b.total.cmp(&a.total).then_with(|| a.model.cmp(&b.model)));
        let total = models.iter().map(|m| m.total).sum();
        out.push(UsageHeatRow { date: key, total, models });
        cur = cur + Days::new(1);
    }
    out
}

// ---------- 壳侧账本（追加写，已删除会话的用量不丢） ----------

/// 记账请求（`runtime.rs` 在每条 assistant `message_end` 上调用）：除了用量本身，还要
/// **本会话真实 id** 与模型名——账本行必须自带这两样，否则会话删掉后无从归档。
#[derive(Debug, Clone)]
pub struct UsageRecord {
    /// 本会话真实 id（完整 uuid；open-elsewhere 漂移后的新身份）。
    pub sid: String,
    /// 上游响应 id（缺失为空串，走 [`usage_key`] 的兜底口径）。
    pub response_id: String,
    /// omp 给的消息时间戳（毫秒）；缺失时为 None，由记录方退回「现在」。
    pub ts_ms: Option<i64>,
    pub model: String,
    pub usage: MsgUsage,
}

/// 账本存放状态：文件句柄懒开（写第一条记录才建目录 / 开文件 / 加载去重集合，
/// 不影响应用启动），去重集合与最近键环用于幂等。
#[derive(Default)]
struct LedgerStore {
    /// 已落盘的全局去重键（[`usage_key`]）
    emitted: HashSet<String>,
    /// 键的插入顺序（超 [`LEDGER_SEEN_CAP`] 时从最旧的开始淘汰）
    order: VecDeque<String>,
    file: Option<std::fs::File>,
    /// 加载过一次就不再重来（文件不存在也算加载过）
    hydrated: bool,
}

/// 壳侧使用账本：**只追加**、幂等、写失败不重复。
#[derive(Clone, Default)]
pub struct UsageLedger {
    path: Option<PathBuf>,
    store: Arc<Mutex<LedgerStore>>,
}

impl UsageLedger {
    /// 账本路径：`<appData>/omp-inn/usage-ledger.jsonl`。
    pub fn new(path: PathBuf) -> Self {
        Self { path: Some(path), store: Arc::new(Mutex::new(LedgerStore::default())) }
    }

    /// 应用数据目录拿不到时的空账本：统计照跑（只少「已删除会话」那一块）。
    pub fn disabled() -> Self {
        Self::default()
    }

    /// 账本路径（没启用时为 None）：统计命令用它拼扫描输入。
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// 每条 assistant 消息记一条（**异步入口**：见 [`UsageLedger::record_async`]）。
    ///
    /// - 已记过的键直接跳过（见 [`usage_key`]），所以重放 / 重启都不会写第二遍；
    /// - 写盘失败（磁盘满 / 权限）时**不**把键标成已记——下次同一个键还能再试一次；
    /// - 首次调用会顺带加载既有账本重建去重集合（[`hydrate`]），大文件是同步读盘，
    ///   所以**调用方必须走 [`UsageLedger::record_async`]**，别在会话事件循环里直接调它。
    ///
    /// 返回 `true` = 这次真的追加了一行（已记过 / 空账本返回 false）。
    pub fn record(&self, rec: &UsageRecord) -> std::io::Result<bool> {
        let Some(path) = self.path.as_ref() else { return Ok(false) };
        let mut store = self.store.lock().unwrap_or_else(|e| e.into_inner());
        if !store.hydrated {
            hydrate(path, &mut store);
            store.hydrated = true;
        }
        let key = usage_key(&rec.sid, &rec.response_id, rec.ts_ms.unwrap_or_default(), &rec.usage);
        if store.emitted.contains(&key) {
            return Ok(false);
        }
        let file = match store.file.as_mut() {
            Some(f) => f,
            None => {
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                store.file.insert(
                    OpenOptions::new().create(true).append(true).open(path)?,
                )
            }
        };
        let ev = UsageEvent {
            sid: rec.sid.clone(),
            // 时间戳缺失时退回「现在」：宁可归档到今天，也不丢这一条用量
            ts_ms: rec.ts_ms.unwrap_or_else(|| Local::now().timestamp_millis()),
            model: rec.model.clone(),
            response_id: rec.response_id.clone(),
            usage: rec.usage,
        };
        let mut line = serde_json::to_string(&ev).unwrap_or_default();
        line.push('\n');
        file.write_all(line.as_bytes())?;
        file.flush()?;
        // 写成功了才记账：失败的下次还能重试
        store.order.push_back(key.clone());
        store.emitted.insert(key);
        if store.order.len() > LEDGER_SEEN_CAP {
            if let Some(old) = store.order.pop_front() {
                store.emitted.remove(&old);
            }
        }
        Ok(true)
    }

    /// 会话事件循环用的记账入口：把同步写盘丢进阻塞线程池——**不许**在 pump 里直接
    /// [`UsageLedger::record`]（首次记账要加载整个账本，大文件会把事件循环卡住）。
    /// 返回是否真的写入了新行（false = 已记过或写盘失败；失败只影响「已删除会话的补记」）。
    pub async fn record_async(&self, rec: &UsageRecord) -> bool {
        let this = self.clone();
        let rec = rec.clone();
        tokio::task::spawn_blocking(move || this.record(&rec))
            .await
            .map(|r| r.unwrap_or(false))
            .unwrap_or(false)
    }
}

/// 加载既有账本，把全局去重键收进内存（文件不存在 = 空账本，不是错误）。
fn hydrate(path: &Path, store: &mut LedgerStore) {
    let Ok(file) = std::fs::File::open(path) else { return };
    for line in std::io::BufRead::lines(std::io::BufReader::new(file)).map_while(Result::ok) {
        let Ok(ev) = serde_json::from_str::<UsageEvent>(&line) else { continue };
        let key = usage_key(&ev.sid, &ev.response_id, ev.ts_ms, &ev.usage);
        if store.emitted.insert(key.clone()) {
            store.order.push_back(key);
        }
    }
    // 超长账本：只保留最近的键（更老的响应不可能再被重放）
    while store.order.len() > LEDGER_SEEN_CAP {
        if let Some(old) = store.order.pop_front() {
            store.emitted.remove(&old);
        }
    }
}

// ---------- 命令 ----------

/// 使用统计：扫会话 jsonl **并**并入壳侧账本聚合三项指标（范围可选：1 / 7 / 30 天，null = 全部）。
/// 范围只作用于 tokens 总量与命中率；活跃天数 / 连续天数恒为全量历史。
/// 账本负责「会话被删掉后用量不丢」，两路按 [`usage_key`] 去重（见模块头）。
#[tauri::command]
pub async fn get_usage_stats(
    state: State<'_, AppState>,
    days: Option<u32>,
) -> Result<UsageStats, CmdError> {
    let agent = state.agent_dir.lock().await.clone();
    let ledger = state.usage_ledger.clone();
    let days = days.map(|d| d.clamp(1, 3650));
    Ok(scan_usage_full(&agent.join("sessions"), days, Local::now(), ledger.path()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// 固定的「现在」：2026-09-16 12:00 本地时区（测试里所有时间都由它派生）。
    fn now() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 9, 16, 12, 0, 0).single().expect("本地时间应唯一")
    }

    fn ts(y: i32, m: u32, d: u32, h: u32) -> i64 {
        Local.with_ymd_and_hms(y, m, d, h, 0, 0).single().expect("本地时间应唯一").timestamp_millis()
    }

    fn tmp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omp-usage-test-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn line_session(id: &str, cwd: &str) -> String {
        serde_json::json!({
            "type": "session", "version": 3, "id": id,
            "timestamp": "2026-09-15T10:00:00.000Z", "cwd": cwd
        })
        .to_string()
    }

    fn line_title() -> String {
        serde_json::json!({"type": "title", "title": "会话标题"}).to_string()
    }

    fn usage_json(input: u64, output: u64, cache_read: u64) -> serde_json::Value {
        serde_json::json!({
            "input": input, "output": output, "cacheRead": cache_read, "cacheWrite": 0,
            "totalTokens": input + output + cache_read, "reasoningTokens": 7,
            "cost": {"input": 0.001, "output": 0.002, "cacheRead": 0.0001, "cacheWrite": 0.0, "total": 0.0031}
        })
    }

    fn line_assistant(ts_ms: i64, usage: Option<serde_json::Value>) -> String {
        let mut m = serde_json::json!({
            "role": "assistant", "content": [], "provider": "anthropic", "model": "sonnet",
            "timestamp": ts_ms, "duration": 1500,
            // 真机每条成功调用都带 responseId（实测），去重主键就是它——测试数据同形
            "responseId": format!("rid-{ts_ms}-{}", usage.is_some() as u8),
        });
        if let Some(u) = usage {
            m["usage"] = u;
        }
        serde_json::json!({"type": "message", "message": m}).to_string()
    }

    fn line_user(ts_ms: i64) -> String {
        serde_json::json!({
            "type": "message",
            "message": {"role": "user", "content": [{"type": "text", "text": "你好"}], "timestamp": ts_ms}
        })
        .to_string()
    }

    /// 在临时目录里落一个会话文件：`sessions/<slug>/<file>.jsonl`。
    fn write_session(root: &Path, slug: &str, file: &str, lines: &[String]) {
        let dir = root.join(slug);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(file), lines.join("\n") + "\n").unwrap();
    }

    // ---------- 行解析 ----------

    #[test]
    fn parse_line_reads_usage_and_timestamp() {
        let line = line_assistant(ts(2026, 9, 16, 9), Some(usage_json(100, 20, 300)));
        let msg = parse_message_line(&line).expect("assistant 行应被解析");
        assert_eq!(msg.ts_ms, ts(2026, 9, 16, 9));
        assert_eq!(msg.model, "sonnet", "模型名原样带出（热力图按模型拆读数）");
        let u = msg.usage.expect("有 usage");
        assert_eq!((u.input, u.output, u.cache_read, u.cache_write, u.total), (100, 20, 300, 0, 420));

        // 缺 totalTokens 的老数据按四段之和兜底；ISO 顶层时间戳也能兜
        let old = serde_json::json!({
            "type": "message", "timestamp": "2026-09-16T01:00:00.000Z",
            "message": {"role": "assistant", "content": [], "usage": {"input": 5, "output": 6, "cacheRead": 7, "cacheWrite": 8}}
        })
        .to_string();
        let msg = parse_message_line(&old).expect("老数据也要认");
        assert_eq!(msg.usage.unwrap().total, 26, "totalTokens 缺失时按四段之和");
        // 退回的是顶层 ISO 串本身：断言该 UTC 时刻的毫秒值，**不能**用本地时区构造的
        // `ts(…)`（CI 跑在 UTC、开发机在 UTC+8，那样断言会随机器差 8 小时）
        let iso_ms = DateTime::parse_from_rfc3339("2026-09-16T01:00:00.000Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(msg.ts_ms, iso_ms, "退回顶层 ISO 时间戳");

        // 没有 usage 的 assistant 行认，但用量为空
        assert!(parse_message_line(&line_assistant(ts(2026, 9, 16, 9), None)).unwrap().usage.is_none());
        // 非 assistant / 非 message / 无时间的行一律不认
        assert!(parse_message_line(&line_user(ts(2026, 9, 16, 9))).is_none());
        assert!(parse_message_line("{\"type\":\"custom\",\"customType\":\"tool_execution_start\"}").is_none());
        assert!(parse_message_line("不是 JSON").is_none());
        let no_ts = serde_json::json!({"type": "message", "message": {"role": "assistant", "content": [], "usage": {"input": 1}}})
            .to_string();
        assert!(parse_message_line(&no_ts).is_none(), "没有时间就无法归档到某一天");
    }

    // ---------- 聚合 ----------

    #[test]
    fn scan_aggregates_totals_and_active_days() {
        let root = tmp_root("agg");
        write_session(
            &root,
            "--tmp-demo--",
            "s1.jsonl",
            &[
                line_title(),
                line_session("sid-1", "/tmp/demo"),
                line_user(ts(2026, 9, 16, 9)),
                line_assistant(ts(2026, 9, 16, 9), Some(usage_json(100, 20, 300))),
                line_assistant(ts(2026, 9, 16, 15), Some(usage_json(200, 30, 0))),
                // 没有 usage 的 assistant 行：既不计请求也不计活跃
                line_assistant(ts(2026, 9, 16, 15), None),
            ],
        );
        write_session(
            &root,
            "--tmp-other--",
            "s2.jsonl",
            &[
                line_session("sid-2", "/tmp/other"),
                line_assistant(ts(2026, 9, 15, 10), Some(usage_json(50, 10, 0))),
            ],
        );
        let stats = scan_usage_in(&root, None, now());
        assert_eq!(stats.scanned_files, 2);
        assert!(!stats.truncated);
        assert_eq!(stats.totals.bucket.input, 350);
        assert_eq!(stats.totals.bucket.output, 60);
        assert_eq!(stats.totals.bucket.cache_read, 300);
        assert_eq!(stats.totals.bucket.total, 710, "total = input+output+cacheRead");
        assert_eq!(stats.totals.bucket.calls, 3);
        assert_eq!(stats.totals.active_days, 2);
        assert_eq!(stats.totals.current_streak, 2, "今天与昨天连成 2 天");
        assert_eq!(stats.totals.longest_streak, 2);
        // 热力图：53 周窗口从周日开始、补零到今天（2026-09-16 是周三 → 368 格）
        assert_eq!(stats.heat[0].date, "2025-09-14");
        assert_eq!(stats.heat.len(), 365 + 3);
        assert_eq!(stats.heat.last().unwrap().date, "2026-09-16");
        assert_eq!(stats.heat.last().unwrap().total, 650);
        assert_eq!(stats.heat[stats.heat.len() - 2].total, 60, "昨天 50+10");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn heat_window_is_one_year_from_sunday_and_range_independent() {
        let root = tmp_root("heat");
        write_session(
            &root,
            "--tmp-demo--",
            "s1.jsonl",
            &[
                line_session("sid-1", "/tmp/demo"),
                // 窗口外的旧数据：日历里没有，但「全部」范围仍计入总览
                line_assistant(ts(2025, 9, 1, 8), Some(usage_json(7777, 0, 0))),
                // 一年内、远在 7 日窗口外：日历要留着
                line_assistant(ts(2026, 1, 5, 8), Some(usage_json(120, 0, 0))),
                line_assistant(ts(2026, 9, 16, 8), Some(usage_json(10, 0, 0))),
            ],
        );
        let week = scan_with(&root, Some(7), now(), None, Budget::default());
        assert_eq!(week.totals.bucket.total, 10, "总览仍只看 7 日窗口");
        assert_eq!(week.totals.active_days, 3, "活跃天数不受窗口影响（含一年前的 2025-09-01）");
        let jan = week.heat.iter().find(|h| h.date == "2026-01-05").expect("日历覆盖一年");
        assert_eq!(jan.total, 120, "热力图不随范围裁剪");
        assert!(week.heat.iter().all(|h| h.date != "2025-09-01"), "一年前的旧数据不进日历");
        // 周日对齐：53 列的列首都是周日（最后一块可能不满 7 格）
        for (i, chunk) in week.heat.chunks(7).enumerate() {
            let d = NaiveDate::parse_from_str(&chunk[0].date, "%Y-%m-%d").unwrap();
            assert_eq!(d.weekday().num_days_from_sunday(), 0, "第 {} 列的列首应是周日", i + 1);
        }
        assert_eq!(week.heat.chunks(7).count(), HEAT_WEEKS as usize);

        let all = scan_with(&root, None, now(), None, Budget::default());
        assert_eq!(all.totals.bucket.total, 7777 + 120 + 10, "全部范围不受日历窗口影响");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn heat_rows_carry_per_model_breakdown() {
        let root = tmp_root("heat-models");
        // 同一天两个模型：格子的读数要按 token 降序列出各自用量
        let mut gpt = serde_json::json!({
            "role": "assistant", "content": [], "model": "gpt-5", "timestamp": ts(2026, 9, 16, 10)
        });
        gpt["usage"] = usage_json(10, 0, 0);
        write_session(
            &root,
            "--tmp-demo--",
            "s1.jsonl",
            &[
                line_session("sid-1", "/tmp/demo"),
                line_assistant(ts(2026, 9, 16, 9), Some(usage_json(100, 20, 300))), // sonnet 420
                serde_json::json!({"type": "message", "message": gpt}).to_string(), // gpt-5 10
                line_assistant(ts(2026, 9, 15, 9), Some(usage_json(7, 0, 0))),      // 昨天 sonnet 7
            ],
        );
        let stats = scan_with(&root, Some(1), now(), None, Budget::default());
        let today = stats.heat.last().unwrap();
        assert_eq!(today.date, "2026-09-16");
        assert_eq!(today.total, 430, "合计 = 各模型之和");
        let models: Vec<(&str, u64)> =
            today.models.iter().map(|m| (m.model.as_str(), m.total)).collect();
        assert_eq!(models, vec![("sonnet", 420), ("gpt-5", 10)], "按 token 降序");
        // 只有 sonnet 的那天不带 gpt-5；没跑的日子没有明细
        let yesterday = &stats.heat[stats.heat.len() - 2];
        assert_eq!(yesterday.models.len(), 1);
        assert_eq!(yesterday.models[0].model, "sonnet");
        assert!(stats.heat[0].models.is_empty(), "补零的格子没有模型明细");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn range_filter_scopes_tokens_but_active_days_stay_global() {
        let root = tmp_root("range");
        write_session(
            &root,
            "--tmp-demo--",
            "s1.jsonl",
            &[
                line_session("sid-1", "/tmp/demo"),
                line_assistant(ts(2026, 9, 16, 8), Some(usage_json(1000, 0, 0))),
                // 昨天（近 7 日内）
                line_assistant(ts(2026, 9, 15, 8), Some(usage_json(100, 0, 0))),
                // 10 天前（窗口外）
                line_assistant(ts(2026, 9, 6, 8), Some(usage_json(9999, 0, 0))),
            ],
        );
        let week = scan_with(&root, Some(7), now(), None, Budget::default());
        assert_eq!(week.totals.bucket.total, 1100, "窗口外的 9999 不能计入 tokens 总量");
        assert_eq!(week.totals.bucket.calls, 2);
        assert_eq!(week.totals.active_days, 3, "活跃天数看全量历史，含窗口外的 9-6");
        assert_eq!(week.totals.current_streak, 2);
        assert_eq!(week.totals.longest_streak, 2, "9-15 / 9-16 连成 2 天，9-6 是孤日");

        // 「今日」：tokens 只算今天，但活跃天数 / 连续天数与「全部」一致，不随范围缩水
        let today = scan_with(&root, Some(1), now(), None, Budget::default());
        assert_eq!(today.totals.bucket.total, 1000);
        assert_eq!(today.totals.bucket.calls, 1);
        assert_eq!(today.totals.active_days, 3);
        assert_eq!(today.totals.current_streak, 2);
        assert_eq!(today.totals.longest_streak, 2);

        // 全部：tokens 含窗口外
        let all = scan_with(&root, None, now(), None, Budget::default());
        assert_eq!(all.totals.bucket.total, 11099);
        assert_eq!(all.totals.active_days, today.totals.active_days);
        assert_eq!(all.totals.current_streak, 2, "中间断了 7 天，当前连的只有今天与昨天");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn derived_stats_cover_cache_rate_and_streaks() {
        let root = tmp_root("derived");
        write_session(
            &root,
            "--tmp-demo--",
            "s1.jsonl",
            &[
                line_session("sid-1", "/tmp/demo"),
                // 连续三天（今天 / 昨天 / 前天）+ 五天前断一天
                line_assistant(ts(2026, 9, 16, 9), Some(usage_json(100, 10, 300))),
                line_assistant(ts(2026, 9, 15, 9), Some(usage_json(100, 10, 0))),
                line_assistant(ts(2026, 9, 14, 9), Some(usage_json(100, 10, 0))),
                line_assistant(ts(2026, 9, 11, 9), Some(usage_json(100, 10, 0))),
            ],
        );
        let stats = scan_with(&root, None, now(), None, Budget::default());
        let t = &stats.totals;
        assert_eq!(t.active_days, 4);
        assert_eq!(t.current_streak, 3, "今天 / 昨天 / 前天连成 3 天");
        assert_eq!(t.longest_streak, 3);
        // 命中率 = cacheRead / (input + cacheRead) = 300 / 700
        assert!((t.cache_hit_rate.unwrap() - 300.0 / 700.0).abs() < 1e-9);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cache_hit_rate_is_null_without_denominator() {
        let root = tmp_root("rate");
        write_session(
            &root,
            "--tmp-demo--",
            "s1.jsonl",
            &[
                line_session("sid-1", "/tmp/demo"),
                // 只有输出 token：命中率没有分母（界面显示 —），但用量本身有效
                line_assistant(ts(2026, 9, 16, 9), Some(usage_json(0, 50, 0))),
            ],
        );
        let stats = scan_with(&root, Some(1), now(), None, Budget::default());
        assert_eq!(stats.totals.bucket.calls, 1);
        assert_eq!(stats.totals.bucket.total, 50);
        assert_eq!(stats.totals.cache_hit_rate, None);
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---------- 预算与异常 ----------

    #[test]
    fn budget_exhaustion_sets_truncated() {
        let root = tmp_root("budget");
        for i in 0..3 {
            write_session(
                &root,
                "--tmp-demo--",
                &format!("s{i}.jsonl"),
                &[
                    line_session(&format!("sid-{i}"), "/tmp/demo"),
                    line_assistant(ts(2026, 9, 16, 9), Some(usage_json(10, 0, 0))),
                ],
            );
        }
        let cut = scan_with(&root, None, now(), None, Budget { max_files: 1, ..Budget::default() });
        assert!(cut.truncated, "文件数超预算要明说可能不全");
        assert_eq!(cut.scanned_files, 1);
        assert_eq!(cut.totals.bucket.calls, 1);

        let tiny_bytes = scan_with(&root, None, now(), None, Budget { max_bytes: 1, ..Budget::default() });
        assert!(tiny_bytes.truncated);
        assert_eq!(tiny_bytes.totals.bucket.calls, 0, "预算到点即停，不硬扫");

        let no_time = scan_with(&root, None, now(), None, Budget { max_ms: 0, ..Budget::default() });
        assert!(no_time.truncated, "时间预算到点也要说可能不全");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn malformed_lines_and_missing_dir_are_ignored() {
        let root = tmp_root("bad");
        write_session(
            &root,
            "--tmp-demo--",
            "s1.jsonl",
            &[
                "这不是 JSON".to_string(),
                line_session("sid-1", "/tmp/demo"),
                "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[],\"usage\":{\"input\":9}".to_string(),
                line_assistant(ts(2026, 9, 16, 9), Some(usage_json(10, 5, 0))),
            ],
        );
        let stats = scan_with(&root, None, now(), None, Budget::default());
        assert_eq!(stats.totals.bucket.calls, 1, "坏行跳过，好行照算");
        assert_eq!(stats.totals.bucket.total, 15);
        // sessions 目录不存在：返回空统计而不是报错
        let empty = scan_usage_in(Path::new("/tmp/omp-usage-definitely-missing"), None, now());
        assert_eq!(empty.totals.bucket.calls, 0);
        assert_eq!(empty.scanned_files, 0);
        assert_eq!(empty.totals.active_days, 0);
        assert_eq!(empty.totals.cache_hit_rate, None);
        assert_eq!(empty.totals.current_streak, 0);
        // 热力图即使一条数据都没有，也给出完整日历（全零格）
        assert_eq!(empty.heat.last().unwrap().date, "2026-09-16");
        assert!(empty.heat.iter().all(|h| h.total == 0));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn non_jsonl_files_and_lock_files_are_skipped() {
        let root = tmp_root("extra");
        write_session(
            &root,
            "--tmp-demo--",
            "s1.jsonl",
            &[line_session("sid-1", "/tmp/demo"), line_assistant(ts(2026, 9, 16, 9), Some(usage_json(1, 1, 0)))],
        );
        std::fs::write(root.join("--tmp-demo--/.s1.jsonl.lock.os"), "lock").unwrap();
        std::fs::write(root.join("--tmp-demo--/notes.txt"), "非 jsonl").unwrap();
        let stats = scan_with(&root, None, now(), None, Budget::default());
        assert_eq!(stats.scanned_files, 1, "只扫 .jsonl");
        assert_eq!(stats.totals.bucket.calls, 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---------- 壳侧账本（已删除会话的用量不丢） ----------

    /// 账本落盘路径（测试自己的临时文件）。
    fn ledger_path(tag: &str) -> PathBuf {
        let dir = tmp_root(tag);
        dir.join("usage-ledger.jsonl")
    }

    /// 把一条 assistant 行按真机口径喂给账本（时间戳取消息里的毫秒数字）。
    fn record_of(line: &str, sid: &str) -> UsageRecord {
        let msg = parse_message_line(line).expect("assistant 行");
        UsageRecord {
            sid: sid.to_string(),
            response_id: msg.response_id.clone(),
            ts_ms: Some(msg.ts_ms),
            model: msg.model.clone(),
            usage: msg.usage.unwrap_or_default(),
        }
    }

    fn feed(ledger: &UsageLedger, sid: &str, line: &str) {
        ledger.record(&record_of(line, sid)).expect("记账应成功");
    }

    fn ledger_lines(path: &Path) -> Vec<String> {
        std::fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn ledger_records_once_per_message_and_survives_restart() {
        let path = ledger_path("ledger-append");
        let sid = "0199aaaa-1111-7000-8000-000000000001";
        let line = line_assistant(ts(2026, 9, 16, 9), Some(usage_json(100, 20, 300)));
        let ledger = UsageLedger::new(path.clone());
        feed(&ledger, sid, &line);
        feed(&ledger, sid, &line); // 同一条消息重复到达：幂等，不写第二行
        // 同一轮在别的会话身份下出现（open-elsewhere 之类）：键里带 sid，算两条——但用量一模一样
        feed(&ledger, "0199bbbb-2222-7000-8000-000000000002", &line);
        assert_eq!(ledger_lines(&path).len(), 2, "同会话同响应只写一行");

        // 会话事件循环走的是异步入口（写盘在阻塞线程池）：口径与同步入口一致
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let fresh = UsageLedger::new(path.clone());
            // 新实例没加载过账本，异步入口要能自己 hydrate 后判重
            assert!(!fresh.record_async(&record_of(&line, sid)).await, "已记过的不再写");
            let other = line_assistant(ts(2026, 9, 16, 10), Some(usage_json(1, 1, 0)));
            assert!(fresh.record_async(&record_of(&other, sid)).await, "新的一条要写进去");
        });
        assert_eq!(ledger_lines(&path).len(), 3, "异步入口也要幂等");

        // 重启（新实例）后仍然幂等：靠重新加载账本重建去重集合
        let again = UsageLedger::new(path.clone());
        feed(&again, sid, &line);
        assert_eq!(ledger_lines(&path).len(), 3, "重启后不许重复记账");

        let ev: UsageEvent = serde_json::from_str(&ledger_lines(&path)[0]).expect("账本行可解析");
        assert_eq!(ev.sid, sid);
        assert_eq!(ev.ts_ms, ts(2026, 9, 16, 9));
        assert_eq!(ev.model, "sonnet");
        assert_eq!(ev.usage.cache_read, 300, "账本要留住 cacheWrite / cacheRead（命中率靠它）");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn ledger_merges_with_jsonl_without_double_counting() {
        let root = tmp_root("ledger-merge");
        let path = ledger_path("ledger-merge-ledger");
        let sid = "0199cccc-3333-7000-8000-000000000003";
        let with_usage = line_assistant(ts(2026, 9, 16, 9), Some(usage_json(100, 20, 300)));
        let no_usage = line_assistant(ts(2026, 9, 16, 11), None);
        write_session(&root, "--tmp-demo--", &format!("{sid}.jsonl"), &[
            line_session(sid, "/tmp/demo"),
            with_usage.clone(),
            no_usage.clone(),
        ]);
        // 账本里既有「jsonl 也有的那条」，也有「jsonl 里没有的那条」（例如删掉后重记的历史）
        let gone = line_assistant(ts(2026, 9, 15, 9), Some(usage_json(7, 3, 0)));
        let ledger = UsageLedger::new(path.clone());
        feed(&ledger, sid, &with_usage);
        feed(&ledger, sid, &no_usage);
        feed(&ledger, sid, &gone);

        let merged = scan_with(&root, None, now(), Some(&path), Budget::default());
        assert_eq!(merged.totals.bucket.calls, 2, "jsonl 一条 + 账本补一条");
        assert_eq!(merged.totals.bucket.total, 420 + 10, "jsonl 那条不许被账本翻倍");
        assert_eq!(merged.extras, 1, "只有 jsonl 里没有的那条算补记");
        assert_eq!(merged.totals.active_days, 2, "补记那天也算活跃");
        // 只扫 jsonl（不带账本）时看不到那条补记——正是删除会话会丢的那部分
        let jsonl_only = scan_usage_in(&root, None, now());
        assert_eq!(jsonl_only.totals.bucket.calls, 1);
        assert_eq!(jsonl_only.extras, 0);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn ledger_supplies_usage_of_deleted_sessions_but_not_request_counts_of_failures() {
        let root = tmp_root("ledger-deleted");
        let path = ledger_path("ledger-deleted-ledger");
        let sid = "0199dddd-4444-7000-8000-000000000004";
        // 账本里两条：一条有效用量（会话随后被删），一条失败重试（全 0，不该进统计）
        let ledger = UsageLedger::new(path.clone());
        feed(&ledger, sid, &line_assistant(ts(2026, 9, 16, 9), Some(usage_json(50, 10, 0))));
        // 失败重试：usage 全 0、**没有 responseId**（真机口径），键退回时间戳 + 用量签名
        let failed = serde_json::json!({
            "type": "message",
            "message": {
                "role": "assistant", "content": [], "model": "sonnet",
                "timestamp": ts(2026, 9, 16, 10),
                "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0}
            }
        })
        .to_string();
        feed(&ledger, sid, &failed);
        assert_eq!(ledger_lines(&path).len(), 2, "记账不看用量大小，全 0 也落一行（读取方按 0 丢弃）");

        // 会话 jsonl 被删（目录里什么都没有）：统计仍给出那一条有效用量
        let stats = scan_with(&root, None, now(), Some(&path), Budget::default());
        assert_eq!(stats.scanned_files, 0);
        assert_eq!(stats.totals.bucket.calls, 1, "全 0 的失败调用不进请求数");
        assert_eq!(stats.totals.bucket.total, 60);
        assert_eq!(stats.extras, 1);
        assert_eq!(stats.totals.active_days, 1);
        assert!(!stats.truncated, "账本不存在 / 读完都不算「统计可能不全」");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// 与 jsonl 重叠的那一段：**同一条消息（同 responseId）账本里有、jsonl 里也有时只算一次**
    /// ——这正是「账本不许把已落盘的会话翻倍」的核心口径（不分时间早晚、不分会话文件在不在）。
    #[test]
    fn ledger_overlapping_entries_are_deduplicated_by_response_id() {
        let root = tmp_root("ledger-overlap");
        let path = ledger_path("ledger-overlap-ledger");
        let live = "0199ffff-6666-7000-8000-000000000006";
        // jsonl 里只有今天这一条
        write_session(&root, "--tmp-live--", &format!("{live}.jsonl"), &[
            line_session(live, "/tmp/live"),
            line_assistant(ts(2026, 9, 16, 9), Some(usage_json(1000, 0, 0))),
        ]);
        let ledger = UsageLedger::new(path.clone());
        // 同一条（同 responseId）也记在账本里 → 去重，不许算两遍
        feed(&ledger, live, &line_assistant(ts(2026, 9, 16, 9), Some(usage_json(1000, 0, 0))));
        // 更早的一条（jsonl 里没有：它是这个会话被删掉的历史）→ 补记
        feed(&ledger, live, &line_assistant(ts(2026, 9, 15, 9), Some(usage_json(500, 0, 0))));

        let stats = scan_with(&root, None, now(), Some(&path), Budget::default());
        assert_eq!(stats.totals.bucket.total, 1000 + 500, "重叠那条不许算两遍");
        assert_eq!(stats.totals.bucket.calls, 2);
        assert_eq!(stats.extras, 1, "只有 jsonl 里没有的那条算补记");
        assert_eq!(stats.totals.active_days, 2, "补记那天也算活跃");
        assert!(!stats.truncated, "账本读完就不算「统计不全」");

        // 重启（新账本实例、重新 hydrate）后再跑一次：结果必须完全一致（幂等）
        let again = scan_with(&root, None, now(), Some(&path), Budget::default());
        assert_eq!(again.totals.bucket.total, 1500);
        assert_eq!(again.extras, 1);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn ledger_bad_lines_and_budget_are_tolerated() {
        let root = tmp_root("ledger-bad");
        let path = ledger_path("ledger-bad-ledger");
        std::fs::write(
            &path,
            format!(
                "这不是 JSON\n{}\n{{\"sid\":\"half\n",
                serde_json::json!({
                    "sid": "0199eeee-5555-7000-8000-000000000005",
                    "tsMs": ts(2026, 9, 16, 9),
                    "model": "sonnet",
                    "responseId": "rid-ledger-1",
                    "usage": {"input": 5, "output": 5, "cacheRead": 0, "cacheWrite": 0, "total": 10}
                })
            ),
        )
        .unwrap();
        let stats = scan_with(&root, None, now(), Some(&path), Budget::default());
        assert_eq!(stats.totals.bucket.total, 10, "坏行跳过，好行照算");

        // 账本读取也有预算：条数到点即停（`scan_with` 据此把 `truncated` 置 true，见那里的 ledger_cut）
        let mut acc = Accumulator::new(now().date_naive(), None);
        assert!(
            !read_ledger_events(
                &path,
                &mut acc,
                Budget { max_files: 0, max_bytes: u64::MAX, max_ms: u64::MAX }
            ),
            "条数预算 0 时读不完"
        );
        // 账本文件缺失 = 没有要补的，不算不全
        let missing = scan_with(
            &root,
            None,
            now(),
            Some(Path::new("/tmp/omp-usage-no-such-ledger")),
            Budget::default(),
        );
        assert!(!missing.truncated);
        assert_eq!(missing.totals.bucket.calls, 0);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// 真机探针回归：**成功调用**的 `message_end.message`（omp 18.11.1 / rpc-ui 实测原样）
    /// 经 `runtime.rs` 那条取值路径（[`parse_usage`] + 取 responseId / timestamp / model）进账本，
    /// 再被统计读回来——覆盖「实时帧 → 账本行 → 统计」整条链路的字段口径。
    /// 探针同时确认：jsonl 里同一条消息的这三个值**完全一致**（模块头「壳侧账本」）。
    #[test]
    fn real_message_end_frame_round_trips_through_ledger() {
        let path = ledger_path("ledger-real-frame");
        // 探针抓到的真帧（成功调用：带 responseId；失败 / 重试的调用 usage 全 0 且无 responseId）
        let m: serde_json::Value = serde_json::from_str(
            r#"{"role":"assistant","content":[],"provider":"deepseek","model":"deepseek-flash",
                "responseId":"e4445cd1-26b5-41ad-9ddb-37e0387092ea","timestamp":1792128700867,
                "duration":1377,"ttft":420,
                "usage":{"input":3795,"output":209,"cacheRead":256,"cacheWrite":0,
                         "totalTokens":4260,"reasoningTokens":202,
                         "cost":{"input":0.00056925,"output":0.0001254,"cacheRead":7.68e-7,"cacheWrite":0,"total":0.000695418}}}"#,
        )
        .unwrap();
        // runtime.rs 的记账取值（同一段逻辑）
        let u = parse_usage(&m["usage"]);
        assert_eq!((u.input, u.output, u.cache_read, u.cache_write, u.total), (3795, 209, 256, 0, 4260));
        let sid = "01a14331-cd6e-768b-8bd1-f7ad006bd603";
        let rec = UsageRecord {
            sid: sid.to_string(),
            response_id: m["responseId"].as_str().unwrap_or("").to_string(),
            ts_ms: m["timestamp"].as_i64(),
            model: m["model"].as_str().unwrap_or("").to_string(),
            usage: u,
        };
        let ledger = UsageLedger::new(path.clone());
        ledger.record(&rec).unwrap();
        ledger.record(&rec).unwrap(); // 重放同一帧：幂等
        assert_eq!(ledger_lines(&path).len(), 1);

        // 统计读回来：三项指标与热力图都按这条算，且算的是「已删除会话的补记」
        let root = tmp_root("ledger-real-frame-sessions");
        let stats = scan_with(&root, None, Local::now(), Some(&path), Budget::default());
        assert_eq!(stats.totals.bucket.calls, 1);
        assert_eq!(stats.totals.bucket.input, 3795);
        assert_eq!(stats.totals.bucket.cache_read, 256);
        assert_eq!(stats.totals.bucket.total, 4260);
        assert_eq!(stats.extras, 1);
        // 命中率 = 256 / (3795 + 256)，与 jsonl 扫描同一算法
        let want = 256.0 / (3795.0 + 256.0);
        assert!((stats.totals.cache_hit_rate.unwrap() - want).abs() < 1e-9);
        let day = stats.heat.iter().find(|h| h.total > 0).expect("热力图应有一格");
        assert_eq!(day.models.len(), 1);
        assert_eq!(day.models[0].model, "deepseek-flash");
        assert_eq!(day.models[0].total, 4260);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// 真机数据基准（默认跳过，避免 CI 依赖本机数据）：
    /// `OMP_BENCH=1 cargo test --manifest-path src-tauri/Cargo.toml scans_real -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn scans_real_agent_dir_for_bench() {
        if std::env::var("OMP_BENCH").ok().as_deref() != Some("1") {
            return;
        }
        let agent = crate::session_scan::resolve_agent_dir(None);
        let started = std::time::Instant::now();
        let stats = scan_usage_full(&agent.join("sessions"), None, Local::now(), None);
        println!(
            "扫描 {} 个文件，耗时 {}ms，truncated={}；token 合计 {}（输入 {} / 输出 {} / 缓存读 {}），请求 {}，活跃 {} 天（连续 {} / 最长 {}），命中率 {:?}",
            stats.scanned_files,
            started.elapsed().as_millis(),
            stats.truncated,
            stats.totals.bucket.total,
            stats.totals.bucket.input,
            stats.totals.bucket.output,
            stats.totals.bucket.cache_read,
            stats.totals.bucket.calls,
            stats.totals.active_days,
            stats.totals.current_streak,
            stats.totals.longest_streak,
            stats.totals.cache_hit_rate,
        );
        assert!(stats.scanned_files > 0, "本机应有会话数据（没有就跑不出基准）");
        // 真实数据上的口径回归：活跃天数不随范围变化，tokens 总量随范围收窄
        let today_only = scan_usage_full(&agent.join("sessions"), Some(1), Local::now(), None);
        assert_eq!(
            today_only.totals.active_days, stats.totals.active_days,
            "「今日」档的活跃天数应与全量一致"
        );
        assert!(
            today_only.totals.bucket.total <= stats.totals.bucket.total,
            "「今日」档的 tokens 总量不应超过全量"
        );

        // 真机数据 + 账本：**已有会话一条都不许重复计**，补记的只有那条「已删除会话」
        let path = ledger_path("ledger-real");
        let ledger = UsageLedger::new(path.clone());
        let existing = real_first_usage(&agent.join("sessions")).expect("真机上应有带 usage 的消息");
        // 补记那条落在真机已有数据的那一天：这样「活跃天数」也必须与纯 jsonl 一致
        let gone_sid = "0199aaaa-bbbb-7000-8000-00000000beef";
        let gone_usage = usage_json(1234, 56, 78);
        let mut gone_msg = serde_json::json!({
            "role": "assistant", "content": [], "model": "sonnet",
            "timestamp": existing.2, "responseId": "rid-gone-session",
        });
        gone_msg["usage"] = gone_usage;
        feed(
            &ledger,
            gone_sid,
            &serde_json::json!({"type": "message", "message": gone_msg}).to_string(),
        );
        // 真机上「已存在」的那条也塞进账本（同一个 responseId + 同一份用量）：必须被去重掉
        ledger
            .record(&UsageRecord {
                sid: existing.0.clone(),
                response_id: existing.1.clone(),
                ts_ms: Some(existing.2),
                model: "sonnet".into(),
                usage: existing.3,
            })
            .unwrap();
        let merged = scan_usage_full(&agent.join("sessions"), None, Local::now(), Some(&path));
        assert_eq!(
            merged.totals.bucket.total,
            stats.totals.bucket.total + 1234 + 56 + 78,
            "真机数据 + 账本：只多出「已删除会话」那一条，已存在的会话不许翻倍"
        );
        assert_eq!(merged.totals.bucket.calls, stats.totals.bucket.calls + 1);
        assert_eq!(merged.extras, 1, "补记条数 = 1");
        assert_eq!(merged.totals.active_days, stats.totals.active_days, "补记落在已有数据的同一天");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// 真机目录里第一条带 usage 的 assistant 消息：`(会话 id, responseId, 毫秒时间戳, 用量)`。
    fn real_first_usage(root: &Path) -> Option<(String, String, i64, MsgUsage)> {
        for entry in std::fs::read_dir(root).ok()?.flatten() {
            let Ok(inner) = std::fs::read_dir(entry.path()) else { continue };
            for f in inner.flatten() {
                if f.path().extension().and_then(|s| s.to_str()) != Some("jsonl") {
                    continue;
                }
                let sid = session_id_of_file(&f.file_name().to_string_lossy()).to_string();
                let Ok(text) = std::fs::read_to_string(f.path()) else { continue };
                for line in text.lines() {
                    if !line.contains("\"usage\"") {
                        continue;
                    }
                    let Some(msg) = parse_message_line(line) else { continue };
                    if let Some(u) = msg.usage.filter(|u| u.total > 0) {
                        return Some((sid, msg.response_id, msg.ts_ms, u));
                    }
                }
            }
        }
        None
    }
}
