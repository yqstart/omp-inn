//! M2 实时运行时：per-会话长驻 `omp --mode rpc-ui` 子进程。
//!
//! 线路：spawn → 等 ready → negotiate v2 → get_state（拿身份）→
//! 后台读 stdout 行 → rpc_chunk 重组 → 按 type 分发 emit 事件。
//!
//! 用 `rpc-ui` 而非 `rpc`：上游把 `hasUI=true` 的 RPC 变体单独出一个模式，
//! 差别是会话会挂上 `ask` 工具（模型能主动向用户提问，UI 请求走既有的
//! `extension_ui_request` 桥）。实测对比与帧形状见 `docs/architecture.md` 的「进程模型」。

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicI64, AtomicU8, Ordering},
        Arc,
    },
};
use tokio::sync::Mutex;
use tauri::{AppHandle, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin},
    sync::mpsc,
};

use crate::commands::cmd_err;

#[derive(Debug, Clone)]
pub struct SpawnOpts {
    pub bin: String,
    pub cwd: String,
    pub resume: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub approval: Option<String>,
}

impl SpawnOpts {
    fn args(&self) -> Vec<String> {
        let mut a = vec!["--mode".into(), "rpc-ui".into(), "--cwd".into(), self.cwd.clone()];
        if let Some(r) = &self.resume {
            a.push("--resume".into());
            a.push(r.clone());
        }
        if let Some(m) = &self.model {
            a.push("--model".into());
            a.push(m.clone());
        }
        if let Some(t) = &self.thinking {
            a.push("--thinking".into());
            a.push(t.clone());
        }
        if let Some(x) = &self.approval {
            a.push("--approval-mode".into());
            a.push(x.clone());
        }
        a
    }
}

/// 会话活动态：闲置回收的判定依据（V34）。
///
/// `last_active_ms` 在**每次收到 omp 帧**时 touch（spawn 时刻起算）；
/// `state` 跟随 omp 的运行状态（帧驱动，与发给前端的 `omp-status://` 同一批更新点，
/// 见 [`emit_status`]）。回收只认 `idle`——`running`（agent 在干活，哪怕某个工具
/// 长时间没输出）/ `awaiting`（等用户审批）/ `idle-awaiting`（等后台完成投递，
/// 见 [`ACT_IDLE_AWAITING`]）/ `exited`（异常退出）一律不碰。
pub struct SessionActivity {
    last_active_ms: AtomicI64,
    state: AtomicU8,
    pending_input: std::sync::Mutex<PendingInput>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum InputPhase { Prompt, PromptAwaitingResult, QueueAwaitingReply, QueueAwaitingSettled }

#[derive(Default)]
struct PendingInput {
    requests: HashMap<String, InputPhase>,
    awaiting_settled: bool,
    settle_generation: u64,
}

const REAP_PROBE_PREFIX: &str = "reap-probe-";
const REAP_SETTLED_PROBE: &str = "reap-probe-settled-";

/// 与 `dispatch` 发给前端的 `{"state": ...}` 字符串一一对应。
pub const ACT_IDLE: u8 = 0;
pub const ACT_RUNNING: u8 = 1;
pub const ACT_AWAITING: u8 = 2;
/// 异常退出 / 错误：与「正常 idle」区分开，回收不认它。
pub const ACT_EXITED: u8 = 3;
/// 等后台完成投递（omp 的 `agent_end{isTerminal:false, awaitingAsyncWork:true}`）：
/// 轮次已 yield、前端语义就是 idle（对齐 omp TUI 的 `y6("idle")`，用户可继续输入），
/// 但**闲置回收必须跳过**——后台完成（job / supervised process）可能注入 follow-up
/// 唤醒会话，唤醒投递还在路上时 kill 进程会把它弄丢。与 [`ACT_IDLE`] 单列只为这个。
pub const ACT_IDLE_AWAITING: u8 = 4;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl SessionActivity {
    fn new() -> Self {
        Self { last_active_ms: AtomicI64::new(now_ms()), state: AtomicU8::new(ACT_IDLE), pending_input: std::sync::Mutex::new(PendingInput::default()) }
    }

    fn touch(&self) {
        self.last_active_ms.store(now_ms(), Ordering::Relaxed);
    }

    /// 命令路径（approve / respond_ui 把状态改回 running）也可以直接落活动态。
    pub fn set_state(&self, s: u8) {
        self.state.store(s, Ordering::Relaxed);
    }

    /// 当前活动态（回读路径 `get_session_runtime` 用它把状态补回真值，见 [`activity_state_label`]）。
    pub fn state(&self) -> u8 {
        self.state.load(Ordering::Relaxed)
    }

    fn last_active_ms(&self) -> i64 {
        self.last_active_ms.load(Ordering::Relaxed)
    }

    /// 由进程表锁保护调用，与回收判定和实际投递构成一个原子操作。
    pub(crate) fn register_input(&self, id: &str, kind: &str) {
        let phase = if kind == "prompt" { InputPhase::Prompt } else { InputPhase::QueueAwaitingReply };
        self.pending_input.lock().unwrap_or_else(|e| e.into_inner()).requests.insert(id.to_string(), phase);
        self.touch();
    }

    pub(crate) fn cancel_input(&self, id: &str) {
        self.pending_input.lock().unwrap_or_else(|e| e.into_inner()).requests.remove(id);
    }

    fn input_pending(&self) -> bool {
        let pending = self.pending_input.lock().unwrap_or_else(|e| e.into_inner());
        pending.awaiting_settled || !pending.requests.is_empty()
    }

    /// 只用本次请求的回包或静止确认解除保护，不受上一轮迟到的终态帧影响。
    fn observe_input_frame(&self, v: &serde_json::Value) -> Vec<String> {
        let typ = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
        let mut pending = self.pending_input.lock().unwrap_or_else(|e| e.into_inner());
        if typ == "session_settled" {
            // 即使收到上一轮迟到的静止帧，也必须在该请求已获确认后再次回读真值。
            let mut probes: Vec<String> = pending.requests.iter().filter_map(|(id, phase)| {
                matches!(phase, InputPhase::PromptAwaitingResult | InputPhase::QueueAwaitingSettled)
                    .then(|| format!("{REAP_PROBE_PREFIX}{id}"))
            }).collect();
            if pending.awaiting_settled {
                probes.push(format!("{REAP_SETTLED_PROBE}{}", pending.settle_generation));
            }
            return probes;
        } else if typ == "prompt_result" {
            pending.requests.remove(id);
            if v.get("sessionSettled").and_then(|x| x.as_bool()) == Some(false) {
                // 前一次回读可能先于此结果，仍需对后台投递重新保护并核验。
                pending.awaiting_settled = true;
                pending.settle_generation = pending.settle_generation.wrapping_add(1);
                return vec![format!("{REAP_SETTLED_PROBE}{}", pending.settle_generation)];
            }
        } else if typ == "response" {
            let settled = v.get("success").and_then(|x| x.as_bool()) == Some(true)
                && v.get("data").and_then(|d| d.get("isSettled")).and_then(|x| x.as_bool()) == Some(true);
            if let Some(generation) = id.strip_prefix(REAP_SETTLED_PROBE) {
                if settled && generation.parse::<u64>().ok() == Some(pending.settle_generation) {
                    pending.awaiting_settled = false;
                }
            } else if let Some(original) = id.strip_prefix(REAP_PROBE_PREFIX) {
                let phase = pending.requests.get(original);
                if settled
                    && matches!(phase, Some(InputPhase::PromptAwaitingResult | InputPhase::QueueAwaitingSettled))
                {
                    pending.requests.remove(original);
                }
            } else if let Some(phase) = pending.requests.get(id).copied() {
                let failed = v.get("success").and_then(|x| x.as_bool()) == Some(false);
                let local = v.get("data").and_then(|d| d.get("agentInvoked")).and_then(|x| x.as_bool()) == Some(false);
                if failed || (phase == InputPhase::Prompt && local) {
                    pending.requests.remove(id);
                } else if phase == InputPhase::Prompt {
                    pending.requests.insert(id.to_string(), InputPhase::PromptAwaitingResult);
                    return vec![format!("{REAP_PROBE_PREFIX}{id}")];
                } else if phase == InputPhase::QueueAwaitingReply {
                    pending.requests.insert(id.to_string(), InputPhase::QueueAwaitingSettled);
                    return vec![format!("{REAP_PROBE_PREFIX}{id}")];
                }
            }
        }
        vec![]
    }
}

/// 活动态 → 前端口径的字符串（与 [`emit_status`] 的 `state` 一一对应；`error` / `exited`
/// 两档共用一个活动态，回读时统一报 `exited`——前端两档的展示同为「不在跑」）。
/// `idle-awaiting` 回读同样报 `idle`（前端语义一致；活动态单列只为回收判定）。
pub fn activity_state_label(s: u8) -> &'static str {
    match s {
        ACT_RUNNING => "running",
        ACT_AWAITING => "awaiting-approval",
        ACT_IDLE | ACT_IDLE_AWAITING => "idle",
        _ => "exited",
    }
}

/// 「任务在跑」的判定（列表运行标 / 未读完成标的口径）：agent 在干活，或一轮
/// 卡在等用户审批。`idle` / `idle-awaiting`（轮次已 yield，等后台投递）/ `exited`
/// 都不是——列表转圈只表示**这一轮在跑**，不是「进程开着」（常驻是打开状态，
/// 不是运行状态；历史实现把两者混为一谈，跑完的任务会一直转圈）。
pub fn activity_is_busy(s: u8) -> bool {
    matches!(s, ACT_RUNNING | ACT_AWAITING)
}

impl Default for SessionActivity {
    fn default() -> Self {
        Self::new()
    }
}

/// 闲置回收阈值：idle 且这么久没有任何帧 → 回收（kill）长驻进程。
/// 内存大头就是这些常驻 omp 进程（每个 0.5–1GB，实测），
/// 而「浏览过的会话」会一直留着——不回收，开十个会话就是十个进程。
/// 回收后**重新打开 / 直接发消息都会自动 resume**（`send_prompt` 的自动恢复），
/// 所以这个阈值不需要保守到「用户回来第一眼看不到会话」的程度。
pub const IDLE_RECYCLE_MS: i64 = 30 * 60 * 1000;

/// 回收扫描间隔。
const REAP_INTERVAL_SECS: u64 = 60;

/// 单个会话是否符合回收条件（纯判定，不含「已落盘」检查——那是调用处的 I/O）。
/// 只认 [`ACT_IDLE`]：`idle-awaiting`（等后台完成投递，唤醒的 follow-up 可能在路上）
/// 与 running / awaiting / exited 一样排除在外。
fn idle_recyclable(act: &SessionActivity, now_ms: i64, idle_ms: i64) -> bool {
    act.state() == ACT_IDLE && !act.input_pending() && now_ms.saturating_sub(act.last_active_ms()) >= idle_ms
}

/// 闲置回收循环（app 启动时挂一次）：每 [`REAP_INTERVAL_SECS`] 秒扫一遍聊天会话进程表，
/// 把「idle 超阈值 + 已落盘」的会话 kill 掉。
///
/// 为什么必须「已落盘」：omp 的 jsonl 是懒写盘的（首个 turn 才落文件），刚建好、
/// 还没说过话的会话被回收后磁盘上什么都没有——列表靠 runtime 补的那一行会凭空消失。
///
/// 静默回收（不发状态事件）：回收只发生在 idle，前端状态本来就显示 idle，一致；
/// 用户回来后发消息走自动恢复，中间不需要看见「已退出」这类会吓人的中间态。
pub fn start_idle_reaper<R: tauri::Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(REAP_INTERVAL_SECS)).await;
            let state = app.state::<crate::commands::AppState>();
            reclaim_idle_now(&state, IDLE_RECYCLE_MS).await;
        }
    });
}

/// 立即回收闲置会话进程（设置 ›「存储维护」的手动入口，返回回收数量）。
///
/// 与定时回收同一判定：`idle` 超阈值 + 已落盘——运行中 / 等审批 / 等后台投递的会话一律不碰。
pub async fn reclaim_idle_now(state: &tauri::State<'_, crate::commands::AppState>, idle_ms: i64) -> usize {
    let now = now_ms();
    let mut rt = state.runtime.lock().await;
    let victims: Vec<String> = rt.iter().filter(|(_, r)| {
        idle_recyclable(&r.activity, now, idle_ms)
            && r.session_file.as_ref().map(|f| f.exists()).unwrap_or(false)
    }).map(|(sid, _)| sid.clone()).collect();
    let mut count = 0;
    for sid in victims {
        // 判定、终止及移除都在同一把锁内，发送只能在回收前登记或在回收后恢复。
        if let Some(r) = rt.get_mut(&sid) {
            if !idle_recyclable(&r.activity, now_ms(), idle_ms)
                || !r.session_file.as_ref().map(|f| f.exists()).unwrap_or(false) {
                continue;
            }
            if stop_failed_child(r).await.is_ok() {
                rt.remove(&sid);
                count += 1;
            }
        }
    }
    count
}

pub struct RunningChild {
    pub tx: mpsc::UnboundedSender<String>,
    pub child: Child,
    /// 运行时真值快照（模型 / 可用思考档 / 当前档 / 用量），供打开会话时回填。
    pub meta: SessionMeta,
    /// spawn 时的 `--cwd`。omp 的 jsonl 是**懒写盘**的（首个 turn 才落文件），
    /// 刚建好的会话读不到文件头，会话归属只能靠这份事实，不许退回「未归属」。
    pub cwd: String,
    /// spawn 时刻（毫秒）。同理：没落盘就没有会话时间可用，列表补行时用这份事实，
    /// 而不是每次刷新都拿「现在」，免得那一行的时间随刷新跳动。
    pub created_ms: i64,
    /// 活动态（V34 闲置回收判定 / 帧触达）。
    pub activity: Arc<SessionActivity>,
    /// 会话 jsonl 路径（握手 `get_state` 的 `sessionFile`）。回收只碰**已落盘**的会话。
    pub session_file: Option<PathBuf>,
}

pub type RuntimeMap = Arc<Mutex<HashMap<String, RunningChild>>>;

/// 回收失效进程；无法确认退出时保留表项，避免恢复时与仍在运行的旧进程竞争。
pub(crate) async fn stop_failed_child(r: &mut RunningChild) -> std::io::Result<()> {
    if r.child.try_wait()?.is_some() {
        return Ok(());
    }
    match r.child.kill().await {
        Ok(()) => Ok(()),
        Err(e) => match r.child.try_wait() {
            Ok(Some(_)) => Ok(()),
            _ => Err(e),
        },
    }
}

/// 模型引用（精简：前端只需拼 selector = provider/id）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ModelRef {
    pub provider: String,
    pub id: String,
    pub name: Option<String>,
}

/// 上下文占用（omp `get_state.contextUsage`）——纯透传，前端不自算。
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    pub tokens: Option<i64>,
    pub context_window: Option<i64>,
    /// omp 给的就是百分比（0–100，实测 `usedTokens / contextWindow * 100`，不是 0–1 比例）。
    pub percent: Option<f64>,
}

/// 最近一轮的用量（omp `message_end.message.usage`，实测结构与成本都在里面）。
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input: Option<i64>,
    pub output: Option<i64>,
    pub total_tokens: Option<i64>,
    pub cache_read: Option<i64>,
    pub reasoning_tokens: Option<i64>,
    pub cost_total: Option<f64>,
}

impl Usage {
    fn from_json(u: &serde_json::Value) -> Self {
        let n = |k: &str| u.get(k).and_then(|x| x.as_i64());
        Self {
            input: n("input"),
            output: n("output"),
            total_tokens: n("totalTokens"),
            cache_read: n("cacheRead"),
            reasoning_tokens: n("reasoningTokens"),
            cost_total: u.get("cost").and_then(|c| c.get("total")).and_then(|x| x.as_f64()),
        }
    }
}

/// 会话运行时真值：由 omp `get_state` / `set_model` / `message_end` 回包提取，前端只读回填。
/// 实时变化经 `omp-state://<id>` 推送，与命令 `get_session_runtime` 结构一致。
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub model: Option<ModelRef>,
    /// 当前模型可用思考档（omp `model.thinking.efforts`）；`None` = 不支持思考。
    pub efforts: Option<Vec<String>>,
    /// 当前思考档；缺键（无思考模型）= `None`。
    pub thinking_level: Option<String>,
    /// 上下文占用（`get_state.contextUsage`）。
    pub context_usage: Option<ContextUsage>,
    /// 最近一轮用量（`message_end.message.usage`）。
    pub usage: Option<Usage>,
    /// 最近一轮耗时（毫秒）；omp 原样给毫秒，这里不做任何换算。
    pub duration_ms: Option<f64>,
    /// 最近一轮首字延迟（毫秒）。
    pub ttft_ms: Option<f64>,
    /// 排队中的消息数（`get_state.queuedMessageCount`）。
    pub queued_count: Option<i64>,
    /// 待发队列真值（`get_state.queuedMessages` 原样透传：`{steering,followUp,liveSteered}`）。
    /// V40：队列芯片文本可撤回 / 提升（`queue_update` 事件是实时权威，这里是回读兜底）。
    pub queued_messages: Option<serde_json::Value>,
    /// fast 模式（`get_state.fastModeEnabled/Active`；V41——模型不支持时两者皆 false）。
    pub fast_mode_enabled: Option<bool>,
    pub fast_mode_active: Option<bool>,
    /// 当前模型是否提供 priority 服务档位（Fast）。由壳侧按 omp `service-tier` 规则从
    /// `get_state.model` 元数据判定；`None` / `false` 时前端不显示闪电图标。
    pub fast_mode_supported: Option<bool>,
    /// slow 模式（`get_state.slowModeSupported/Enabled`；V41）。
    pub slow_mode_supported: Option<bool>,
    pub slow_mode_enabled: Option<bool>,
    /// 任务计划（`get_state.todoPhases` 原样透传）。
    pub todo_phases: Option<serde_json::Value>,
    /// 可用命令（`available_commands_update` 缓存）。
    pub commands: Option<serde_json::Value>,
    /// 当前活动态（`idle` / `running` / `awaiting-approval` / `exited`；「等后台完成投递」
    /// 档在回读里一并报 `idle`，见 [`activity_state_label`]）。
    ///
    /// **只在回读（`get_session_runtime`）里填**：`omp-status://` 的事件是推送，前端切走
    /// 期间收不到——切回时靠这次回读把状态补回真值（否则一个正在跑的会话会显示成 idle，
    /// 输入框会把下一句当新 prompt 发出去 = 打断进行中的轮次）。事件推送里保持 `None`，
    /// 前端按事件维护自己那份副本。
    pub status: Option<String>,
    /// 上下文非消息部分的字符权重（`get_state` 的 systemPrompt / dumpTools 估算）。
    /// **不进前端**：只给 `get_context_breakdown` 用，原始 systemPrompt / dumpTools 有几十 KB，
    /// 留在快照里会让每次 `omp-state` 推送都背上它。
    #[serde(skip)]
    pub ctx_weights: Option<crate::context::Weights>,
}

impl SessionMeta {
    /// 从 `get_state` 的 data 段提取真值。
    pub fn from_state(d: &serde_json::Value) -> Self {
        let m = d.get("model").filter(|m| !m.is_null());
        Self {
            model: m.and_then(model_ref),
            efforts: m.and_then(efforts_of),
            thinking_level: d.get("thinkingLevel").and_then(|x| x.as_str()).map(str::to_string),
            context_usage: d.get("contextUsage").filter(|c| !c.is_null()).map(|c| ContextUsage {
                tokens: c.get("tokens").and_then(|x| x.as_i64()),
                context_window: c.get("contextWindow").and_then(|x| x.as_i64()),
                percent: c.get("percent").and_then(|x| x.as_f64()),
            }),
            queued_count: d.get("queuedMessageCount").and_then(|x| x.as_i64()),
            queued_messages: d.get("queuedMessages").filter(|q| !q.is_null()).cloned(),
            fast_mode_enabled: d.get("fastModeEnabled").and_then(|x| x.as_bool()),
            fast_mode_active: d.get("fastModeActive").and_then(|x| x.as_bool()),
            fast_mode_supported: m.map(fast_mode_supported),
            slow_mode_supported: d.get("slowModeSupported").and_then(|x| x.as_bool()),
            slow_mode_enabled: d.get("slowModeEnabled").and_then(|x| x.as_bool()),
            todo_phases: d.get("todoPhases").filter(|t| !t.is_null()).cloned(),
            // 用量 / 耗时 / 命令来自事件流，回读时保留旧值（见 handle_frame 的 StateSync 分支）
            usage: None,
            duration_ms: None,
            ttft_ms: None,
            commands: None,
            // 活动态不在 `get_state` 回包里，由回读路径（`get_session_runtime`）从进程表现取
            status: None,
            // 系统提示词 / 工具定义只在 get_state 里有，就地折成字符权重后丢掉原文
            ctx_weights: crate::context::weights_from_state(d),
        }
    }

    /// 从 `set_model` 回包（data 即模型对象本身）提取；档位留空，等随后的 `get_state` 回读填。
    pub fn from_model(m: &serde_json::Value) -> Self {
        Self {
            model: model_ref(m),
            efforts: efforts_of(m),
            fast_mode_supported: Some(fast_mode_supported(m)),
            thinking_level: None,
            ..Self::default()
        }
    }

    /// 从 `message_end` 的 assistant 消息提取用量与耗时；非 assistant / 无字段返回 `None`。
    fn usage_from_message_end(m: &serde_json::Value) -> Option<(Option<Usage>, Option<f64>, Option<f64>)> {
        if m.get("role").and_then(|r| r.as_str()) != Some("assistant") {
            return None;
        }
        let usage = m.get("usage").filter(|u| !u.is_null()).map(Usage::from_json);
        let duration = m.get("duration").and_then(|x| x.as_f64());
        let ttft = m.get("ttft").and_then(|x| x.as_f64());
        if usage.is_none() && duration.is_none() && ttft.is_none() {
            return None;
        }
        Some((usage, duration, ttft))
    }
}

/// 提取精简模型引用（provider/id/name）。
fn model_ref(m: &serde_json::Value) -> Option<ModelRef> {
    let id = m.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if id.is_empty() {
        return None;
    }
    Some(ModelRef {
        provider: m.get("provider").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        id,
        name: m.get("name").and_then(|x| x.as_str()).map(str::to_string),
    })
}

/// 模型元数据里的字符串字段（缺失按空串）。
fn text_field<'a>(m: &'a serde_json::Value, key: &str) -> &'a str {
    m.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

/// 模型的 OpenAI 身份 + OpenAI 兼容 wire（omp `i(model)`）：
/// `!fireworks/github-copilot && api∈{openai-*} && identity.class=openai`。
fn is_openai_compat(m: &serde_json::Value) -> bool {
    let provider = text_field(m, "provider");
    let api = text_field(m, "api");
    let identity = m
        .get("identity")
        .and_then(|i| i.get("class"))
        .and_then(|x| x.as_str());
    provider != "fireworks"
        && provider != "github-copilot"
        && matches!(api, "openai-completions" | "openai-responses" | "openai-codex-responses")
        && identity == Some("openai")
}

/// omp `ty(model)`：服务档位家族。`None` = 模型没有 service-tier 控制（`/fast` 直接拒绝）。
fn service_tier_family(m: &serde_json::Value) -> Option<&'static str> {
    let provider = text_field(m, "provider");
    let identity = m
        .get("identity")
        .and_then(|i| i.get("class"))
        .and_then(|x| x.as_str());
    if provider == "openrouter" {
        return match identity {
            Some("anthropic") => Some("anthropic"),
            Some("gemini") => Some("google"),
            Some("openai") => Some("openai"),
            _ => None,
        };
    }
    if provider == "openai" || provider == "openai-codex" {
        return Some("openai");
    }
    if text_field(m, "api") == "anthropic-messages" {
        return Some("anthropic");
    }
    if provider == "google" || provider == "google-vertex" {
        return Some("google");
    }
    if is_openai_compat(m) {
        return Some("openai");
    }
    None
}

/// omp `Cu(tier, model)`：模型是否声明支持某个服务档位（这里只需要 priority）。
fn supports_service_tier(m: &serde_json::Value, tier: &str) -> bool {
    let provider = text_field(m, "provider");
    if text_field(m, "api") == "openai-codex-responses" && tier != "flex" && tier != "default" {
        if let Some(tiers) = m.get("serviceTiers").and_then(|x| x.as_array()) {
            if !tiers.is_empty() {
                return tiers.iter().any(|x| x.as_str() == Some(tier));
            }
        }
    }
    if tier == "ultrafast" {
        return provider == "openai" || provider == "openai-codex";
    }
    if provider == "openai" || provider == "openai-codex" {
        return true;
    }
    if provider == "openrouter" {
        return matches!(tier, "flex" | "scale" | "priority");
    }
    if is_openai_compat(m) {
        return true;
    }
    if provider == "google" {
        return matches!(tier, "flex" | "priority");
    }
    if provider == "google-vertex" || provider == "fireworks" {
        return tier == "priority";
    }
    false
}

/// omp `Cve("priority", model)`：priority 档位的实际可用性。
/// 非 first-party Anthropic 的 anthropic-messages 端点（如 commandcode 的 Claude）
/// 明确不可用；OpenRouter 只看 openai / google 身份。
fn priority_supported(m: &serde_json::Value) -> bool {
    let provider = text_field(m, "provider");
    if provider == "anthropic" {
        return true;
    }
    if provider == "openrouter" {
        return matches!(service_tier_family(m), Some("openai" | "google"));
    }
    if text_field(m, "api") == "anthropic-messages" {
        return false;
    }
    supports_service_tier(m, "priority")
}

/// 当前模型能否使用 omp 的 priority（Fast）服务档位。
///
/// 复刻 omp 18.12.3 `packages/ai/src/service-tier.ts` 的判定（`ty` + `Cve`/`Cu`）：
/// 家族映射不出来（commandcode 的 DeepSeek、官方 DeepSeek、fireworks 等）= 不支持；
/// 家族有了还要过 priority 的可用性（如非 first-party 的 anthropic-messages 端点不支持）。
/// 前端据此决定是否显示 Fast 闪电图标——**不支持就不显示**，不再等点击后报错。
pub fn fast_mode_supported(m: &serde_json::Value) -> bool {
    if !m.is_object() {
        return false;
    }
    service_tier_family(m).is_some() && priority_supported(m)
}

/// 思考档强度序（与 omp CLI `--thinking` 全集一致，off 最弱）。
pub const EFFORT_ORDER: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// 提取模型可用思考档：`thinking.efforts`（对象形态）或 `thinking`（数组形态）。
/// 空数组归一为 `None`（视同不支持思考）。
pub fn efforts_of(model: &serde_json::Value) -> Option<Vec<String>> {
    let t = model.get("thinking")?;
    let arr = if t.is_array() { Some(t) } else { t.get("efforts") };
    let out: Vec<String> = arr?
        .as_array()?
        .iter()
        .filter_map(|x| x.as_str())
        .map(str::to_string)
        .collect();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// 该模型支持的最高档（不在 8 档全集内的一律忽略）；无可用档 = `off`。
pub fn highest_effort(efforts: Option<&Vec<String>>) -> String {
    let mut best = "off";
    let mut rank = 0usize;
    for e in efforts.into_iter().flatten() {
        if let Some(r) = EFFORT_ORDER.iter().position(|x| x == e) {
            if r > rank {
                rank = r;
                best = EFFORT_ORDER[r];
            }
        }
    }
    best.to_string()
}

/// 档位对某模型是否合法：在 `efforts` 内，或为 `off`（omp 的 efforts 从不列 `off`，但它恒定生效）。
pub fn level_supported(efforts: Option<&Vec<String>>, level: &str) -> bool {
    level == "off" || efforts.into_iter().flatten().any(|e| e == level)
}

/// 切模型成功后的思考档跟进决策（纯函数，单测锁着；`None` = 不注入档位、只回读真值）：
///
/// - 新模型不支持思考 → 不注入（omp 自己会丢掉档位，界面上的档位选择也不出现）；
/// - 当前档对新模型仍然合法 → 不注入（与终端同一语义：omp 保留有效档，**不覆盖用户的选择**）；
/// - 否则（档位缺失 / 对新模型非法）→ 下发 **omp 配置的默认档**（`defaultThinkingLevel`，
///   夹到新模型支持集；配置没读到 / 不被该模型支持 → 退回该模型最高档）。
///
/// 实测（omp 18.10.3 rpc-ui）：切模型时 omp 保留仍然合法的档位；切到无思考模型丢档，
/// 且之后切回来**不会**自动恢复——所以只有「缺档」这种局面才需要壳侧落一个默认值。
pub fn auto_think_level(
    efforts: Option<&Vec<String>>,
    cur_level: Option<&str>,
    default_level: Option<&str>,
) -> Option<String> {
    let e = efforts?;
    if cur_level.is_some_and(|c| level_supported(Some(e), c)) {
        return None;
    }
    let def = default_level.unwrap_or("");
    Some(if level_supported(Some(e), def) {
        def.to_string()
    } else {
        highest_effort(Some(e))
    })
}

/// v2 大帧分片重组器（rpc_chunk）。V1 先实现校验 + 重组。
#[derive(Default)]
pub struct ChunkAsm {
    cur: Option<(String, usize, Vec<Option<String>>)>,
}

impl ChunkAsm {
    /// 输入一行解析后的帧；返回重组完成的完整帧（若有）。
    pub fn feed(&mut self, v: &serde_json::Value) -> Option<serde_json::Value> {
        if v.get("type").and_then(|t| t.as_str()) != Some("rpc_chunk") {
            return None;
        }
        let id = v.get("chunkId").and_then(|s| s.as_str())?.to_string();
        let index = v.get("index").and_then(|n| n.as_u64())? as usize;
        let count = v.get("count").and_then(|n| n.as_u64())? as usize;
        let data = v.get("data").and_then(|s| s.as_str())?.to_string();
        if count == 0 || count > 4096 || index >= count {
            self.cur = None;
            return None;
        }
        match &mut self.cur {
            Some((cid, ccount, parts)) if *cid == id && *ccount == count => {
                if parts[index].is_some() {
                    self.cur = None;
                    return None;
                }
                parts[index] = Some(data);
            }
            _ => {
                let mut parts = vec![None; count];
                parts[index] = Some(data);
                self.cur = Some((id, count, parts));
            }
        }
        let done = self.cur.as_ref().map(|(_, _, p)| p.iter().all(|x| x.is_some())).unwrap_or(false);
        if !done {
            return None;
        }
        let (_, _, parts) = self.cur.take().unwrap();
        let joined: String = parts.into_iter().flatten().collect();
        let bytes = b64decode(&joined)?;
        let text = String::from_utf8(bytes).ok()?;
        serde_json::from_str(&text).ok()
    }
}

/// stdout/stderr 拿不到（进程刚起就消失）时的统一说明：带上 stderr 里 omp 自己写的原因。
fn spawn_fail_msg(what: &str, err: &StderrBuf) -> String {
    match err.note() {
        Some(note) => format!("{what}；omp 输出：{note}"),
        None => format!("{what}：omp 进程意外退出"),
    }
}

/// 采集上限：omp 的报错都很短（一行原因 + 一行提示）；封顶防止异常进程刷爆内存。
const STDERR_KEEP_BYTES: usize = 4096;

/// omp 的 stderr 采集缓冲（spawn 时开一条后台读取，失败时取用）。
///
/// 采集任务的句柄一并留着：失败路径要 `join` 它再读，否则读到的可能是「还没采完」的空缓冲
/// （omp 写完就退，读任务被调度到什么时候不确定——靠 sleep 猜时间是不稳的）。
/// 成功路径不 join（进程常驻，任务跟着活）。
#[derive(Clone, Default)]
struct StderrBuf {
    text: Arc<std::sync::Mutex<String>>,
    task: Arc<std::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>,
}

impl StderrBuf {
    /// 后台逐行采集（进程退出时读到 EOF 自然收工）。
    fn spawn_collect(&self, err: tokio::process::ChildStderr) {
        let me = self.clone();
        let handle = tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut b = me.text.lock().unwrap();
                if b.len() >= STDERR_KEEP_BYTES {
                    break;
                }
                b.push_str(&line);
                b.push('\n');
            }
        });
        *self.task.lock().unwrap() = Some(handle);
    }

    /// 等采集任务收工（进程已退出 ⇒ 读很快到 EOF；已在别的路径 join 过就直接过）。
    async fn settle(&self) {
        let handle = self.task.lock().unwrap().take();
        if let Some(h) = handle {
            let _ = h.await;
        }
    }

    /// (首行, 其余行)——`None` = 采集为空（进程没来得及写任何东西）。
    fn parts(&self) -> Option<(String, String)> {
        let text = self.text.lock().unwrap().clone();
        let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
        let first = lines.next()?.to_string();
        let rest = lines.collect::<Vec<_>>().join("\n");
        Some((first, rest))
    }

    /// 单行形式的说明（无输出回 `None`）。
    fn note(&self) -> Option<String> {
        self.parts().map(|(first, rest)| combine_note(first, rest))
    }
}

/// 首行 + 其余行拼成一条诊断说明（纯函数：单测覆盖换行折叠与空白裁剪）。
fn combine_note(first: String, rest: String) -> String {
    if rest.is_empty() {
        first
    } else {
        format!("{first}（{rest}）")
    }
}

/// 在 spawn / 握手失败的错误上补一句 omp 自己写的原因。
///
/// 现场：用户的覆盖层里留着上游已改名 / 删除的模型（`ccproxy/deepseek/deepseek-v4.1-flash-fast`），
/// `omp --model <它>` 在 ready 之前就退出、stdout 一帧都没有，壳只能报「omp 进程意外退出」——
/// 真正的原因（`Model "…" not found`）此前被 `Stdio::null()` 扔了。这里把 stderr 采样接上去。
fn with_stderr_reason(mut e: crate::commands::CmdError, err: &StderrBuf) -> crate::commands::CmdError {
    if let Some((first, rest)) = err.parts() {
        e.message = format!("{}（omp 输出：{}）", e.message, first);
        if !rest.is_empty() && e.hint.is_none() {
            e.hint = Some(rest);
        }
    }
    e
}

/// spawn 长驻进程并完成握手，登记进 `RuntimeMap`（**键 = 会话 id**）并启动 pump。
/// 成功返回 `(session_id, session_file, 运行时真值)`。
///
/// 为什么不用调用方给的 key 作 map 键：像 `create_session` 这样的调用方手里只有占位键
/// （`new-<ts>`），真身份要握手才知道；而事件三通道与 pump 的 map 查询（真值快照 /
/// 命令面缓存 / 偏好回写）**从第一帧起**就得按会话 id 走——占位键会把新建会话的帧发到
/// 无人订阅的通道（实测）。这里统一以 sid 为键，
/// 调用方拿到的返回值即最终身份、无需换名。
///
/// 失败时会把 omp 写在 stderr 的原因接进错误（见 [`with_stderr_reason`]）。
pub async fn spawn_long_lived<R: tauri::Runtime>(
    app: &AppHandle<R>,
    map: RuntimeMap,
    opts: SpawnOpts,
) -> Result<(String, String, SessionMeta), crate::commands::CmdError> {
    let err = StderrBuf::default();
    match spawn_long_lived_inner(app, map, opts, &err).await {
        Ok(v) => Ok(v),
        Err(e) => {
            err.settle().await;
            Err(with_stderr_reason(e, &err))
        }
    }
}

async fn spawn_long_lived_inner<R: tauri::Runtime>(
    app: &AppHandle<R>,
    map: RuntimeMap,
    opts: SpawnOpts,
    err_buf: &StderrBuf,
) -> Result<(String, String, SessionMeta), crate::commands::CmdError> {
    let mut cmd = tokio::process::Command::new(&opts.bin);
    cmd.args(opts.args())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        // stderr 收进管道而不是丢掉：omp 起不来时**原因只写在 stderr**
        // （实测 `--model` / `--thinking` 取值非法 → `Error: Model "x" not found` 后立刻退出，
        // stdout 一帧都没有）。早先接 `Stdio::null()` 时，壳只能报「omp 进程意外退出」，
        // 真正的原因被扔掉了（用户实测：新建会话失败，看不出为什么）。
        .stderr(std::process::Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| cmd_err("SPAWN_FAILED", format!("启动 omp 失败：{e}"), None))?;

    // stderr 就地开一条采集（逐行、封顶 [`STDERR_KEEP_BYTES`]）——留给失败路径做诊断。
    // 成功路径不消费它，采集任务随进程退出自然结束（omp 常驻期间 stderr 通常无输出）。
    if let Some(se) = child.stderr.take() {
        err_buf.spawn_collect(se);
    }

    let mut stdin: ChildStdin = child.stdin.take().ok_or_else(|| {
        cmd_err("SPAWN_FAILED", spawn_fail_msg("无法接管 omp 的输入流（stdin）", &err_buf), None)
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        cmd_err("SPAWN_FAILED", spawn_fail_msg("无法接管 omp 的输出流（stdout）", &err_buf), None)
    })?;
    let reader = BufReader::new(stdout).lines();
    let (tx, rx) = mpsc::unbounded_channel::<String>();

    // 先做同步握手拿身份（30s 超时）
    let mut reader = reader;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    // 握手期间到达的帧先攒着，等 pump 起来后原序回放（见 pump 启动处的说明）
    let mut leftover: Vec<String> = Vec::new();
    loop {
        let line = tokio::time::timeout_at(deadline, reader.next_line())
            .await
            .map_err(|_| cmd_err("RPC_TIMEOUT", "等待 omp 就绪超时".into(), None))?
            .map_err(|e| cmd_err("RPC_IO", format!("读取 omp 输出失败：{e}"), None))?;
        match line {
            Some(l) if l.trim().is_empty() => continue,
            Some(l) => {
                let v: serde_json::Value = serde_json::from_str(l.trim()).unwrap_or_default();
                if v.get("type").and_then(|t| t.as_str()) == Some("ready") {
                    break;
                }
                leftover.push(l);
            }
            None => return Err(cmd_err("RPC_EOF", spawn_fail_msg("omp 在就绪前退出", err_buf), None)),
        }
    }
    {
        let s = &mut stdin;
        s.write_all(b"{\"id\":\"h-neg\",\"type\":\"negotiate_protocol\",\"protocolVersion\":2}\n")
            .await
            .map_err(|e| cmd_err("RPC_IO", format!("写入失败：{e}"), None))?;
        s.write_all(b"{\"id\":\"h-state\",\"type\":\"get_state\"}\n")
            .await
            .map_err(|e| cmd_err("RPC_IO", format!("写入失败：{e}"), None))?;
        // 子代理帧订阅：omp 默认 `"off"`，不主动开的话 task 工具跑子代理时壳侧一帧都收不到
        // （此前界面只有一个转圈的 task 行）。`"progress"` 转发 lifecycle + progress 两类。
        // 回包（成功 / 旧版不认此命令的失败）由 classify 的 Swallow 分支本地消化，不进前端。
        s.write_all(b"{\"id\":\"h-sub\",\"type\":\"set_subagent_subscription\",\"level\":\"progress\"}\n")
            .await
            .map_err(|e| cmd_err("RPC_IO", format!("写入失败：{e}"), None))?;
        // ask 对话框开关（V40）：omp 的 `ask` 工具默认退化为「每个问题一个 select + editor」，
        // 打开后走结构化 `ask` 帧（多问题 / 多选 / 推荐项 / 超时）——壳侧的多问题卡就是这个帧。
        // 回包同样走 Swallow；旧版 omp 不认这个命令，失败也静默。
        s.write_all(b"{\"id\":\"h-ask\",\"type\":\"set_ask_dialog\",\"enabled\":true}\n")
            .await
            .map_err(|e| cmd_err("RPC_IO", format!("写入失败：{e}"), None))?;
        s.flush().await.map_err(|e| cmd_err("RPC_IO", format!("写入失败：{e}"), None))?;
    }
    let (sid, sfile, meta) = loop {
        let line = tokio::time::timeout_at(deadline, reader.next_line())
            .await
            .map_err(|_| cmd_err("RPC_TIMEOUT", "等待 omp 状态超时".into(), None))?
            .map_err(|e| cmd_err("RPC_IO", format!("读取 omp 输出失败：{e}"), None))?;
        let Some(l) = line else {
            return Err(cmd_err("RPC_EOF", spawn_fail_msg("omp 在返回会话状态前退出", err_buf), None));
        };
        if l.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(l.trim()) else { continue };
        // 握手包里别的不只是噪声：omp 在 `get_state` 回包**之前**就把
        // `available_commands_update` 发出来了（实测帧序：ready → setWidget →
        // advisor_cost_changed → available_commands_update → negotiate 回包 → get_state 回包）。
        // 早先这里整条丢弃，于是前端永远收不到命令面，`/` 补全一个候选都不弹。
        // 现在按原序攒下、pump 起来后回放（不进会话流的东西由前端自己忽略）。
        if !(v.get("type").and_then(|t| t.as_str()) == Some("response")
            && v.get("id").and_then(|i| i.as_str()) == Some("h-state"))
        {
            leftover.push(l);
            continue;
        }
        if v.get("success").and_then(|s| s.as_bool()) != Some(true) {
            return Err(cmd_err(
                "RPC_STATE",
                format!("获取会话状态失败：{}", v.get("error").and_then(|e| e.as_str()).unwrap_or("")),
                None,
            ));
        }
        let d = v.get("data").cloned().unwrap_or_default();
        let sid = d.get("sessionId").and_then(|s| s.as_str()).map(|s| s.to_string());
        let sfile = d.get("sessionFile").and_then(|s| s.as_str()).map(|s| s.to_string());
        match (sid, sfile) {
            (Some(a), Some(b)) => break (a, b, SessionMeta::from_state(&d)),
            _ => return Err(cmd_err("RPC_STATE", "未拿到会话身份".into(), None)),
        }
    };

    // 先登记进程再起 pump：回放握手帧时会走 `update_meta`（命令面缓存等），
    // 快照里还没有这一条的话那些帧就白回了。
    let mut m = map.lock().await;
    // 同一会话的旧进程先杀（重复 open / 重开的竞态）；stdin 关闭等于进程退出（code 0）
    if let Some(old) = m.remove(&sid) {
        let _ = old.tx.send(String::new());
        let mut c = old.child;
        let _ = c.kill().await;
    }
    m.insert(
        sid.clone(),
        RunningChild {
            tx,
            child,
            meta: meta.clone(),
            cwd: opts.cwd.clone(),
            created_ms: chrono::Utc::now().timestamp_millis(),
            activity: Arc::new(SessionActivity::new()),
            session_file: Some(PathBuf::from(&sfile)),
        },
    );
    // pump 与回收判定共用同一份活动态（帧触达 / 状态更新都在泵里）
    let activity = m.get(&sid).map(|r| r.activity.clone()).unwrap();
    drop(m);

    // 启动后台 pump：stdin 写 + stdout 读分发（先把握手期间攒下的帧原序回放）。
    // 通道名与 map 查询键都用 **sid**（会话 id）：前端从订阅建立那一刻起听的永远是
    // `omp-*://<会话 id>`——用占位键会把新建会话的所有帧发到无人订阅的通道
    // （V34 探针实证：占位键通道收到全部帧、sid 通道一条都没有）。
    start_pump(
        app.clone(),
        map.clone(),
        sid.clone(),
        reader,
        stdin,
        rx,
        leftover,
        activity,
        Some(PathBuf::from(&sfile)),
    );

    // 开场真值快照：omp 的握手回包里已经有模型 / 思考档 / 上下文占用，但那份回包
    // **只在本地消化**（不进事件流），而前端建订阅后的那次 `get_session_runtime` 补拉
    // 会早于 spawn 完成（拉空）——不在这里补一发，打开旧会话后工具行上的模型与思考档
    // 就一直空着，直到用户手动切一次模型。前端建订阅通常早于握手完成（会话先选中、
    // spawn 要等 omp 起来），所以这一发能收到；真收不到也有那次补拉兜底。
    crate::remote::emit_serializable(app, &format!("omp-state://{sid}"), &meta);
    Ok((sid, sfile, meta))
}

/// `sid` = 会话 id：既是事件三通道（`omp-event` / `omp-status` / `omp-state`）的名字，
/// 也是 pump 内所有 map 查询（真值快照 / 命令面缓存 / 项目偏好回写）的键——
/// 与 map 的 key 解耦（create 的占位键会换名，见 [`spawn_long_lived`] 的说明）。
fn start_pump<R: tauri::Runtime>(
    app: AppHandle<R>,
    map: RuntimeMap,
    sid: String,
    mut reader: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    mut stdin: ChildStdin,
    mut rx: mpsc::UnboundedReceiver<String>,
    leftover: Vec<String>,
    activity: Arc<SessionActivity>,
    session_file: Option<PathBuf>,
) {
    let evt = format!("omp-event://{sid}");
    let status = format!("omp-status://{sid}");
    tauri::async_runtime::spawn(async move {
        let mut asm = ChunkAsm::default();
        let mut pending: std::collections::VecDeque<String> = Default::default();
        // 壳侧补标题的会话内状态（详见 [`AutoTitleState`] 与 [`maybe_auto_title`]）
        let mut auto_title = AutoTitleState::default();
        // 运行中上下文回读的节流时钟（见 [`SyncClock`]）
        let mut sync_clock = SyncClock::default();
        // 状态：idle 起
        emit_status(&app, &status, &activity, "idle", None);
        // 握手期间攒下的帧（命令面 / 单向宿主指令）按原序补发：
        // 它们到得比订阅早，不补发就等于永久丢失（`/` 补全没有数据源就是这个原因）。
        {
            for line in leftover {
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }
                let v: serde_json::Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let full = if v.get("type").and_then(|t| t.as_str()) == Some("rpc_chunk") {
                    match asm.feed(&v) {
                        Some(full) => full,
                        None => continue,
                    }
                } else {
                    v
                };
                handle_frame(&app, &sid, &evt, &status, &full, &mut stdin, &activity, &mut auto_title, &mut sync_clock, session_file.as_deref()).await;
            }
        }
        // resume 的旧会话（已有用户消息、还没有标题）在进程起来时就补一次标题——
        // 不必等下一轮对话；新会话此刻还没有用户消息，等它第一条消息到达再补
        //（见 handle_frame 里的 is_user_message_frame 触发，详见 maybe_auto_title）。
        maybe_auto_title(session_file.as_deref(), &mut stdin, &mut auto_title).await;
        let failure = 'pump: loop {
            tokio::select! {
                w = rx.recv() => {
                    match w {
                        Some(line) if line.is_empty() => break None, // kill 哨兵
                        Some(line) => { pending.push_back(line); }
                        None => break None,
                    }
                    while let Some(l) = pending.pop_front() {
                        if let Err(e) = stdin.write_all(l.as_bytes()).await {
                            break 'pump Some(("error", format!("写入失败：{e}")));
                        }
                    }
                    let _ = stdin.flush().await;
                }
                r = reader.next_line() => {
                    match r {
                        Ok(Some(line)) => {
                            let line = line.trim().to_string();
                            if line.is_empty() { continue; }
                            // 任何一帧都算活动（闲置回收的触达点）：running 的会话
                            // 一直在推帧，天然不会被回收；真闲下来的会话才开始计时。
                            activity.touch();
                            let v: serde_json::Value = match serde_json::from_str(&line) {
                                Ok(v) => v,
                                Err(_) => continue, // 坏行跳过记日志（M4 补日志通道）
                            };
                            // 分片帧先重组
                            let full = if v.get("type").and_then(|t| t.as_str()) == Some("rpc_chunk") {
                                match asm.feed(&v) {
                                    Some(full) => full,
                                    None => continue,
                                }
                            } else {
                                v
                            };
                            handle_frame(&app, &sid, &evt, &status, &full, &mut stdin, &activity, &mut auto_title, &mut sync_clock, session_file.as_deref()).await;
                        }
                        _ => {
                            break Some(("exited", "omp 进程已退出".to_string()));
                        }
                    }
                }
            }
        };
        if let Some((state, detail)) = failure {
            // 先关闭接收端，阻止新请求投递到已经失效的泵。
            rx.close();
            let mut running = map.lock().await;
            // 同一 sid 可能已由新进程接管；活动态对象是进程实例的唯一身份。
            if running.get(&sid).is_some_and(|r| Arc::ptr_eq(&r.activity, &activity)) {
                emit_status(&app, &status, &activity, state, Some(&detail));
                if let Some(old) = running.get_mut(&sid) {
                    // stdout 关闭不保证子进程已退出；无法确认退出时保留失效表项供重试。
                    if stop_failed_child(old).await.is_ok() {
                        running.remove(&sid);
                    }
                }
            }
        }
    });
}

/// 状态回读回包的固定 id（pump 自发自收，不暴露给前端）。
const STATE_SYNC_ID: &str = "sync-state";

/// 运行中回读 `get_state` 的最小间隔：omp 只在 `get_state` 回包里给 `contextUsage`，
/// 长任务里一轮能跑很多步——每步（assistant 消息收尾）都问一次会白烧 RPC，2s 一档
/// 足够让输入卡上的占用百分比跟着涨（口径见 [`midrun_sync_due`]）。
const CONTEXT_SYNC_MIN_MS: i64 = 2_000;

/// 运行中的 `get_state` 回读节流时钟（pump 内状态，跨帧持续）。
#[derive(Default)]
struct SyncClock {
    last_ms: i64,
}

/// 运行中要不要补一发 `get_state`（纯函数，单测锁着口径）：
/// 只在「这一轮在跑」且距上次回读 ≥ [`CONTEXT_SYNC_MIN_MS`] 时才发——
/// 等审批 / 空闲时没有新步数，回读没有增量；收尾那发由终态路径负责。
fn midrun_sync_due(act: u8, now_ms: i64, last_ms: i64) -> bool {
    act == ACT_RUNNING && now_ms - last_ms >= CONTEXT_SYNC_MIN_MS
}

/// 构造一行 JSONL 命令；`extra` 为对象时并入顶层字段。
fn jsonl_line(id: &str, ty: &str, extra: serde_json::Value) -> Option<String> {
    let mut o = serde_json::Map::new();
    o.insert("id".into(), serde_json::Value::String(id.to_string()));
    o.insert("type".into(), serde_json::Value::String(ty.to_string()));
    if let serde_json::Value::Object(m) = extra {
        for (k, v) in m {
            o.insert(k, v);
        }
    }
    Some(format!("{}\n", serde_json::Value::Object(o)))
}

/// 壳侧补标题（`/rename`）的自有 id：回包本地消化。
const AUTO_TITLE_ID: &str = "auto-title";

/// 会话内一次性补标题的状态。
#[derive(Default)]
struct AutoTitleState {
    /// 已经补过 / 已确认不用补（会话已有真标题）：本进程不再回头看。
    done: bool,
    /// `/rename` 已在路上：它随后的 command_output 收尾帧本地消化，不进消息流。
    pending: bool,
    /// 事件流里已经出现过用户消息帧（`message_start` role=user 等）：会话里已有可总结
    /// 的内容。jsonl 落盘会滞后于帧，此时文件里读不到首条用户消息，用它兜底。
    user_seen: bool,
}

/// 用户消息帧（`message_start` / `message_end` / `message`，role=user，且带文本块）：
/// 见到它就说明会话里已经有可总结的用户消息——补标题的最早时机（不等整轮跑完）。
/// 图片-only 消息不算：没有文本，omp 也生成不出标题（别触发无效注入）。
fn is_user_message_frame(v: &serde_json::Value) -> bool {
    if !matches!(
        v.get("type").and_then(|t| t.as_str()),
        Some("message_start") | Some("message_end") | Some("message")
    ) {
        return false;
    }
    let Some(m) = v.get("message") else { return false };
    if m.get("role").and_then(|r| r.as_str()) != Some("user") {
        return false;
    }
    m.get("content").and_then(|c| c.as_array()).is_some_and(|blocks| {
        blocks.iter().any(|b| {
            b.get("type").and_then(|t| t.as_str()) == Some("text")
                && b.get("text")
                    .and_then(|t| t.as_str())
                    .is_some_and(|t| !t.trim().is_empty())
        })
    })
}

/// 补标题该不该做：还没有任何真标题、且会话里已经有用户消息（jsonl 里读到，或事件流里
/// 见过用户消息帧——见 [`AutoTitleState::user_seen`]）。
fn needs_auto_title(head: &crate::session_scan::SessionHead, user_seen: bool) -> bool {
    head.title.trim().is_empty() && (head.first_user_text.is_some() || user_seen)
}

/// 壳侧补标题的收尾输出（omp `command_output` 帧文本，实测 18.10.3）：
/// 成功 = `Session renamed to …`、失败 = `Could not generate a session title …`、
/// 竞态 = `Session name not changed …`（补齐三种收尾都要本地消化）。
fn is_auto_title_output(text: &str) -> bool {
    text.starts_with("Session renamed to ")
        || auto_title_failed(text)
        || text.starts_with("Session name not changed")
}

/// 收尾输出是否代表「标题没生成出来」（消息太琐碎 / 注入时内容还没进 omp 会话）：
/// 是的话标题还空着，允许下个时机（终态 agent_end）再试一次；
/// 成功与「已有用户设置的名字」都不重试。
fn auto_title_failed(text: &str) -> bool {
    text.starts_with("Could not generate a session title")
}

/// 视情况替会话补一次标题。
///
/// **为什么需要**：omp 对 `--mode rpc-ui` 强制 `PI_NO_TITLE=1`（18.10.3 二进制实测：
/// `if (v.noTitle || v.mode === "rpc" || v.mode === "rpc-ui" || v.mode === "acp")`）——
/// 聊天形态会话永远不会自动获得标题（TUI 才有），此前壳侧只能靠前端首条消息的
/// 本地回退顶着，重启后侧栏就是「未命名会话 MM-DD」。
///
/// **怎么做**：会话已有用户消息却还没有标题时，注入**omp 原生命令** `/rename`（无参数 =
/// 由 omp 生成标题并写盘；实测后台执行——prompt 回包 0.5s 内返回、生成与写盘约 2s 后完成，
/// 不阻塞后续消息），壳侧不留本地覆盖；成功经 `session_info_update` 帧回灌前端，
/// 收尾输出本地消化（见 [`is_auto_title_output`]）。
///
/// **触发时机**（早到晚）：用户消息帧一到（`user_seen`，任务正在跑也能注入——`/` 开头在
/// omp 侧先过命令门，早于 streaming 判定，`/rename` 无参数又走后台执行，不插话、不排队）、
/// spawn 时（resume 的旧会话）、每次终态 agent_end（兜底重试）。补过就不再回头
/// （`AutoTitleState::done`）。
async fn maybe_auto_title(session_file: Option<&std::path::Path>, stdin: &mut ChildStdin, auto: &mut AutoTitleState) {
    if auto.done {
        return;
    }
    let Some(path) = session_file else { return };
    let head = crate::session_scan::parse_session_head(path);
    if !head.title.trim().is_empty() {
        // 已有真标题（如用户在顶部改过名）：本进程不用再看（省掉每次终态的头部读）
        auto.done = true;
        return;
    }
    if !needs_auto_title(&head, auto.user_seen) {
        // 还没有用户消息（新建会话 / 文件未落盘）：留着下个时机再看
        return;
    }
    let Some(line) = jsonl_line(AUTO_TITLE_ID, "prompt", serde_json::json!({"message": "/rename"})) else { return };
    auto.done = true;
    auto.pending = true;
    let _ = stdin.write_all(line.as_bytes()).await;
    let _ = stdin.flush().await;
}

/// 更新 map 中的真值快照。用 `try_lock`：pump 不阻塞命令路径，拿不到就跳过（下次回读会补）。
fn update_meta<R: tauri::Runtime>(app: &AppHandle<R>, key: &str, f: impl FnOnce(&mut SessionMeta)) {
    let map = app.state::<crate::commands::AppState>().runtime.clone();
    let guard = map.try_lock();
    if let Ok(mut m) = guard {
        if let Some(r) = m.get_mut(key) {
            f(&mut r.meta);
        }
    }
}

/// 更新快照并广播 `omp-state`（切模型这种会改前端读取字段的动作）。
/// `get_state` 回读路径有自己的一发；这里服务 `set_model` 的成功回包——不广播的话
/// 前端 `currentRuntime.fastModeSupported` 会停在旧模型，Fast 闪电要等下一次回读才更新。
fn update_meta_emit<R: tauri::Runtime>(
    app: &AppHandle<R>,
    key: &str,
    f: impl FnOnce(&mut SessionMeta),
) {
    let map = app.state::<crate::commands::AppState>().runtime.clone();
    let payload = {
        let guard = map.try_lock();
        match guard {
            Ok(mut m) => m.get_mut(key).map(|r| {
                f(&mut r.meta);
                serde_json::to_value(&r.meta).unwrap_or(serde_json::Value::Null)
            }),
            Err(_) => None,
        }
    };
    if let Some(p) = payload {
        crate::remote::emit_event(app, &format!("omp-state://{key}"), &p);
    }
}

/// `set_model` 的成功回包（切模型后要不要落思考档、落哪一档，只在这一帧上判定）。
fn is_set_model_ok(v: &serde_json::Value) -> bool {
    v.get("type").and_then(|t| t.as_str()) == Some("response")
        && v.get("command").and_then(|c| c.as_str()) == Some("set_model")
        && v.get("success").and_then(|s| s.as_bool()).unwrap_or(false)
}

/// 进程表里的**当前思考档真值**（切模型后的「档位是否仍然合法」判定用）。
/// 快照被别的路径占着（`try_lock` 失败）时返回 `None`——那就会走「落默认档」分支，
/// 与 omp 的静默忽略相比只是多设一次档，不出错。
fn current_thinking_level<R: tauri::Runtime>(app: &AppHandle<R>, key: &str) -> Option<String> {
    let map = app.state::<crate::commands::AppState>().runtime.clone();
    let guard = map.try_lock().ok()?;
    guard.get(key).and_then(|r| r.meta.thinking_level.clone())
}

/// 帧分类结果：状态回读 / 普通透传（附可选跟进命令）/ 本地消化。
#[derive(Debug, PartialEq)]
pub enum FrameAction {
    /// 状态回读回包：只更新真值快照 + 推送 `omp-state`，不进会话流
    StateSync,
    /// 透传给前端；`Some(line)` 表示还要追加写回 stdin 的跟进命令
    Forward(Option<String>),
    /// 壳侧内部管理命令的回包：本地消化，不进前端（用户没发起过这个动作，
    /// 成功无需展示，失败也只会变成一条莫名其妙的「操作失败」分隔线）。
    Swallow,
}

/// 判断一帧要不要跟进命令（纯函数，便于单测）。
///
/// 实测约束驱动此处逻辑（omp 18.10.3 rpc-ui）：
/// 1. 切模型时 omp **保留仍然合法的档位**、切到无思考模型直接丢档且不恢复 → 只有「档位缺失 /
///    对新模型非法」才由壳侧落**omp 配置的默认档**（见 [`auto_think_level`]），有效档不覆盖；
/// 2. `set_thinking_level` 对非法档也回 `success:true`（静默忽略）→ 只能靠 `get_state` 回读收敛 UI。
pub fn classify(
    v: &serde_json::Value,
    cur_level: Option<&str>,
    default_level: Option<&str>,
) -> FrameAction {
    if v.get("type").and_then(|t| t.as_str()) != Some("response") {
        return FrameAction::Forward(None);
    }
    let rid = v.get("id").and_then(|i| i.as_str()).unwrap_or("");
    if rid == STATE_SYNC_ID {
        return FrameAction::StateSync;
    }
    let cmd = v.get("command").and_then(|c| c.as_str()).unwrap_or("");
    let ok = v.get("success").and_then(|s| s.as_bool()).unwrap_or(false);
    match cmd {
        // 会话建立时壳侧自己发的订阅命令：回执本地消化（成功无展示价值；旧版 omp
        // 不认这个命令会回失败，同样不许把它渲染成用户可见的错误行）。
        "set_subagent_subscription" => FrameAction::Swallow,
        // 同上：ask 对话框开关（V40）由壳侧在 spawn 时打开，回执不进前端。
        "set_ask_dialog" => FrameAction::Swallow,
        "set_model" if ok => {
            let efforts = v.get("data").filter(|d| d.get("provider").is_some()).and_then(efforts_of);
            match auto_think_level(efforts.as_ref(), cur_level, default_level) {
                // 缺档：落 omp 默认档（其回包会带回读，见下面的 `set_thinking_level` 分支）
                Some(level) => FrameAction::Forward(jsonl_line(
                    "auto-think",
                    "set_thinking_level",
                    serde_json::json!({"level": level}),
                )),
                // 档位保留 / 无需落档：回读一次真值（无思考模型丢档、omp 静默改档都靠它收敛）
                None => FrameAction::Forward(jsonl_line(STATE_SYNC_ID, "get_state", serde_json::Value::Null)),
            }
        }
        // 切换失败也回读：纠正前端乐观态
        "set_model" | "set_thinking_level" => {
            FrameAction::Forward(jsonl_line(STATE_SYNC_ID, "get_state", serde_json::Value::Null))
        }
        _ => FrameAction::Forward(None),
    }
}

/// 单帧处理：按分类更新真值快照 / 注入跟进命令，再分发给前端。
async fn handle_frame<R: tauri::Runtime>(
    app: &AppHandle<R>,
    key: &str,
    evt: &str,
    status: &str,
    v: &serde_json::Value,
    stdin: &mut ChildStdin,
    activity: &SessionActivity,
    auto_title: &mut AutoTitleState,
    sync_clock: &mut SyncClock,
    session_file: Option<&std::path::Path>,
) {
    let frame_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if frame_type != "session_settled" {
        for probe_id in activity.observe_input_frame(v) {
            // 插话 / 排队可能被扩展同步消费而没有后续静止帧；回读静止真值可安全解除保护。
            if let Some(line) = jsonl_line(&probe_id, "get_state", serde_json::Value::Null) {
                let _ = stdin.write_all(line.as_bytes()).await;
                let _ = stdin.flush().await;
            }
        }
    }
    if frame_type == "response" && v.get("id").and_then(|v| v.as_str()).is_some_and(|id| id.starts_with(REAP_PROBE_PREFIX)) {
        return;
    }
    // 壳侧补标题自己的回包（[`maybe_auto_title`] 注入的 `/rename`）：本地消化
    // （成功无展示价值；失败也不该渲染成一条「操作失败」分隔线——那是后台动作）。
    if v.get("type").and_then(|t| t.as_str()) == Some("response")
        && v.get("id").and_then(|i| i.as_str()) == Some(AUTO_TITLE_ID)
    {
        return;
    }
    // 补标题的最早时机：用户消息一到就注入 `/rename`（无参数 = omp 生成标题）。
    // 任务正在跑也安全：`/` 开头在 omp 侧先过命令门（早于 streaming 判定），`/rename`
    // 无参数又走 `runCommandInBackground` 后台执行——不插话、不排队、不阻塞当前轮次。
    // 这样标题在任务运行中（而不是整轮结束）就生成出来，侧栏 / 顶栏不再挂「未命名会话」。
    if is_user_message_frame(v) {
        auto_title.user_seen = true;
        maybe_auto_title(session_file, stdin, auto_title).await;
    }
    if v.get("type").and_then(|t| t.as_str()) == Some("response") {
        // 切模型成功 = 唯一要做「思考档兜底」判定的帧：取当前档真值（进程表）+ omp 配置的
        // 默认档（一次 `omp config get`，只在切模型时发生，不进任何热路径）。
        let (cur_level, default_level) = if is_set_model_ok(v) {
            (
                current_thinking_level(app, key),
                crate::settings::read_default_thinking_level(&app.state::<crate::commands::AppState>()).await,
            )
        } else {
            (None, None)
        };
        match classify(v, cur_level.as_deref(), default_level.as_deref()) {
            FrameAction::Swallow => return,
            FrameAction::StateSync => {
                if v.get("success").and_then(|s| s.as_bool()).unwrap_or(false) {
                    let d = v.get("data").cloned().unwrap_or_default();
                    let mut meta = SessionMeta::from_state(&d);
                    update_meta(app, key, |m| {
                        // 用量 / 耗时 / 命令缓存来自事件流而非 get_state：回读时不能抹掉
                        meta.usage = m.usage.clone();
                        meta.duration_ms = m.duration_ms;
                        meta.ttft_ms = m.ttft_ms;
                        meta.commands = m.commands.clone();
                        *m = meta.clone();
                    });
                    let payload = serde_json::to_value(&meta).unwrap_or(serde_json::Value::Null);
                    crate::remote::emit_event(app, &format!("omp-state://{key}"), &payload);
                    // 真值顺带回写项目偏好：新建会话时沿用该项目上次的模型/思考档
                    let st = app.state::<crate::commands::AppState>();
                    let selector = meta.model.as_ref().map(|m| format!("{}/{}", m.provider, m.id));
                    crate::commands::remember_project_pref(&st, key, selector, meta.thinking_level.clone())
                        .await;
                }
                return;
            }
            FrameAction::Forward(inject) => {
                // set_model 回包的 data 即模型对象本身：先落真值（档位由随后的回读填）
                if v.get("command").and_then(|c| c.as_str()) == Some("set_model") {
                    if let Some(d) = v.get("data").filter(|d| d.get("provider").is_some()) {
                        let meta = SessionMeta::from_model(d);
                        // 同步广播：切模型时 Fast 支持 / 模型元数据要立刻到前端，不能等下一次回读
                        update_meta_emit(app, key, |m| {
                            m.model = meta.model;
                            m.efforts = meta.efforts;
                            m.fast_mode_supported = meta.fast_mode_supported;
                        });
                    }
                }
                if let Some(line) = inject {
                    let _ = stdin.write_all(line.as_bytes()).await;
                    let _ = stdin.flush().await;
                }
            }
        }
    }
    // 用量 / 耗时真值：assistant 消息结束时随 omp-state 推给前端（状态条纯透传的数据源）
    if v.get("type").and_then(|t| t.as_str()) == Some("message_end") {
        if let Some((usage, duration, ttft)) = v
            .get("message")
            .and_then(SessionMeta::usage_from_message_end)
        {
            // 使用统计的**壳侧账本**：这一轮的用量先记下来，会话以后被删掉统计也不会少
            // （扫描时按 responseId 与 jsonl 去重，见 usage.rs 模块头「壳侧账本」）。
            // 失败 / 重试的调用 usage 全 0 且没有 responseId：不记账（省假活跃日）。
            if let Some(m) = v.get("message") {
                let u = crate::usage::parse_usage(&m["usage"]);
                if u.total > 0 {
                    let rec = crate::usage::UsageRecord {
                        sid: key.to_string(),
                        response_id: m.get("responseId").and_then(|r| r.as_str()).unwrap_or("").to_string(),
                        ts_ms: m.get("timestamp").and_then(|t| t.as_i64()),
                        model: m.get("model").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                        usage: u,
                    };
                    let ledger = app.state::<crate::commands::AppState>().usage_ledger.clone();
                    // 走异步入口：首次记账要加载整个账本，同步读盘会把会话事件循环卡住。
                    // 记账失败（磁盘满 / 权限）只影响「已删除会话的补记」，不能拖累会话线程。
                    let _ = ledger.record_async(&rec).await;
                }
            }
            let map = app.state::<crate::commands::AppState>().runtime.clone();
            let payload = {
                let mut guard = map.lock().await;
                guard.get_mut(key).map(|r| {
                    if usage.is_some() {
                        r.meta.usage = usage;
                    }
                    if duration.is_some() {
                        r.meta.duration_ms = duration;
                    }
                    if ttft.is_some() {
                        r.meta.ttft_ms = ttft;
                    }
                    serde_json::to_value(&r.meta).unwrap_or(serde_json::Value::Null)
                })
            };
            if let Some(p) = payload {
                crate::remote::emit_event(app, &format!("omp-state://{key}"), &p);
            }
        }
        // 运行中跟住上下文占用：`message_end` = 一个 assistant 步收尾（工具循环的每一步），
        // 按 [`CONTEXT_SYNC_MIN_MS`] 节流补一发 `get_state`——不回读的话输入卡上的占用
        // 会一直停在「开轮那一刻」，长任务里百分比不动（收尾那发由终态路径负责）。
        let now = now_ms();
        if midrun_sync_due(activity.state(), now, sync_clock.last_ms) {
            if let Some(line) = jsonl_line(STATE_SYNC_ID, "get_state", serde_json::Value::Null) {
                if stdin.write_all(line.as_bytes()).await.is_ok() {
                    let _ = stdin.flush().await;
                    sync_clock.last_ms = now;
                }
            }
        }
    }
    // 一轮终了 / 会话静止回读状态：`contextUsage` 只出现在 get_state 回包里，不回读的话
    // 输入框工具行上的上下文占用会一直停在「打开会话那一刻」，压缩入口（≥80%）也就永远不触发。
    // 两个信号都认：终态 agent_end，以及 `session_settled`（「一切静止」的权威信号）——
    // 壳侧在运行中注入的后台标题生成会把本轮 agent_end 变成非终态（awaitingAsyncWork，
    // 实测 18.10.4），只认终态的话首轮结束的这次回读就被跳过了。
    let terminal_end = v.get("type").and_then(|t| t.as_str()) == Some("agent_end")
        && v.get("isTerminal").and_then(|b| b.as_bool()).unwrap_or(true);
    if terminal_end || v.get("type").and_then(|t| t.as_str()) == Some("session_settled") {
        if let Some(line) = jsonl_line(STATE_SYNC_ID, "get_state", serde_json::Value::Null) {
            let _ = stdin.write_all(line.as_bytes()).await;
            let _ = stdin.flush().await;
        }
        // 收尾也是补标题的兜底时机：用户消息帧触发的注入要是失败
        // （例如首条消息太琐碎、注入时内容还没进 omp 会话），在这里再试一次；
        // resume / fork 出来的会话也在此收敛（详见 [`maybe_auto_title`]）。
        maybe_auto_title(session_file, stdin, auto_title).await;
    }
    // 补标题的 command_output 收尾帧：成功（"Session renamed to …"）与失败
    // （"Could not generate a session title …"）都是壳侧后台动作的产物，不进消息流——
    // 标题变化本身由 `session_info_update` 帧带给前端即可。`pending` 只由收尾帧清零：
    // 实测帧序是 `session_info_update` 在前、command_output 在后，别提前清（会漏帧）。
    if auto_title.pending
        && v.get("type").and_then(|t| t.as_str()) == Some("command_output")
        && v.get("text").and_then(|t| t.as_str()).is_some_and(is_auto_title_output)
    {
        let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("");
        auto_title.pending = false;
        // 「生成不出来」：标题还空着，放回未完成态——本轮结束时兜底再试一次
        //（用户消息帧的注入赶在内容进入 omp 会话之前就会走到这里）。
        if auto_title_failed(text) {
            auto_title.done = false;
        }
        return;
    }
    dispatch(app, key, evt, status, v, activity);
    if frame_type == "session_settled" {
        // 先更新活动态再解除保护，避免两者之间被回收线程观察到错误快照。
        for probe_id in activity.observe_input_frame(v) {
            if let Some(line) = jsonl_line(&probe_id, "get_state", serde_json::Value::Null) {
                let _ = stdin.write_all(line.as_bytes()).await;
                let _ = stdin.flush().await;
            }
        }
    }
}

/// 状态串（[`emit_status`] 的调用口径）→ (活动态, 前端口径 state)。
///
/// `idle-awaiting` 是壳侧内部档（omp 的 `agent_end{isTerminal:false,
/// awaitingAsyncWork:true}`）：前端就是 `idle`（工作指示行收敛、输入框解锁，
/// 与 omp TUI 的 `y6("idle")` 同口径），活动态走 [`ACT_IDLE_AWAITING`]——
/// 闲置回收跳过它（后台完成可能注入 follow-up 唤醒会话）。
fn status_pair(state: &str) -> (u8, &'static str) {
    match state {
        "running" => (ACT_RUNNING, "running"),
        "awaiting-approval" => (ACT_AWAITING, "awaiting-approval"),
        "idle-awaiting" => (ACT_IDLE_AWAITING, "idle"),
        "idle" => (ACT_IDLE, "idle"),
        "error" => (ACT_EXITED, "error"),
        _ => (ACT_EXITED, "exited"),
    }
}

/// 状态唯一的出口：更新活动态（回收判定读它）+ 推 `omp-status://` 给前端。
/// `state` 取 [`status_pair`] 的口径（idle / idle-awaiting / running /
/// awaiting-approval / error / exited）；`error` / `exited` 都归入 [`ACT_EXITED`]。
fn emit_status<R: tauri::Runtime>(
    app: &AppHandle<R>,
    status_ch: &str,
    activity: &SessionActivity,
    state: &str,
    detail: Option<&str>,
) {
    let (act, ui_state) = status_pair(state);
    activity.state.store(act, Ordering::Relaxed);
    let mut payload = serde_json::json!({ "state": ui_state });
    if let Some(d) = detail {
        payload["detail"] = serde_json::Value::String(d.to_string());
    }
    crate::remote::emit_event(app, status_ch, &payload);
}

fn dispatch<R: tauri::Runtime>(
    app: &AppHandle<R>,
    key: &str,
    evt: &str,
    status: &str,
    v: &serde_json::Value,
    activity: &SessionActivity,
) {
    let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    match t {
        "agent_start" => {
            emit_status(app, status, activity, "running", None);
        }
        "agent_end" => {
            if let Some(state) = agent_end_status(v) {
                emit_status(app, status, activity, state, None);
            }
        }
        // 「会话安静」的权威信号（omp 的 `session_settled`：最后一次运行已 yield、
        // 无排队、无后台工作）。等后台完成的会话（`idle-awaiting`）在此收敛回
        // 可回收的 idle——否则它一直不进闲置回收（见 [`ACT_IDLE_AWAITING`]）。
        "session_settled" => {
            emit_status(app, status, activity, "idle", None);
            crate::remote::emit_event(app, evt, v);
        }
        // 本地命令完成信号（`prompt` 回包 `data.agentInvoked:false` 或后续
        // `prompt_result{agentInvoked:false}`）：没有 agent turn、不会有
        // `agent_end`，此处直接收敛到 idle，否则转圈停不下来。
        "response" if is_local_prompt_result(v) => {
            emit_status(app, status, activity, "idle", None);
            crate::remote::emit_event(app, evt, v);
        }
        "prompt_result" if !v.get("agentInvoked").and_then(|b| b.as_bool()).unwrap_or(true) => {
            emit_status(app, status, activity, "idle", None);
            crate::remote::emit_event(app, evt, v);
        }
        "command_output" | "notice" | "todo_reminder" | "irc_message" => {
            // 本地命令输出 / 单向通知 / 计划提醒：透传给前端渲染，不触碰运行状态。
            crate::remote::emit_event(app, evt, v);
        }
        "available_commands_update" => {
            // 可用命令面：缓存后透传，前端 `/` 补全的数据源。
            if let Some(cmds) = v.get("commands") {
                let cmds = cmds.clone();
                update_meta(app, key, |m| {
                    m.commands = Some(cmds.clone());
                });
            }
            crate::remote::emit_event(app, evt, v);
        }
        "auto_compaction_start" | "auto_compaction_end" | "auto_retry_start" | "auto_retry_end"
        | "retry_fallback_applied" | "retry_fallback_succeeded" | "subagent_lifecycle" | "subagent_progress"
        | "subagent_event" => {
            // 压缩 / 重试 / 子代理生命周期：透传给前端渲染成分隔线。
            crate::remote::emit_event(app, evt, v);
        }
        "extension_ui_request" => {
            // 需要用户回包的方法才会进「等待输入」状态（审批 + 通用 UI 请求）；
            // 单向方法（notify / setStatus / setWidget / setTitle / set_editor_text）
            // 与服务端撤回（cancel）都不是等待，别把 composer 锁住。
            let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("");
            if matches!(method, "select" | "confirm" | "input" | "editor") {
                emit_status(app, status, activity, "awaiting-approval", None);
            }
            crate::remote::emit_event(app, evt, v);
        }
        "response" | "message_start" | "message_update" | "message_end" | "turn_start" | "turn_end"
        | "tool_execution_start" | "tool_execution_update" | "tool_execution_end" | "model_changed"
        | "thinking_level_changed" | "title_change" => {
            crate::remote::emit_event(app, evt, v);
        }
        _ => {
            // 未知帧：透传 unknown 进日志不崩（前端忽略）
            crate::remote::emit_event(app, evt, v);
        }
    }
}

/// `agent_end` 该给什么状态（纯函数，便于单测）。
///
/// omp 18.10.3 的 agent_end 形状：终态 = `isTerminal:true`；「轮次已 yield、但还有
/// **后台完成投递**（job / supervised process 的收尾）可能注入 follow-up 唤醒会话」
/// = `isTerminal:false, awaitingAsyncWork:true`（二进制源码：`z({willContinue:true,
/// awaitingAsyncWork:true})`，判定 `#zn()` = hasPendingAsyncWork）。TUI 对后者
/// **直接显示 idle**（`t.isTerminal===false && t.awaitingAsyncWork===true → y6("idle")`），
/// 壳侧对齐——否则「任务已完成」的消息流会一直顶着「思考中…」，直到后台工作真来
/// 唤醒（或不唤醒），用户看到的就是「任务完成但永远在思考中」（2026-10-13 实测：
/// 带 supervised process 收尾的会话，如 browser 静态服务/launch 的后台完成）。
/// 其余非终态（还有排队 / 子代理在继续跑）保持 running，等后续 agent_start / 终态
/// agent_end；`session_settled` 是另一条兜底收敛路径（见 dispatch）。
fn agent_end_status(v: &serde_json::Value) -> Option<&'static str> {
    let terminal = v.get("isTerminal").and_then(|b| b.as_bool()).unwrap_or(true);
    if terminal {
        return Some("idle");
    }
    let awaiting = v.get("awaitingAsyncWork").and_then(|b| b.as_bool()).unwrap_or(false);
    if awaiting {
        return Some("idle-awaiting");
    }
    None
}

/// `prompt` 回包是否代表"本地收尾、无 agent turn"：
/// `command == "prompt" && success && data.agentInvoked == false`。
/// agent 真正开跑（`agentInvoked:true` / 缺字段）时不收敛，等后续 `agent_end`。
fn is_local_prompt_result(v: &serde_json::Value) -> bool {
    if v.get("command").and_then(|c| c.as_str()) != Some("prompt") {
        return false;
    }
    if v.get("success").and_then(|s| s.as_bool()) != Some(true) {
        return false;
    }
    v.get("data")
        .and_then(|d| d.get("agentInvoked"))
        .and_then(|b| b.as_bool())
        == Some(false)
}

/// base64 小实现（避免新增依赖）：仅用于 rpc_chunk data 段。
pub fn b64decode(s: &str) -> Option<Vec<u8>> {
    let mut out = vec![];
    let mut buf: u32 = 0;
    let mut bits = 0;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => return None,
        } as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8 & 0xff);
        }
    }
    Some(out)
}

/// base64 编码（不带换行）：图片附件读文件后用（`read_image_file`）。
/// 与 `b64decode` 成对，避免为一个方向新增依赖。
pub fn b64encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for c in data.chunks(3) {
        let b0 = c[0] as u32;
        let b1 = *c.get(1).unwrap_or(&0) as u32;
        let b2 = *c.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// 应用退出路径：收掉全部聊天会话进程。
///
/// 不等优雅窗口（应用马上要没了，延迟补刀跑不到）：发 kill 哨兵让 pump 退出，
/// 同时 `start_kill`（同步信号，不 await）直接终止子进程——stdin 关闭本来会让
/// omp 以 code 0 退出，这里只是不给它「还在写盘」的机会。
pub fn kill_all(map: &RuntimeMap) {
    if let Ok(mut m) = map.try_lock() {
        for (_, r) in m.drain() {
            let _ = r.tx.send(String::new());
            let mut child = r.child;
            let _ = child.start_kill();
        }
    }
}

/// 真实 omp 的 RPC 冒烟（慢测试，**默认忽略**）。
///
/// 跑法：`cargo test --manifest-path src-tauri/Cargo.toml -- --ignored real_rpc`
/// 依赖：本机装好 `omp`（PATH / Homebrew 常见路径；可用 `OMP_BIN` 覆盖）＋ 一次真实 AI 调用。
///
/// 验的是 `spawn_long_lived` 的**完整代码路径**（不是纯函数）：spawn → 握手（negotiate v2 /
/// get_state / 子代理订阅）→ pump 读流 → `message_end` 用量回写 → `agent_end` 触发的
/// `get_state` 回读落到 `context_usage`，外加事件面（omp-event / omp-status 真的能到监听端）。
/// mock app（`tauri::test`）提供 AppHandle，不需要真实窗口。
#[cfg(test)]
mod real_rpc_tests {
    use super::*;
    use tauri::{Listener, Manager};

    fn omp_bin() -> Option<String> {
        if let Ok(v) = std::env::var("OMP_BIN") {
            return Some(v);
        }
        if let Ok(path) = std::env::var("PATH") {
            for dir in path.split(':') {
                let p = std::path::Path::new(dir).join("omp");
                if p.is_file() {
                    return Some(p.to_string_lossy().to_string());
                }
            }
        }
        for c in ["/opt/homebrew/bin/omp", "/usr/local/bin/omp"] {
            if std::path::Path::new(c).is_file() {
                return Some(c.to_string());
            }
        }
        None
    }

    #[test]
    #[ignore = "慢测试：真实 omp + 一次真实 AI 调用"]
    fn real_rpc_prompt_roundtrip() {
        let Some(bin) = omp_bin() else {
            eprintln!("[real_rpc] 跳过：本机找不到 omp（可用 OMP_BIN 指定）");
            return;
        };
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app 构建失败");
        // 会话进程表必须用 `AppState.runtime` 那一份：pump 的 meta 更新与 message_end 用量回写
        // 都经 `app.state::<AppState>()` 取表——传一份自己的 map 进去会看着「什么都没发生」。
        let mut state = crate::commands::load_state(app.handle());
        let map = state.runtime.clone();
        // 使用统计账本换成测试自己的临时文件：**不许**往用户的应用数据目录里写（真实轮次会记账）
        let ledger_path = std::env::temp_dir()
            .join(format!("omp-rpc-it-ledger-{}", std::process::id()))
            .join("usage-ledger.jsonl");
        let ledger = crate::usage::UsageLedger::new(ledger_path.clone());
        state.usage_ledger = ledger.clone();
        app.manage(state);
        let handle = app.handle().clone();

        // 事件面：omp-event / omp-status 都挂监听（顺带验证 emit 路径真能到监听端）。
        // 收集走无界通道（回调里只需同步 send），不引锁。
        // 注意：通道名 = 会话 id，而 sid 要握手后才拿得到——订阅只能发生在 spawn 之后
        // （pump 启动即回放握手期攒下的帧，这一瞬的竞态帧不作为本测试的断言对象；
        // 前端那边有 `syncSessionRuntime` 的补拉兜底）。
        let (evt_tx, mut evt_rx) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
        let (st_tx, mut st_rx) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();

        let cwd = std::env::temp_dir().join(format!("omp-rpc-it-{}", std::process::id()));
        std::fs::create_dir_all(&cwd).unwrap();
        // 状态序列跨 block_on 收集（轮询里顺手抽干通道；终态断言在 kill 之后统一做）
        let mut sts: Vec<String> = vec![];
        // 事件帧同理：等窗里边收边记（帧面也是收敛条件之一，见下面的 while）
        let mut kinds: Vec<String> = vec![];
        let mut streamed = false;
        // 测试自己造的会话文件路径（收尾自清，别在用户的 sessions 目录里留垃圾）
        let mut sfile_out = String::new();

        tauri::async_runtime::block_on(async {
            let (sid, sfile, meta) = spawn_long_lived(
                &handle,
                map.clone(),
                SpawnOpts {
                    bin,
                    cwd: cwd.to_string_lossy().to_string(),
                    resume: None,
                    model: None,
                    thinking: None,
                    approval: None,
                },
            )
            .await
            .expect("握手失败");
            assert!(!sid.is_empty(), "应拿到 sessionId");
            sfile_out = sfile.clone();
            println!(
                "[real_rpc] 会话 {sid}（{sfile}）；模型 {:?}",
                meta.model.as_ref().map(|m| format!("{}/{}", m.provider, m.id))
            );
            // 拿到 sid 才订阅（通道名 = 会话 id；前端同口径）
            {
                let out = evt_tx.clone();
                handle.listen(format!("omp-event://{sid}").as_str(), move |e| {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(e.payload()) {
                        let _ = out.send(v);
                    }
                });
                let out = st_tx.clone();
                handle.listen(format!("omp-status://{sid}").as_str(), move |e| {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(e.payload()) {
                        let _ = out.send(v);
                    }
                });
            }

            let tx = map.lock().await.get(&sid).unwrap().tx.clone();
            tx.send("{\"id\":\"p-it\",\"type\":\"prompt\",\"message\":\"Reply with exactly: ok\"}\n".to_string())
                .unwrap();

            // 握手期 get_state 已带 contextUsage——先记基线，终态要求它被回读刷新过（真值变了）
            let initial_ctx_tokens = meta.context_usage.as_ref().and_then(|c| c.tokens);
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
            let mut usage_seen = false;
            let mut idle_seen = false;
            // 事件帧在等窗里边收边记（原来只在收尾一次性抽干）：帧面也是收敛条件的一部分——
            // 主模型失败（如 429 配额）时 omp 会换 fallback 模型重试，首轮 message_end 就带着
            // 用量与新上下文占用，若不等流式帧到场，收尾断言会跑在重试轮出流之前。
            while std::time::Instant::now() < deadline {
                while let Ok(v) = evt_rx.try_recv() {
                    let k = v.get("type").and_then(|t| t.as_str()).unwrap_or("").to_string();
                    if k == "message_update" {
                        streamed = true;
                    }
                    kinds.push(k);
                }
                // 状态面：omp-status 的终态 idle 由 pump 在 agent_end(isTerminal) 时推（帧本身不透传）
                while let Ok(v) = st_rx.try_recv() {
                    let state = v.get("state").and_then(|s| s.as_str()).unwrap_or("").to_string();
                    if state == "idle" {
                        idle_seen = true;
                    }
                    sts.push(state);
                }
                let (usage, ctx_tokens) = {
                    let m = map.lock().await;
                    let r = m.get(&sid);
                    (
                        r.map(|r| r.meta.usage.is_some()).unwrap_or(false),
                        r.and_then(|r| r.meta.context_usage.as_ref()).and_then(|c| c.tokens),
                    )
                };
                if usage {
                    usage_seen = true;
                }
                // 1) message_end 的用量回写 + 2) get_state 回读把 contextUsage 刷成新值（运行中每步也会回读，
                //    见 handle_frame 的 mid-run 分支）+ 3) 帧面真的流式过（断言对象先到场再收尾）
                if usage_seen && idle_seen && streamed && ctx_tokens.is_some() && ctx_tokens != initial_ctx_tokens {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            assert!(usage_seen, "120s 内没有等到 message_end 的用量回写");
            assert!(idle_seen, "120s 内状态没有回到 idle（agent_end 的收尾没跑）");

            // 收尾：kill 掉会话进程（与应用退出路径同一入口）
            kill_all(&map);
        });

        // 等窗结束后再把剩余帧收干净（等窗里已经收过一部分）
        while let Ok(v) = evt_rx.try_recv() {
            kinds.push(v.get("type").and_then(|t| t.as_str()).unwrap_or("").to_string());
        }
        println!("[real_rpc] 收到 {} 帧：{kinds:?}", kinds.len());
        // 真实帧面：流式 message_update + message_end 必须有；agent_start/agent_end **不透传**
        // 会话流（agent_end 只推状态 idle），别拿它当完成信号。
        assert!(kinds.iter().any(|k| k == "message_update"), "应收到 message_update 流式帧");
        assert!(kinds.iter().any(|k| k == "message_end"), "应收到 message_end");
        // 握手期回放的 available_commands_update：本测试的订阅发生在 spawn 之后
        // （通道名要先拿到 sid），回放帧到得比订阅早时收不到——不断言，仅记录；
        // 「握手回放必达」的覆盖在 recycle 测试的 resume 场景（订阅先于 spawn）。
        println!(
            "[real_rpc] 命令面回放帧（订阅竞态，仅供参考）：{}",
            kinds.iter().any(|k| k == "available_commands_update")
        );
        assert!(sts.iter().any(|s| s == "running"), "状态应经过 running：{sts:?}");
        assert!(sts.iter().any(|s| s == "idle"), "状态应回到 idle：{sts:?}");

        // 使用统计账本：真实轮次跑完必须落下一行，且那一行能被统计直接读回来
        // （字段口径 = `usage.rs` 的 UsageEvent；`responseId` / 时间戳 / 用量与 jsonl 同源）
        let lines: Vec<serde_json::Value> = std::fs::read_to_string(&ledger_path)
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        assert!(!lines.is_empty(), "真实轮次应往账本记至少一条：{}", ledger_path.display());
        let first = &lines[0];
        // sid 只能从账本读（闭包里的 sid 已出作用域）：它必须是**完整 uuid**（不许 8 字符前缀）
        let sid_in_ledger = first["sid"].as_str().unwrap_or("").to_string();
        assert_eq!(sid_in_ledger.len(), 36, "账本行的 sid = 本会话完整 uuid：{sid_in_ledger}");
        assert!(first["tsMs"].as_i64().unwrap_or(0) > 0, "账本行要带毫秒时间戳");
        assert!(first["usage"]["total"].as_u64().unwrap_or(0) > 0, "账本行要带真实用量");
        println!("[real_rpc] 账本落盘 {} 条；首条 = {first}", lines.len());
        // 统计侧读回来：会话 jsonl 目录不存在（= 会话已删）也照样给出这条用量
        let no_sessions = std::env::temp_dir().join(format!("omp-rpc-it-none-{}", std::process::id()));
        let stats = crate::usage::scan_usage_full(
            &no_sessions,
            None,
            chrono::Local::now(),
            Some(&ledger_path),
        );
        assert!(stats.totals.bucket.calls >= 1, "账本这几条应被统计读到");
        assert!(stats.totals.bucket.total >= first["usage"]["total"].as_u64().unwrap());
        assert!(stats.extras >= 1, "会话已删 → 算「本地记账」补上的那一条");
        // 幂等：同一条消息（同一 responseId）再记一次不写新行
        let before = lines.len();
        for line in &lines {
            ledger
                .record(&crate::usage::UsageRecord {
                    sid: line["sid"].as_str().unwrap_or("").to_string(),
                    response_id: line["responseId"].as_str().unwrap_or("").to_string(),
                    ts_ms: line["tsMs"].as_i64(),
                    model: line["model"].as_str().unwrap_or("").to_string(),
                    usage: crate::usage::parse_usage(&line["usage"]),
                })
                .unwrap();
        }
        let after = std::fs::read_to_string(&ledger_path).unwrap_or_default().lines().count();
        assert_eq!(after, before, "同一 responseId 重放不许写第二行");

        let _ = std::fs::remove_dir_all(ledger_path.parent().unwrap());
        while let Ok(v) = st_rx.try_recv() {
            sts.push(v.get("state").and_then(|s| s.as_str()).unwrap_or("").to_string());
        }
        println!("[real_rpc] 状态序列：{sts:?}");
        if !sfile_out.is_empty() {
            if let Some(dir) = std::path::Path::new(&sfile_out).parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
        let _ = std::fs::remove_dir_all(&cwd);
    }

    /// V34 回收 → 发送自动恢复的真实慢测试（**默认忽略**）。
    ///
    /// 验的是闲置回收之后用户直接发消息的完整链路：kill 长驻进程（与 reaper 同一入口
    /// `kill_runtime`）→ `send_message` 发现进程不在 → `spawn_session_runtime` resume
    /// 拉起 → 消息送达 → 新一轮事件流照常。
    #[test]
    #[ignore = "慢测试：真实 omp + 两次真实 AI 调用（回收与自动恢复）"]
    fn real_rpc_recycle_recover() {
        let Some(bin) = omp_bin() else {
            eprintln!("[real_rpc] 跳过：本机找不到 omp（可用 OMP_BIN 指定）");
            return;
        };
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app 构建失败");
        let state = crate::commands::load_state(app.handle());
        let map = state.runtime.clone();
        app.manage(state);
        let handle = app.handle().clone();

        let cwd = std::env::temp_dir().join(format!("omp-rpc-rc-{}", std::process::id()));
        std::fs::create_dir_all(&cwd).unwrap();
        // 测试自己造出来的会话文件（真实 agentDir 下、临时 cwd 的 slug 目录）：收尾连目录一起清
        let mut sfile_out = String::new();

        tauri::async_runtime::block_on(async {
            // send_message 的自动恢复走 `state.omp_path`（真实应用由健康检查落位），
            // 测试直接注入
            let st = handle.state::<crate::commands::AppState>();
            *st.omp_path.lock().await = Some(bin.clone());

            // 初起照 create_session 的口径：spawn 内部以会话 id 作 runtime 表的键
            // （拿到 sid 前并不知道它，但调用方与 pump 从此都用同一个键）
            let (sid, sfile, _meta) = spawn_long_lived(
                &handle,
                map.clone(),
                SpawnOpts {
                    bin: bin.clone(),
                    cwd: cwd.to_string_lossy().to_string(),
                    resume: None,
                    model: None,
                    thinking: None,
                    approval: None,
                },
            )
            .await
            .expect("握手失败");
            sfile_out = sfile.clone();
            // 前端订阅的是**真实 sid** 的通道（拿到 sid 之后才订阅）
            let (evt_tx, mut evt_rx) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
            handle.listen(format!("omp-event://{sid}").as_str(), move |e| {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(e.payload()) {
                    let _ = evt_tx.send(v);
                }
            });

            // 第一轮：真实 prompt，等 message_end 回写 + agent_end 收敛
            let tx = map.lock().await.get(&sid).unwrap().tx.clone();
            tx.send("{\"id\":\"p-rc1\",\"type\":\"prompt\",\"message\":\"Reply with exactly: ok\"}\n".to_string())
                .unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
            let mut first_frame = false;
            loop {
                assert!(std::time::Instant::now() < deadline, "第一轮 120s 没有等到 idle");
                while let Ok(v) = evt_rx.try_recv() {
                    if v.get("type").and_then(|t| t.as_str()) == Some("message_end") {
                        first_frame = true;
                    }
                }
                let (idle, used) = {
                    let m = map.lock().await;
                    let r = m.get(&sid);
                    (
                        r.map(|r| r.activity.state() == ACT_IDLE).unwrap_or(false),
                        r.map(|r| r.meta.usage.is_some()).unwrap_or(false),
                    )
                };
                if idle && used && first_frame {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            assert!(first_frame, "按生产时序（订阅真实 sid 通道）没有收到第一轮 message_end");

            // 等 jsonl 落盘：omp 懒写盘（首个 turn 之后才写文件，且有节流延迟），
            // 自动恢复靠它找文件。reaper 也有同样的 file 检查——没落盘的会话本就不会被回收。
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
            while !std::path::Path::new(&sfile).exists() && std::time::Instant::now() < deadline {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            }
            assert!(std::path::Path::new(&sfile).exists(), "60s 内 jsonl 没有落盘：{sfile}");

            // 模拟闲置回收：与 reaper 同一入口 kill（只在 idle 时回收）
            crate::commands::kill_runtime(&st, &sid);
            assert!(map.lock().await.get(&sid).is_none(), "回收后进程应从表里移除");

            // 清掉第一轮残留帧，避免第二轮把旧帧误判成新帧
            while evt_rx.try_recv().is_ok() {}

            // 用户直接发消息：应自动 resume 并成功（不是报 NOT_RUNNING）
            crate::commands::send_prompt(&handle, &st, &sid, "prompt", "Reply with exactly: ok".into(), None)
                .await
                .expect("回收后发送应自动恢复，不该失败");
            assert!(map.lock().await.get(&sid).is_some(), "发送后应自动 resume 出新进程");

            // 第二轮事件流照常（新一轮 message_end；resume 新进程启动时的握手回放帧
            // 也应到达——订阅在本轮 spawn 之前就已建立，这是「回放必达」的可确定时序）
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
            let mut second = false;
            let mut replay = false;
            while std::time::Instant::now() < deadline {
                while let Ok(v) = evt_rx.try_recv() {
                    match v.get("type").and_then(|t| t.as_str()) {
                        Some("message_end") => second = true,
                        Some("available_commands_update") => replay = true,
                        _ => {}
                    }
                }
                if second && replay {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            assert!(second, "恢复后 120s 内没有等到新一轮 message_end");
            assert!(replay, "resume 进程的握手回放帧没有到达 sid 通道");

            kill_all(&map);
        });
        // 清理测试自己造出来的会话文件（临时 cwd 的 slug 目录整个删——含隐藏的 .lock 文件；
        // 不清的话每次跑慢测试都会在用户的「未归属会话」里留一行）
        if !sfile_out.is_empty() {
            if let Some(dir) = std::path::Path::new(&sfile_out).parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
        let _ = std::fs::remove_dir_all(&cwd);
    }

    /// 壳侧补标题（V44）的真实慢测试（**默认忽略**）。
    ///
    /// 验的是完整链路与**时机**：rpc-ui 下 omp 关闭自动标题（PI_NO_TITLE=1）→ pump 在
    /// **用户消息帧一到**就注入 `/rename`（不等整轮跑完；无参数 = 由 omp 生成）→ omp 在
    /// **任务运行中**生成标题并写盘 → `session_info_update` 帧到前端通道、且
    /// `command_output` 收尾帧被本地消化（不进消息流）、`/rename` 本身没被当成会话消息。
    #[test]
    #[ignore = "慢测试：真实 omp + 两次真实 AI 调用（首轮 + 生成标题）"]
    fn real_rpc_auto_title() {
        let Some(bin) = omp_bin() else {
            eprintln!("[real_rpc] 跳过：本机找不到 omp（可用 OMP_BIN 指定）");
            return;
        };
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app 构建失败");
        let state = crate::commands::load_state(app.handle());
        let map = state.runtime.clone();
        app.manage(state);
        let handle = app.handle().clone();

        let cwd = std::env::temp_dir().join(format!("omp-rpc-at-{}", std::process::id()));
        std::fs::create_dir_all(&cwd).unwrap();

        let mut sfile_out = String::new();
        tauri::async_runtime::block_on(async {
            let (sid, sfile, meta0) = spawn_long_lived(
                &handle,
                map.clone(),
                SpawnOpts {
                    bin: bin.clone(),
                    cwd: cwd.to_string_lossy().to_string(),
                    resume: None,
                    model: None,
                    thinking: None,
                    approval: None,
                },
            )
            .await
            .expect("握手失败");
            sfile_out = sfile.clone();

            // 生产时序：订阅真实 sid 的通道之后才发消息（标题帧必须到得了订阅端）
            let (evt_tx, mut evt_rx) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
            handle.listen(format!("omp-event://{sid}").as_str(), move |e| {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(e.payload()) {
                    let _ = evt_tx.send(v);
                }
            });
            // 运行状态通道（pump 推 running / idle）：用来证明标题是在**任务运行中**生成的
            let (st_tx, mut st_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
            handle.listen(format!("omp-status://{sid}").as_str(), move |e| {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(e.payload()) {
                    if let Some(s) = v.get("state").and_then(|s| s.as_str()) {
                        let _ = st_tx.send(s.to_string());
                    }
                }
            });

            // 首条消息 = 一个真实的长任务：标题必须在它跑完之前就生成出来
            //（用户诉求：收到任务的同时就生成标题，运行期别一直挂「未命名会话」）。
            let tx = map.lock().await.get(&sid).unwrap().tx.clone();
            tx.send("{\"id\":\"p-at\",\"type\":\"prompt\",\"message\":\"请在前台运行命令 `sleep 15`（不要放后台），等它结束后用一句话说明执行结果\"}\n".to_string())
                .unwrap();

            // 等：jsonl 出现真标题（壳侧补的）+ 事件通道看到 session_info_update
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180);
            let t0 = std::time::Instant::now();
            // 帧时间线（诊断用；`--nocapture` 才可见）：流式增量帧只计数，其余逐条记
            let mut timeline: Vec<String> = Vec::new();
            let mut update_frames = 0usize;
            let mut title = String::new();
            let mut info_frame: Option<String> = None;
            let mut title_state: Option<String> = None;
            let mut leaked_output = false;
            let mut leaked_steer = false;
            let mut last_state = String::new();
            // 「轮次自然收尾」的判据：终态 agent_end，或注入的后台标题生成带来的
            // `agent_end{awaitingAsyncWork}` 之后的 `session_settled`（实测 18.10.4：
            // 运行中注入 `/rename` 会让本轮的 agent_end 变非终态，omp 随后发
            // session_settled 收敛）。
            let mut settled = false;
            while std::time::Instant::now() < deadline {
                while let Ok(s) = st_rx.try_recv() {
                    timeline.push(format!("{:>7}ms [status] {s}", t0.elapsed().as_millis()));
                    last_state = s;
                }
                while let Ok(v) = evt_rx.try_recv() {
                    let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if ty == "message_update" {
                        update_frames += 1;
                    } else if timeline.len() < 300 {
                        let extra = match ty {
                            "agent_end" => format!(
                                " terminal={:?} awaiting={:?}",
                                v.get("isTerminal"),
                                v.get("awaitingAsyncWork")
                            ),
                            "command_output" => format!(
                                " text={:?}",
                                v.get("text").and_then(|t| t.as_str()).unwrap_or("")
                            ),
                            "tool_execution_start" => format!(
                                " tool={:?}",
                                v.get("toolName").and_then(|t| t.as_str()).unwrap_or("")
                            ),
                            "session_info_update" => format!(
                                " title={:?}",
                                v.get("title").and_then(|t| t.as_str()).unwrap_or("")
                            ),
                            _ => String::new(),
                        };
                        timeline.push(format!("{:>7}ms {ty}{extra}", t0.elapsed().as_millis()));
                    }
                    if ty == "session_info_update" && info_frame.is_none() {
                        info_frame = v.get("title").and_then(|t| t.as_str()).map(str::to_string);
                        title_state = Some(last_state.clone());
                    }
                    if ty == "session_settled"
                        || (ty == "agent_end"
                            && v.get("isTerminal").and_then(|b| b.as_bool()).unwrap_or(true))
                    {
                        settled = true;
                    }
                    // 补标题的收尾输出不许进消息流（本地消化）
                    if ty == "command_output"
                        && v.get("text").and_then(|t| t.as_str()).is_some_and(is_auto_title_output)
                    {
                        leaked_output = true;
                    }
                    // 注入的 `/rename` 不许变成用户消息（那不叫补标题，叫插话）
                    if (ty == "message_start" || ty == "message_end" || ty == "message")
                        && v
                            .get("message")
                            .and_then(|m| m.get("role"))
                            .and_then(|r| r.as_str())
                            == Some("user")
                        && v.to_string().contains("/rename")
                    {
                        leaked_steer = true;
                    }
                }
                title = crate::session_scan::parse_session_head(std::path::Path::new(&sfile)).title;
                // 标题先到、轮次也要自然收尾（注入不许打断任务）
                if !title.is_empty() && info_frame.is_some() && settled {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            println!("[real_rpc] 补标题结果：jsonl={title:?} 帧={info_frame:?} 帧到达时状态={title_state:?} 收尾={settled}");
            println!("[real_rpc] 帧时间线（message_update 共 {update_frames} 条）：");
            for line in &timeline {
                println!("[real_rpc]   {line}");
            }
            assert!(!title.is_empty(), "180s 内会话标题仍为空（pump 的 /rename 注入或 omp 生成没生效）");
            assert_eq!(
                info_frame.as_deref(),
                Some(title.as_str()),
                "session_info_update 帧应带着新标题到达前端通道"
            );
            assert!(!leaked_output, "补标题的 command_output 收尾帧应被本地消化，不能进消息流");
            assert!(!leaked_steer, "注入的 /rename 不许作为用户消息进入会话");
            assert_eq!(
                title_state.as_deref(),
                Some("running"),
                "标题应在任务运行中（状态收敛 idle 以前）生成——收到任务的同时补，而不是整轮跑完才补"
            );
            assert!(settled, "注入 /rename 后任务应自然收尾（session_settled / 终态 agent_end——注入不能打断轮次）");
            // 回读挂点：注入的后台标题生成把本轮 agent_end 变非终态，首轮的 get_state 回读
            // 必须发生在 `session_settled` 上——否则上下文占用停在「打开会话那一刻」。
            // 回读是异步往返，等它落到快照（最多 5s）。
            let before = meta0.context_usage.as_ref().and_then(|c| c.tokens);
            let mut after: Option<i64> = None;
            for _ in 0..25 {
                let m = map.lock().await.get(&sid).unwrap().meta.clone();
                let now = m.context_usage.as_ref().and_then(|c| c.tokens);
                let fresh = matches!((before, now), (Some(b), Some(n)) if n > b)
                    || (before.is_none() && now.is_some());
                if fresh {
                    after = now;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            println!("[real_rpc] 上下文占用：握手={before:?} 收尾后={after:?}");
            assert!(
                after.is_some(),
                "收尾后应回读过 get_state——contextUsage 应反映本轮内容（大于握手时）"
            );

            kill_all(&map);
        });
        // 清理测试自己造出来的会话文件（临时 cwd 的 slug 目录整个删——含隐藏的 .lock 文件）
        if !sfile_out.is_empty() {
            if let Some(dir) = std::path::Path::new(&sfile_out).parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
        let _ = std::fs::remove_dir_all(&cwd);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stderr_note_folds_lines() {
        // 单行：原样；多行：首行 + 括号里的其余行（诊断信息不丢）
        assert_eq!(combine_note("Model \"x\" not found".into(), String::new()), "Model \"x\" not found");
        assert_eq!(
            combine_note("Model \"x\" not found".into(), "Run `omp models` to list all.".into()),
            "Model \"x\" not found（Run `omp models` to list all.）"
        );
    }

    /// 起不来的 omp：原因只写在 stderr，stdout 一帧都没有。
    ///
    /// 现场（用户实测）：覆盖层里留着上游已删除的模型，`omp --model <它>` 在 ready 之前就退出，
    /// 壳原先接 `Stdio::null()` 只能报「omp 进程意外退出」——真正的原因全丢了。
    /// 这里用假 omp 复现同一条路径，断言壳把 stderr 带了出来。
    #[tokio::test]
    async fn spawn_failure_surfaces_stderr_reason() {
        let dir = std::env::temp_dir().join(format!("omp-inn-rt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("fake-omp.sh");
        std::fs::write(
            &bin,
            "#!/bin/sh\necho 'Error: Model \"nope/x\" not found' 1>&2\necho 'Run `omp models find <pattern>` to search' 1>&2\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app 构建失败");
        let state = crate::commands::load_state(app.handle());
        let map = state.runtime.clone();
        app.manage(state);

        let e = spawn_long_lived(
            app.handle(),
            map,
            SpawnOpts {
                bin: bin.to_string_lossy().to_string(),
                cwd: dir.to_string_lossy().to_string(),
                resume: None,
                model: Some("nope/x".into()),
                thinking: None,
                approval: None,
            },
        )
        .await
        .expect_err("假 omp 立刻退出，不该握手成功");
        println!("[stderr-reason] {}", e.message);
        assert!(
            e.message.contains("Model \"nope/x\" not found"),
            "错误里必须带上 omp 自己写的原因，实际：{}",
            e.message
        );
        // 第二行（提示）进 hint，别把首行消息撑长
        assert_eq!(e.hint.as_deref(), Some("Run `omp models find <pattern>` to search"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn b64encode_roundtrip() {
        // 与解码器互为逆运算（含 padding 的三种长度）
        for raw in [b"".as_slice(), b"a", b"ab", b"abc", b"\x00\xff\x10\x20"] {
            let enc = b64encode(raw);
            assert_eq!(b64decode(&enc).unwrap(), raw.to_vec(), "roundtrip 失败: {enc}");
        }
        assert_eq!(b64encode(b"hello world"), "aGVsbG8gd29ybGQ=");
        assert_eq!(b64encode(&[0xff, 0xd8, 0xff]), "/9j/");
    }

    #[test]
    fn chunk_reassemble_roundtrip() {
        // "hello world" 的 base64 切两片
        let full = serde_json::json!({"type":"response","id":"x"});
        let raw = serde_json::to_string(&full).unwrap();
        let b64chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        // 简单用自带编码
        let enc = {
            let bytes = raw.as_bytes();
            let mut s = String::new();
            let mut i = 0;
            while i < bytes.len() {
                let b0 = bytes[i] as u32;
                let b1 = *bytes.get(i + 1).unwrap_or(&0) as u32;
                let b2 = *bytes.get(i + 2).unwrap_or(&0) as u32;
                let n = (b0 << 16) | (b1 << 8) | b2;
                s.push(b64chars.chars().nth(((n >> 18) & 63) as usize).unwrap());
                s.push(b64chars.chars().nth(((n >> 12) & 63) as usize).unwrap());
                s.push(if i + 1 < bytes.len() { b64chars.chars().nth(((n >> 6) & 63) as usize).unwrap() } else { '=' });
                s.push(if i + 2 < bytes.len() { b64chars.chars().nth((n & 63) as usize).unwrap() } else { '=' });
                i += 3;
            }
            s
        };
        let mid = enc.len() / 2;
        let mut asm = ChunkAsm::default();
        assert!(asm.feed(&serde_json::json!({"type":"rpc_chunk","chunkId":"c1","index":1,"count":2,"byteLength":enc.len(),"data":&enc[mid..]})).is_none());
        // 乱序第二片先到：上面先喂了 index1，再喂 index0 应完成
        let done = asm.feed(&serde_json::json!({"type":"rpc_chunk","chunkId":"c1","index":0,"count":2,"byteLength":enc.len(),"data":&enc[..mid]}));
        assert!(done.is_some());
        assert_eq!(done.unwrap(), full);
    }

    #[test]
    fn b64decode_works() {
        assert_eq!(b64decode("aGk=").unwrap(), b"hi");
    }

    // ---------- 壳侧补标题（V44）：rpc-ui 下 omp 自动标题被上游关闭（PI_NO_TITLE=1） ----------

    fn head_of(title: &str, first_user_text: Option<&str>) -> crate::session_scan::SessionHead {
        crate::session_scan::SessionHead {
            id: "s1".into(),
            cwd: "/tmp".into(),
            timestamp: 0,
            title: title.into(),
            first_user_text: first_user_text.map(str::to_string),
            file: String::new(),
            corrupt: false,
        }
    }

    #[test]
    fn auto_title_needs_titleless_session_with_user_message() {
        assert!(needs_auto_title(&head_of("", Some("帮我重构登录页")), false));
        assert!(
            needs_auto_title(&head_of("", None), true),
            "jsonl 还没落盘首条用户消息，但事件流里已见到用户消息帧：照样补（收到任务同时生成标题）"
        );
        assert!(!needs_auto_title(&head_of("真标题", Some("帮我重构登录页")), false), "已有真标题不再补");
        assert!(!needs_auto_title(&head_of("真标题", None), true), "已有真标题不再补（哪怕见过用户消息帧）");
        assert!(!needs_auto_title(&head_of("", None), false), "还没有用户消息不补（新会话 / 文件未落盘）");
    }

    /// 用户消息帧的判据：`message_start` / `message_end` / `message` + role=user + 文本块；
    /// 助手 / 工具结果 / 图片-only / 其它帧都不算。
    #[test]
    fn auto_title_detects_user_message_frames() {
        assert!(is_user_message_frame(&serde_json::json!({
            "type": "message_start",
            "message": { "role": "user", "content": [{ "type": "text", "text": "帮我重构登录页" }] }
        })));
        assert!(is_user_message_frame(&serde_json::json!({
            "type": "message_end",
            "message": { "role": "user", "content": [{ "type": "text", "text": "  总结  " }] }
        })));
        assert!(is_user_message_frame(&serde_json::json!({
            "type": "message",
            "message": { "role": "user", "content": [{ "type": "image", "data": "x" }, { "type": "text", "text": "看这张图" }] }
        })));
        assert!(!is_user_message_frame(&serde_json::json!({
            "type": "message_start",
            "message": { "role": "user", "content": [{ "type": "image", "data": "x" }] }
        })), "图片-only 消息没有可总结文本，别触发无效注入");
        assert!(!is_user_message_frame(&serde_json::json!({
            "type": "message_start",
            "message": { "role": "user", "content": [] }
        })));
        assert!(!is_user_message_frame(&serde_json::json!({
            "type": "message_start",
            "message": { "role": "assistant", "content": [{ "type": "text", "text": "好的" }] }
        })));
        assert!(!is_user_message_frame(&serde_json::json!({
            "type": "message_end",
            "message": { "role": "toolResult", "toolCallId": "t1" }
        })));
        assert!(!is_user_message_frame(&serde_json::json!({ "type": "agent_end", "isTerminal": true })));
        assert!(!is_user_message_frame(&serde_json::json!({ "type": "message_start" })));
    }

    /// 补标题的收尾输出（实测 18.10.3）：成功 / 失败 / 竞态三条 command_output 都要本地消化，
    /// 别的命令输出不许误伤。
    #[test]
    fn auto_title_output_matching() {
        assert!(is_auto_title_output("Session renamed to 修复登录页."));
        assert!(is_auto_title_output("Could not generate a session title. Use /rename <title> to set one."));
        assert!(is_auto_title_output("Session name not changed (a user-set name takes precedence)."));
        assert!(!is_auto_title_output("Advisor is enabled (openai/gpt-5.6)."));
        // 生成失败才允许兜底重试；成功与「已有用户设置的名字」都不回头
        assert!(auto_title_failed("Could not generate a session title. Use /rename <title> to set one."));
        assert!(!auto_title_failed("Session renamed to 修复登录页."));
        assert!(!auto_title_failed("Session name not changed (a user-set name takes precedence)."));
    }

    /// `/rename`（无参数 = 由 omp 生成标题并写盘）的注入帧形状。
    #[test]
    fn auto_title_prompt_frame_shape() {
        let line = jsonl_line(AUTO_TITLE_ID, "prompt", serde_json::json!({"message": "/rename"})).unwrap();
        let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["type"], "prompt");
        assert_eq!(v["id"], AUTO_TITLE_ID);
        assert_eq!(v["message"], "/rename");
    }

    fn opus() -> serde_json::Value {
        serde_json::json!({
            "provider": "commandcode",
            "id": "claude-opus-5",
            "name": "Claude Opus 5",
            "thinking": { "mode": "anthropic-adaptive", "efforts": ["low","medium","high","xhigh","max"], "supportsDisplay": true }
        })
    }

    /// 状态条数据源：上下文占用来自 get_state，用量/毫秒耗时来自 message_end（结构照抄真实会话 jsonl）。
    #[test]
    fn usage_and_context_parsed_from_frames() {
        let d = serde_json::json!({
            "model": opus(),
            "thinkingLevel": "high",
            // percent 是 0–100 的百分比（真机 18.2.1 实测 28529/1000000 → 2.8529）
            "contextUsage": { "tokens": 22678, "contextWindow": 1000000, "percent": 2.2678 }
        });
        let m = SessionMeta::from_state(&d);
        let cu = m.context_usage.as_ref().expect("contextUsage 应被解析");
        assert_eq!(cu.tokens, Some(22678));
        assert_eq!(cu.context_window, Some(1000000));
        assert!((cu.percent.unwrap_or_default() - 2.2678).abs() < 1e-9);

        let msg = serde_json::json!({
            "role": "assistant",
            "usage": {
                "input": 232, "output": 302, "totalTokens": 22678,
                "cacheRead": 22144, "reasoningTokens": 181,
                "cost": { "input": 0.0000348, "output": 0.00018, "total": 0.00028 }
            },
            "duration": 2843.68,
            "ttft": 855.7
        });
        let (usage, dur, ttft) = SessionMeta::usage_from_message_end(&msg).expect("assistant 消息应被提取");
        let usage = usage.expect("usage 应被解析");
        assert_eq!(usage.total_tokens, Some(22678));
        assert_eq!(usage.cache_read, Some(22144));
        assert_eq!(usage.reasoning_tokens, Some(181));
        assert!(usage.cost_total.unwrap_or_default() > 0.0);
        assert_eq!(dur, Some(2843.68));
        assert_eq!(ttft, Some(855.7));

        // 只有 assistant 消息带用量语义；toolResult / 无字段的用户消息不提取
        assert!(SessionMeta::usage_from_message_end(&serde_json::json!({"role": "toolResult", "usage": {"input": 1}})).is_none());
        assert!(SessionMeta::usage_from_message_end(&serde_json::json!({"role": "assistant", "content": []})).is_none());
    }

    #[test]
    fn efforts_of_reads_both_shapes() {
        assert_eq!(efforts_of(&opus()).unwrap(), vec!["low", "medium", "high", "xhigh", "max"]);
        // 数组形态（防上游结构漂移）
        assert_eq!(efforts_of(&serde_json::json!({"thinking": ["high","max"]})).unwrap(), vec!["high", "max"]);
        // 无思考模型（实测 claude-haiku-4-5 无 thinking 键）
        assert!(efforts_of(&serde_json::json!({"id": "claude-haiku-4-5-20251001", "reasoning": false})).is_none());
        assert!(efforts_of(&serde_json::json!({"thinking": {"efforts": []}})).is_none());
    }

    #[test]
    fn highest_effort_uses_strength_order() {
        let e = |v: Vec<&str>| v.into_iter().map(str::to_string).collect::<Vec<_>>();
        assert_eq!(highest_effort(Some(&e(vec!["low", "medium", "high", "xhigh", "max"]))), "max");
        assert_eq!(highest_effort(Some(&e(vec!["low", "high", "max"]))), "max");
        assert_eq!(highest_effort(Some(&e(vec!["low", "medium", "high"]))), "high");
        // 不信任数组顺序，按强度序取最大
        assert_eq!(highest_effort(Some(&e(vec!["max", "low"]))), "max");
        assert_eq!(highest_effort(Some(&e(vec!["minimal", "low", "medium", "high", "xhigh"]))), "xhigh");
        // 未知档忽略；无可用档 = off（无思考模型）
        assert_eq!(highest_effort(Some(&e(vec!["low", "bogus"]))), "low");
        assert_eq!(highest_effort(Some(&e(vec!["bogus"]))), "off");
        assert_eq!(highest_effort(None), "off");
    }

    #[test]
    fn session_meta_from_state_and_model() {
        let state = serde_json::json!({ "model": opus(), "thinkingLevel": "xhigh", "sessionId": "s1" });
        let m = SessionMeta::from_state(&state);
        assert_eq!(m.model.as_ref().unwrap().id, "claude-opus-5");
        assert_eq!(m.model.as_ref().unwrap().provider, "commandcode");
        assert_eq!(m.efforts.as_ref().unwrap().len(), 5);
        assert_eq!(m.thinking_level.as_deref(), Some("xhigh"));
        // opus() 是 commandcode 的 Claude（api anthropic-messages、非 first-party）→ 不支持 Fast
        assert_eq!(m.fast_mode_supported, Some(false));
        // 前端读的 wire 字段名是 camelCase（`SessionRuntime.fastModeSupported`）
        assert_eq!(serde_json::to_value(&m).unwrap()["fastModeSupported"], serde_json::json!(false));

        // 无思考模型：档位键缺失（实测），efforts 为 None
        let haiku_state = serde_json::json!({ "model": {"provider":"commandcode","id":"claude-haiku-4-5-20251001"} });
        let h = SessionMeta::from_state(&haiku_state);
        assert!(h.efforts.is_none());
        assert!(h.thinking_level.is_none());
        assert_eq!(h.model.as_ref().unwrap().id, "claude-haiku-4-5-20251001");
        assert_eq!(h.fast_mode_supported, Some(false));

        // set_model 回包：data 即模型对象本身，档位留空等回读
        let f = SessionMeta::from_model(&opus());
        assert_eq!(f.model.as_ref().unwrap().id, "claude-opus-5");
        assert_eq!(f.efforts.as_ref().unwrap().last().unwrap(), "max");
        assert!(f.thinking_level.is_none());
        assert_eq!(f.fast_mode_supported, Some(false));

        // OpenAI 模型（provider openai）→ 支持 Fast
        let openai_state = serde_json::json!({
            "model": {
                "provider": "openai",
                "id": "gpt-5",
                "api": "openai-responses",
                "identity": { "class": "openai" }
            }
        });
        assert_eq!(SessionMeta::from_state(&openai_state).fast_mode_supported, Some(true));

        // 无 id 的畸形 data 不产出模型
        assert!(SessionMeta::from_state(&serde_json::json!({"model": {"provider": "x"}})).model.is_none());
    }

    /// Fast 闪电的显隐判据（与 omp `service-tier.ts` 的 `ty` + `Cve`/`Cu` 对齐）：
    /// 只按模型元数据判定，不靠先点一次 `set_fast_mode` 试错。
    #[test]
    fn fast_mode_support_follows_omp_service_tier_rules() {
        fn model(
            provider: &str,
            api: &str,
            identity: Option<&str>,
            service_tiers: Option<&[&str]>,
        ) -> serde_json::Value {
            let mut v = serde_json::json!({"provider": provider, "id": "m", "api": api});
            if let Some(c) = identity {
                v["identity"] = serde_json::json!({"class": c});
            }
            if let Some(t) = service_tiers {
                v["serviceTiers"] = serde_json::json!(t);
            }
            v
        }

        // 用户截图里的 commandcode DeepSeek：OpenAI 兼容，但 identity 不是 openai → 没有档位控制
        assert!(!fast_mode_supported(&model(
            "commandcode",
            "openai-responses",
            Some("deepseek"),
            None
        )));
        // 非 first-party 的 anthropic-messages（commandcode 的 Claude）也不可用
        assert!(!fast_mode_supported(&model(
            "commandcode",
            "anthropic-messages",
            Some("anthropic"),
            None
        )));
        // 三大家族
        assert!(fast_mode_supported(&model("openai", "openai-responses", Some("openai"), None)));
        assert!(fast_mode_supported(&model("anthropic", "anthropic-messages", Some("anthropic"), None)));
        assert!(fast_mode_supported(&model("google", "google-generative-ai", Some("gemini"), None)));
        assert!(fast_mode_supported(&model("google-vertex", "google-generative-ai", Some("gemini"), None)));
        // OpenRouter：openai / google 身份可用，anthropic 身份不可用
        assert!(fast_mode_supported(&model("openrouter", "openai-responses", Some("openai"), None)));
        assert!(fast_mode_supported(&model("openrouter", "google-generative-ai", Some("gemini"), None)));
        assert!(!fast_mode_supported(&model("openrouter", "anthropic-messages", Some("anthropic"), None)));
        // 自定义 OpenAI 兼容端点（identity.class=openai）可用
        assert!(fast_mode_supported(&model("custom", "openai-completions", Some("openai"), None)));
        // fireworks 在 omp 里没有 service-tier family（即使 Cu 对 priority 返回 true）
        assert!(!fast_mode_supported(&model("fireworks", "openai-completions", Some("openai"), None)));
        // openai-codex：serviceTiers 显式列出时按列表；缺省仍按 provider 放行
        assert!(fast_mode_supported(&model(
            "openai-codex",
            "openai-codex-responses",
            Some("openai"),
            Some(&["priority"])
        )));
        assert!(!fast_mode_supported(&model(
            "openai-codex",
            "openai-codex-responses",
            Some("openai"),
            Some(&["flex"])
        )));
        assert!(fast_mode_supported(&model(
            "openai-codex",
            "openai-codex-responses",
            Some("openai"),
            None
        )));
    }

    #[test]
    fn jsonl_line_shapes() {
        let line = jsonl_line("auto-think", "set_thinking_level", serde_json::json!({"level": "max"})).unwrap();
        assert!(line.ends_with('\n'));
        let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["type"], "set_thinking_level");
        assert_eq!(v["level"], "max");
        assert_eq!(v["id"], "auto-think");
        let g = jsonl_line(STATE_SYNC_ID, "get_state", serde_json::Value::Null).unwrap();
        assert_eq!(g.trim(), r#"{"id":"sync-state","type":"get_state"}"#);
    }

    fn injected(action: FrameAction) -> Option<String> {
        match action {
            FrameAction::Forward(x) => x,
            FrameAction::StateSync => panic!("不应分类为状态回读"),
            FrameAction::Swallow => panic!("不应分类为本地消化"),
        }
    }

    #[test]
    fn auto_think_level_keeps_valid_level_and_falls_back_to_default() {
        let opus_efforts = vec!["low".into(), "medium".into(), "high".into(), "xhigh".into(), "max".into()];
        let gemini = vec!["low".into(), "medium".into(), "high".into()];
        // 有效档保留（含 off：omp 不列它但恒定生效）——不覆盖用户已选的档
        assert_eq!(auto_think_level(Some(&opus_efforts), Some("low"), Some("medium")), None);
        assert_eq!(auto_think_level(Some(&opus_efforts), Some("off"), None), None);
        // 缺档 → 落 omp 配置的默认档
        assert_eq!(auto_think_level(Some(&opus_efforts), None, Some("medium")), Some("medium".into()));
        // 配置默认档不被该模型支持（或没读到）→ 该模型最高档
        assert_eq!(auto_think_level(Some(&gemini), None, Some("max")), Some("high".into()));
        assert_eq!(auto_think_level(Some(&gemini), None, None), Some("high".into()));
        // 当前档对新模型非法 → 落默认档
        assert_eq!(auto_think_level(Some(&gemini), Some("max"), Some("low")), Some("low".into()));
        // 新模型不支持思考 → 不落档（omp 自己丢档，回读收敛）
        assert_eq!(auto_think_level(None, Some("high"), Some("max")), None);
    }

    #[test]
    fn classify_set_model_applies_default_or_reads_back() {
        let frame = serde_json::json!({
            "id": "m-1", "type": "response", "command": "set_model", "success": true, "data": opus()
        });
        // 缺档 + 配置默认档 → 下发配置里的那一档（不是最高档）
        let v: serde_json::Value =
            serde_json::from_str(injected(classify(&frame, None, Some("medium"))).unwrap().trim()).unwrap();
        assert_eq!(v["type"], "set_thinking_level");
        assert_eq!(v["level"], "medium");
        assert_eq!(v["id"], "auto-think");

        // 当前档对新模型仍然合法 → 不落档，改回读真值（omp 会保留它）
        let v2: serde_json::Value =
            serde_json::from_str(injected(classify(&frame, Some("low"), Some("medium"))).unwrap().trim())
                .unwrap();
        assert_eq!(v2["id"], STATE_SYNC_ID);
        assert_eq!(v2["type"], "get_state");

        // 无思考模型 → 不落档（omp 丢档），回读把真值收敛成缺档
        let haiku = serde_json::json!({
            "id": "m-2", "type": "response", "command": "set_model", "success": true,
            "data": {"provider": "commandcode", "id": "claude-haiku-4-5-20251001", "reasoning": false}
        });
        let v3: serde_json::Value =
            serde_json::from_str(injected(classify(&haiku, Some("high"), Some("max"))).unwrap().trim()).unwrap();
        assert_eq!(v3["type"], "get_state");
    }

    #[test]
    fn classify_set_model_failure_reads_back_state() {
        // 失败（如 Model not found）：不碰档位，但回读真值纠正前端乐观态
        let frame = serde_json::json!({
            "id": "m-3", "type": "response", "command": "set_model", "success": false, "error": "Model not found"
        });
        let v: serde_json::Value =
            serde_json::from_str(injected(classify(&frame, None, None)).unwrap().trim()).unwrap();
        assert_eq!(v["id"], STATE_SYNC_ID);
        assert_eq!(v["type"], "get_state");
    }

    #[test]
    fn classify_set_thinking_reads_back_state() {
        let frame = serde_json::json!({
            "id": "t-1", "type": "response", "command": "set_thinking_level", "success": true
        });
        let v: serde_json::Value =
            serde_json::from_str(injected(classify(&frame, None, None)).unwrap().trim()).unwrap();
        assert_eq!(v["type"], "get_state");
    }

    #[test]
    fn classify_passthrough_and_state_sync() {
        // 普通事件：透传、不注入
        assert_eq!(classify(&serde_json::json!({"type": "agent_start"}), None, None), FrameAction::Forward(None));
        assert_eq!(classify(&serde_json::json!({"type": "prompt_result"}), None, None), FrameAction::Forward(None));
        // prompt 回包不触发回读
        let p = serde_json::json!({"id": "p-1", "type": "response", "command": "prompt", "success": true});
        assert_eq!(classify(&p, None, None), FrameAction::Forward(None));
    }

    #[test]
    fn midrun_sync_throttles_to_running_sessions() {
        // 跑着的会话：距上次回读不足 2s 不发，过了才发（长任务里每步收尾一帧）
        assert!(!midrun_sync_due(ACT_RUNNING, 1_000, 0));
        assert!(midrun_sync_due(ACT_RUNNING, CONTEXT_SYNC_MIN_MS, 0));
        assert!(!midrun_sync_due(ACT_RUNNING, 3_000, CONTEXT_SYNC_MIN_MS));
        assert!(midrun_sync_due(ACT_RUNNING, 5_000 + CONTEXT_SYNC_MIN_MS, CONTEXT_SYNC_MIN_MS));
        // 等审批 / 等待后台 / 空闲 / 退出：没有新步数，不发（收尾那发归终态路径）
        for act in [ACT_AWAITING, ACT_IDLE_AWAITING, ACT_IDLE, ACT_EXITED] {
            assert!(!midrun_sync_due(act, 9_999_999, 0), "act={act} 不该回读");
        }
    }

    #[test]
    fn classify_swallows_subagent_subscription() {
        // 壳侧自己发的订阅命令：成功与失败（旧版 omp 不认）都在本地消化，不进前端
        let ok = serde_json::json!({
            "id": "h-sub", "type": "response", "command": "set_subagent_subscription", "success": true,
            "data": {"level": "progress"}
        });
        assert_eq!(classify(&ok, None, None), FrameAction::Swallow);
        let fail = serde_json::json!({
            "id": "h-sub", "type": "response", "command": "set_subagent_subscription", "success": false,
            "error": "Unknown command"
        });
        assert_eq!(classify(&fail, None, None), FrameAction::Swallow);
    }

    #[test]
    fn spawn_args_use_rpc_ui_mode() {
        // rpc-ui（hasUI=true）而非 rpc：多挂 ask 工具。
        let opts = SpawnOpts {
            bin: "omp".into(),
            cwd: "/tmp/x".into(),
            resume: None,
            model: None,
            thinking: None,
            approval: None,
        };
        let a = opts.args();
        assert_eq!(&a[0], "--mode");
        assert_eq!(&a[1], "rpc-ui");
        assert_eq!(&a[2], "--cwd");
        assert_eq!(&a[3], "/tmp/x");
    }

    #[test]
    fn local_prompt_result_detected() {
        // 本地收尾（agentInvoked:false）→ 收敛 idle
        let local = serde_json::json!({"id": "p-2", "type": "response", "command": "prompt", "success": true, "data": {"agentInvoked": false}});
        assert!(is_local_prompt_result(&local));
        // 真正开跑（true / 缺字段）→ 不收敛，等 agent_end
        let started = serde_json::json!({"id": "p-3", "type": "response", "command": "prompt", "success": true, "data": {"agentInvoked": true}});
        assert!(!is_local_prompt_result(&started));
        let legacy = serde_json::json!({"id": "p-4", "type": "response", "command": "prompt", "success": true});
        assert!(!is_local_prompt_result(&legacy));
        // 失败回包不收敛
        let failed = serde_json::json!({"id": "p-5", "type": "response", "command": "prompt", "success": false, "data": {"agentInvoked": false}});
        assert!(!is_local_prompt_result(&failed));
        // 状态回读回包：自己消化，不回环（get_state 不再触发注入）
        let s = serde_json::json!({"id": STATE_SYNC_ID, "type": "response", "command": "get_state", "success": true});
        assert_eq!(classify(&s, None, None), FrameAction::StateSync);
    }

    // ---------- V34 闲置回收 ----------

    #[test]
    fn session_activity_tracks_state_and_freshness() {
        let act = SessionActivity::new();
        assert_eq!(act.state(), ACT_IDLE, "spawn 起手是 idle");
        act.set_state(ACT_RUNNING);
        assert_eq!(act.state(), ACT_RUNNING);
        // touch 刷新活动时刻（回收计时的依据）
        act.last_active_ms.store(0, Ordering::Relaxed);
        act.touch();
        assert!(act.last_active_ms() > 0);
    }

    #[test]
    fn idle_recyclable_only_for_stale_idle() {
        let act = SessionActivity::new();
        let now = 10_000_000i64;
        let idle = 60_000i64;
        // idle 且超阈值 → 可回收（边界上等于阈值也算）
        act.last_active_ms.store(now - idle, Ordering::Relaxed);
        assert!(idle_recyclable(&act, now, idle));
        // 刚有帧 → 不可回收
        act.last_active_ms.store(now - idle + 1, Ordering::Relaxed);
        assert!(!idle_recyclable(&act, now, idle));
        // 非 idle（跑着 / 等审批 / 等后台完成投递 / 异常退出）一律不回收——哪怕很久没帧
        for st in [ACT_RUNNING, ACT_AWAITING, ACT_IDLE_AWAITING, ACT_EXITED] {
            act.set_state(st);
            act.last_active_ms.store(0, Ordering::Relaxed);
            assert!(!idle_recyclable(&act, now, idle), "state={st} 不该被回收");
        }
    }

    #[test]
    fn agent_end_status_maps_omp_shapes() {
        // 终态（含缺字段）→ idle
        assert_eq!(agent_end_status(&serde_json::json!({"type":"agent_end","isTerminal":true})), Some("idle"));
        assert_eq!(agent_end_status(&serde_json::json!({"type":"agent_end"})), Some("idle"));
        // 等后台完成投递（supervised process / job 的收尾）→ idle-awaiting：
        // 前端仍是 idle（否则「任务完成」后一直顶着「思考中…」），但回收跳过
        assert_eq!(
            agent_end_status(&serde_json::json!({"type":"agent_end","isTerminal":false,"awaitingAsyncWork":true})),
            Some("idle-awaiting")
        );
        // 其余非终态（还有排队 / 子代理在继续跑）→ 不收敛，等后续 agent_start / 终态 agent_end
        assert_eq!(agent_end_status(&serde_json::json!({"type":"agent_end","isTerminal":false})), None);
        assert_eq!(
            agent_end_status(&serde_json::json!({"type":"agent_end","isTerminal":false,"awaitingAsyncWork":false})),
            None
        );
    }

    #[test]
    fn status_pair_separates_ui_and_activity_state() {
        // idle-awaiting：前端就是 idle（工作指示行收敛 / 输入解锁），活动态单列
        assert_eq!(status_pair("idle-awaiting"), (ACT_IDLE_AWAITING, "idle"));
        assert_eq!(status_pair("idle"), (ACT_IDLE, "idle"));
        assert_eq!(status_pair("running"), (ACT_RUNNING, "running"));
        assert_eq!(status_pair("awaiting-approval"), (ACT_AWAITING, "awaiting-approval"));
        // error / exited 两档共用活动态，前端字符串各自保留
        assert_eq!(status_pair("error"), (ACT_EXITED, "error"));
        assert_eq!(status_pair("exited"), (ACT_EXITED, "exited"));
        // 回读口径与前端一致（切回一个 idle-awaiting 的会话不显示成别的）
        assert_eq!(activity_state_label(ACT_IDLE_AWAITING), "idle");
        // 列表运行标口径：只有 running / awaiting-approval 算「任务在跑」；
        // idle-awaiting 是"轮次已 yield"（前端就是 idle），exited 也不是
        assert!(activity_is_busy(ACT_RUNNING));
        assert!(activity_is_busy(ACT_AWAITING));
        assert!(!activity_is_busy(ACT_IDLE));
        assert!(!activity_is_busy(ACT_IDLE_AWAITING));
        assert!(!activity_is_busy(ACT_EXITED));
    }

    #[test]
    fn dispatch_converges_awaiting_agent_end_and_settles() {
        use tauri::Listener;
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app 构建失败");
        let handle = app.handle().clone();
        let (tx, rx) = std::sync::mpsc::channel::<serde_json::Value>();
        handle.listen("omp-status://s1", move |e| {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(e.payload()) {
                let _ = tx.send(v);
            }
        });
        let next_state = |rx: &std::sync::mpsc::Receiver<serde_json::Value>| {
            rx.recv_timeout(std::time::Duration::from_secs(1)).expect("未收到状态事件")["state"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        };
        let act = SessionActivity::new();
        // 轮次开跑
        dispatch(&handle, "s1", "omp-event://s1", "omp-status://s1", &serde_json::json!({"type":"agent_start"}), &act);
        assert_eq!(act.state(), ACT_RUNNING);
        assert_eq!(next_state(&rx), "running");
        // 等后台完成投递的收尾：前端必须离开 running（否则「任务完成仍显示思考中…」），
        // 但活动态单列——唤醒的 follow-up 可能在路上，回收要跳过
        dispatch(
            &handle,
            "s1",
            "omp-event://s1",
            "omp-status://s1",
            &serde_json::json!({"type":"agent_end","isTerminal":false,"awaitingAsyncWork":true}),
            &act,
        );
        assert_eq!(act.state(), ACT_IDLE_AWAITING);
        assert!(!idle_recyclable(&act, i64::MAX, 0), "等后台完成时不许回收");
        assert_eq!(next_state(&rx), "idle");
        // 会话安静（session_settled）→ 回到可回收的 idle
        dispatch(&handle, "s1", "omp-event://s1", "omp-status://s1", &serde_json::json!({"type":"session_settled"}), &act);
        assert_eq!(act.state(), ACT_IDLE);
        assert_eq!(next_state(&rx), "idle");
        // 其余非终态（还有排队 / 子代理在继续跑）：保持 running，等后续 agent_start / 终态 agent_end
        dispatch(&handle, "s1", "omp-event://s1", "omp-status://s1", &serde_json::json!({"type":"agent_start"}), &act);
        assert_eq!(next_state(&rx), "running");
        dispatch(
            &handle,
            "s1",
            "omp-event://s1",
            "omp-status://s1",
            &serde_json::json!({"type":"agent_end","isTerminal":false}),
            &act,
        );
        assert_eq!(act.state(), ACT_RUNNING, "还有排队 / 子代理时不许收敛");
    }

    #[test]
    fn emit_status_publishes_idle_for_idle_awaiting() {
        use tauri::Listener;
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app 构建失败");
        let handle = app.handle().clone();
        // 收集走同步通道（回调里只需 send），不引锁
        let (tx, rx) = std::sync::mpsc::channel::<serde_json::Value>();
        handle.listen("omp-status://s1", move |e| {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(e.payload()) {
                let _ = tx.send(v);
            }
        });
        let act = SessionActivity::new();
        emit_status(&handle, "omp-status://s1", &act, "idle-awaiting", None);
        // 活动态单列（回收跳过），前端 payload 是 idle
        assert_eq!(act.state(), ACT_IDLE_AWAITING);
        assert!(!idle_recyclable(&act, i64::MAX, 0), "idle-awaiting 不许被回收");
        let first = rx.recv_timeout(std::time::Duration::from_secs(1)).expect("未收到状态事件");
        assert_eq!(first["state"], "idle");
        // 会话安静 / 新轮次开始都会把它带出该档
        emit_status(&handle, "omp-status://s1", &act, "idle", None);
        assert_eq!(act.state(), ACT_IDLE);
        let second = rx.recv_timeout(std::time::Duration::from_secs(1)).expect("未收到第二个状态事件");
        assert_eq!(second["state"], "idle");
    }
}
