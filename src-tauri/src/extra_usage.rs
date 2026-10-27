//! 补充用量探针（壳侧）：对 **omp 没有实现探针** 的供应商，凡上游提供「API key 可用」的
//! 用量 / 余额查询接口，就由壳侧做一次只读查询，把结果映射成与 `omp usage --json` 相同的
//! [`UsageLimit`] 结构——「供应商用量」面板因此能把它们与 omp 报的供应商并排展示。
//!
//! **两类查询模式**（用户口径）：
//!
//! - **plan 型**：订阅 / 滚动窗口额度（百分比 + 重置时刻）——commandcode、minimax-code-cn。
//! - **余额型**：按量计费余额（金额 / 货币）——deepseek、openrouter、vercel-ai-gateway、
//!   moonshot、siliconflow、stepfun、novita、deepinfra、aimlapi、aiand、nanogpt、kilo、
//!   venice、zenmux。
//!
//! **没有 API key 查询路径的供应商不做代偿**（2026-09-30 全量调研，4 组并行 + 本机复测）：
//! xiaomi（MiMo：API 网关与 token-plan 三区网关逐路径 404、控制台接口只认 Cookie、
//! 官方文档只给控制台用量页，社区同结论）、siliconflow-cn（官方 2026-08-14 下线
//! `/v1/user/info`，替代接口未公布）、zhipu-coding-plan（只有未文档化的控制台内部路由，
//! 涉及把 API token 发往非文档端点）、xai / minimax / minimax-cn（推理 key 无余额接口；
//! minimax 的 token-plan 仅 coding 档且有上游探针）、opencode-zen、alibaba-coding-plan、
//! qwen-portal、gitlab-duo、mistral / groq / cerebras / together / fireworks / baseten /
//! coreweave / huggingface / nvidia / gmi-cloud / firepass / sakana / qianfan / meta /
//! wafer-serverless / yolo-auto / singularityapi-*、google / openai / azure / amazon-bedrock /
//! google-vertex 等——界面按「无用量数据」直接提示（文案见字典 `pusageNoDataHint`）。
//!
//! 上游事实（2026-09-18 实测，omp 18.2.5 / 本机 commandcode 凭据；2026-10-21 复测 omp 18.12.4）：
//!
//! - **omp 的用量探针清单**（`packages/ai/src/usage/`）里没有下面这些 provider——全量
//!   `omp usage --json` 会把它们从 `accountsWithoutUsage` 里也滤掉（静默缺席）。
//! - **commandcode**：omp 18.12 起自带 5 小时 / 每周 / 余额三行，但**没有月度窗口**；官方也
//!   没有文档化的月度用量 API。`GET https://api.commandcode.ai/alpha/billing/credits`
//!   （Bearer = Provider API key）实测**可用**（alpha 前缀即「API key 通道」），
//!   `credits.monthlyCredits` 是月度剩余；配套 `/alpha/billing/subscriptions` 给 `planId` 与
//!   月度重置时刻。月度总额先按 5h/weekly 的 cap 组合反查官方套餐表（认不出再按 planId），
//!   反查不到只给剩余额、不猜百分比。omp 已给报告时只补它缺的窗口（见 `run_probes`）。
//! - **deepseek**：官方文档化接口 `GET https://api.deepseek.com/user/balance`（Bearer = API key；
//!   api-docs.deepseek.com/zh-cn/api/get-user-balance）返回
//!   `{is_available, balance_infos:[{currency,total_balance,granted_balance,topped_up_balance}]}`；
//!   余额是**字符串**，有 CNY / USD 两种币种。deepseek 没有公开的滚动窗口 / 用量明细接口
//!   （平台网页才能看），所以这里只展示余额。
//! - 各新端点的响应形状与出处见每个解析函数上方的注释；全部来自 2026-09-30 的官方文档
//!   （少数标注社区实证），解析一律全容错：字段漂移只报「查询失败」，不伪造 0。
//!
//! **凭证边界**：key 只经 `omp token <provider> --raw`（omp 官方 CLI，只读）取出，
//! 存于内存、仅用于本次请求头；不落盘、不打印、不进错误消息、不回传前端。凭据不存在 /
//! 端点失败都只产出一行失败记录，界面按「查询失败」展示。
//!
//! **只读**：除 nanogpt 的 `POST /api/check-balance`（语义为查询、无副作用）外全部是 GET；
//! 不发任何写请求、不动 omp 状态。

use std::sync::LazyLock;
use std::time::Duration;

use crate::provider_usage::{ExtraProbeFailure, ProviderUsage, ProviderUsageReport, UsageLimit};

/// 注册了补充探针的供应商（omp 没给报告时整份补；omp 给了报告时只补缺的窗口——当前只有
/// commandcode 的月度，见 `run_probes`）。
pub const EXTRA_PROBES: [&str; 16] = [
    "commandcode",
    "deepseek",
    "openrouter",
    "vercel-ai-gateway",
    "moonshot",
    "siliconflow",
    "stepfun",
    "novita",
    "deepinfra",
    "aimlapi",
    "aiand",
    "nanogpt",
    "kilo",
    "venice",
    "zenmux",
    "minimax-code-cn",
];

// ---------- 端点常量（出处见各解析函数注释） ----------

/// openrouter：key 自查（普通 key 可用）与账户 credits（仅管理密钥，403 时静默回退）。
const OPENROUTER_KEY_URL: &str = "https://openrouter.ai/api/v1/key";
const OPENROUTER_CREDITS_URL: &str = "https://openrouter.ai/api/v1/credits";
/// vercel-ai-gateway：团队 AI Gateway credits 余额。
const VERCEL_CREDITS_URL: &str = "https://ai-gateway.vercel.sh/v1/credits";
/// moonshot：两个站点各自独立（key 不通用）——`.ai` 为 omp 默认域，`.cn` 为国内站。
const MOONSHOT_BALANCE_URL_US: &str = "https://api.moonshot.ai/v1/users/me/balance";
const MOONSHOT_BALANCE_URL_CN: &str = "https://api.moonshot.cn/v1/users/me/balance";
/// siliconflow（国际站；国内站 `siliconflow-cn` 的该接口已下线，不注册）。
const SILICONFLOW_USER_URL: &str = "https://api.siliconflow.com/v1/user/info";
/// stepfun：账户信息（预付费 / 后付费余额，人民币）。
const STEPFUN_ACCOUNTS_URL: &str = "https://api.stepfun.com/v1/accounts";
/// novita：余额明细（单位 1/10000 USD）。
const NOVITA_BALANCE_URL: &str = "https://api.novita.ai/openapi/v1/billing/balance/detail";
/// deepinfra：checklist（`stripe_balance` 负值 = 可用余额）。
const DEEPINFRA_CHECKLIST_URL: &str = "https://api.deepinfra.com/payment/checklist?compute_owed=true";
/// aimlapi：账户余额（`/v2/billing`）。
const AIMLAPI_BILLING_URL: &str = "https://api.aimlapi.com/v2/billing";
/// aiand：组织余额（字符串 + currency）。
const AIAND_BALANCE_URL: &str = "https://api.aiand.com/billing/balance";
/// nanogpt：余额查询（语义只读；认证头是 `x-api-key`）。
const NANOGPT_BALANCE_URL: &str = "https://api.nano-gpt.com/api/check-balance";
/// kilo：网关账户余额（官方开源客户端同款端点）。
const KILO_BALANCE_URL: &str = "https://api.kilo.ai/api/profile/balance";
/// venice：billing balance（**需要 ADMIN 权限的 key**，推理 key 会 401）。
const VENICE_BALANCE_URL: &str = "https://api.venice.ai/api/v1/billing/balance";
/// zenmux：PAYG 余额（**需要单独的 Management Key**，标准 API key 不可用）。
const ZENMUX_BALANCE_URL: &str = "https://zenmux.ai/api/v1/management/payg/balance";
/// minimax-code-cn：Token Plan 剩余额度（与上游 `minimax-code` 探针同款接口，国内域）。
const MINIMAX_CN_REMAINS_URL: &str = "https://api.minimaxi.com/v1/token_plan/remains";

/// 单次 HTTP 查询超时。实测 commandcode 约 2s、deepseek 约 1s；15s 给慢网络留余量。
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .expect("reqwest client 构建失败")
});

// ---------- 纯函数（可测） ----------

/// 从 `omp token <provider> --raw` 的输出里取出凭据。
///
/// 实测：成功时 stdout 是**无空白的单行 token**（如 93 字符的 commandcode key）；
/// 没有凭据时**退出码仍可能是 0**，stdout 是 `No active credential found for provider "x".`
/// 加一行 `Configured providers: …`——所以不能只看退出码，必须按内容判定。
pub fn extract_key(out: &str) -> Option<String> {
    let text = out.trim();
    if text.is_empty() || text.contains(char::is_whitespace) || text.starts_with("No active credential") {
        return None;
    }
    if text.len() < 16 {
        return None;
    }
    Some(text.to_string())
}

/// 错误响应体里抽一行简短消息（JSON 的 `message` / `error.message`，或截断的原文）。
fn short_error(body: &str) -> String {
    let trimmed = body.trim();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
        let candidates: [&[&str]; 2] = [&["message"], &["error", "message"]];
        for path in candidates {
            let mut cur = &v;
            let mut ok = true;
            for key in path {
                match cur.get(key) {
                    Some(next) => cur = next,
                    None => {
                        ok = false;
                        break;
                    }
                }
            }
            if ok {
                if let Some(s) = cur.as_str() {
                    if !s.trim().is_empty() {
                        return s.trim().to_string();
                    }
                }
            }
        }
    }
    let one_line = trimmed.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    if one_line.chars().count() > 160 {
        let mut cut: String = one_line.chars().take(160).collect();
        cut.push('…');
        cut
    } else {
        one_line.to_string()
    }
}

fn num(v: Option<&serde_json::Value>) -> Option<f64> {
    v.and_then(|x| x.as_f64().or_else(|| x.as_i64().map(|i| i as f64)))
}

/// 字符串字段：转成 `&str` 并 trim（空串按 None）。
fn text_of(v: Option<&serde_json::Value>) -> Option<&str> {
    v.and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty())
}

/// 数字或数字字符串（余额接口大量用字符串传金额，如 "0.88" / "129.46956147"）。
fn num_str(v: Option<&serde_json::Value>) -> Option<f64> {
    num(v).or_else(|| text_of(v).and_then(|s| s.parse::<f64>().ok()))
}

/// 从 `fetch_json` 的错误串里取 HTTP 状态码（错误形如 `HTTP 401：…`）。
fn err_status(err: &str) -> Option<u16> {
    err.strip_prefix("HTTP ")?.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

/// 401 / 403 → 换成「凭据类型不对」的明确引导（如 venice 需要 ADMIN key、zenmux 需要
/// Management Key）；其余错误原样透传。
fn explain_auth(err: String, hint: &str) -> String {
    if matches!(err_status(&err), Some(401) | Some(403)) {
        format!("{hint}（{err}）")
    } else {
        err
    }
}

/// 余额型行：`remaining` 是主值、没有上限 → 界面不画进度条，显示「N 剩余」。
fn balance_row(
    id: &str,
    label: &str,
    remaining: f64,
    unit: &str,
    status: &str,
    notes: Vec<String>,
) -> UsageLimit {
    UsageLimit {
        id: id.to_string(),
        label: label.to_string(),
        window_id: "balance".to_string(),
        window_label: label.to_string(),
        used_fraction: 0.0,
        percent: 0.0,
        status: status.to_string(),
        resets_at: None,
        duration_ms: None,
        notes,
        used: None,
        limit: None,
        remaining: Some(remaining),
        unit: unit.to_string(),
    }
}

/// 余额行的状态：>0 为 ok，否则 exhausted（与 deepseek 的 `is_available` 同口径）。
fn balance_status(remaining: f64) -> &'static str {
    if remaining > 0.0 {
        "ok"
    } else {
        "exhausted"
    }
}

/// 金额展示（备注行用；两位小数，去尾零太复杂的场景不值得）。
fn money(v: f64) -> String {
    format!("{v:.2}")
}

/// commandcode 官方套餐表（Usage Limits 文档的表格）：(5 小时 cap, 每周 cap) → 月度 credits 总额。
///
/// API key 通道的 credits 响应里**没有 plan 字段**（plan 在 subscriptions 端点），但 5h/weekly 的
/// cap 组合在官方表里唯一确定套餐——用它反查月额度。官方 2026-10 的 Go 档是 $2 / $5 两个窗口
/// （老的 flat $10 Go 是 $3 / $6），两套都认。
const COMMANDCODE_MONTHLY_CREDITS: [(f64, f64, f64); 7] = [
    (2.0, 5.0, 10.0),     // Go（按模型分配 credits 的新档）
    (3.0, 6.0, 10.0),     // Go（老 flat $10 档；官方说明窗口不变、随续费迁移）
    (14.0, 35.0, 70.0),   // GOAT
    (16.0, 40.0, 80.0),   // Pro
    (45.0, 90.0, 150.0),  // Max 10×
    (90.0, 180.0, 300.0), // Max 20×
    (12.0, 24.0, 40.0),   // Team Pro
];

fn monthly_total_for(cap_5h: Option<f64>, cap_weekly: Option<f64>) -> Option<f64> {
    let (a, b) = (cap_5h?, cap_weekly?);
    COMMANDCODE_MONTHLY_CREDITS
        .iter()
        .find(|(x, y, _)| (x - a).abs() < 0.001 && (y - b).abs() < 0.001)
        .map(|(_, _, total)| *total)
}

/// subscriptions 的 `planId` → 月度 credits 总额（cap 组合对不上时的兜底）。
///
/// 官方价目表：Go $10 / GOAT $70 / Pro $80 / Max 10× $150 / Max 20× $300 / Team Pro $40。
/// 只用明确认得的 plan 名；`provider`（PAYG）与未知 / Enterprise 一律 None——不猜。
fn monthly_total_for_plan(plan_id: Option<&str>) -> Option<f64> {
    let id = plan_id?.to_ascii_lowercase();
    // PAYG（`provider`）没有月度额度；它含 "pro"，必须在套餐判断之前挡掉
    if id.contains("provider") || id.contains("pay-as-you-go") || id.contains("payg") {
        return None;
    }
    // `individual-goat` 里也含 "go"，所以 goat 必须先判
    if id.contains("goat") {
        Some(70.0)
    } else if id.contains("max-20") {
        Some(300.0)
    } else if id.contains("max-10") {
        Some(150.0)
    } else if id.contains("team-pro") {
        Some(40.0)
    } else if id.contains("pro") {
        Some(80.0)
    } else if id.contains("go") {
        Some(10.0)
    } else {
        None
    }
}

/// 解析 commandcode 的 `/alpha/billing/credits` 响应（结构见模块文档；字段全容错）。
///
/// `period_end_ms` / `plan_id` 来自 subscriptions 端点（月度重置时刻、套餐名；拿不到为 None）。
/// 月度行与官方页面同口径：**已用百分比**（总额先按 5h/weekly 的 cap 组合反查官方套餐表，
/// 认不出再按 planId 认套餐；两者都反查不到时只给剩余额，不猜百分比）。
pub fn parse_commandcode_credits(
    v: &serde_json::Value,
    period_end_ms: Option<i64>,
    plan_id: Option<&str>,
) -> Result<Vec<UsageLimit>, String> {
    let mut limits = vec![];
    let window_limits = v.get("windowLimits");
    let window = |key: &str| -> Option<(UsageLimit, Option<f64>)> {
        let w = window_limits?.get(key)?;
        let used = num(w.get("used"));
        let cap = num(w.get("cap")).filter(|c| *c > 0.0);
        let (window_id, window_label, id, label, duration) = match key {
            "fiveHour" => ("5h", "5 Hour", "rolling-5h", "5 Hour limit", Some(18_000_000_i64)),
            "weekly" => ("7d", "Weekly", "weekly", "Weekly limit", Some(604_800_000_i64)),
            _ => (key, key, key, key, None),
        };
        let fraction = match (used, cap) {
            (Some(u), Some(c)) => u / c,
            _ => 0.0,
        };
        let exceeded = w.get("exceeded").and_then(|x| x.as_bool()).unwrap_or(false);
        let status = if exceeded || fraction >= 1.0 {
            "exhausted"
        } else if fraction >= 0.8 {
            "warning"
        } else {
            "ok"
        };
        Some((
            UsageLimit {
                id: id.to_string(),
                label: label.to_string(),
                window_id: window_id.to_string(),
                window_label: window_label.to_string(),
                used_fraction: fraction,
                percent: fraction * 100.0,
                status: status.to_string(),
                resets_at: w.get("resetAt").and_then(|x| x.as_i64()),
                duration_ms: duration,
                notes: vec![],
                used,
                limit: cap,
                remaining: match (cap, used) {
                    (Some(c), Some(u)) => Some((c - u).max(0.0)),
                    _ => None,
                },
                unit: "credits".into(),
            },
            cap,
        ))
    };
    let mut cap_5h = None;
    let mut cap_weekly = None;
    if let Some((limit, cap)) = window("fiveHour") {
        cap_5h = cap;
        limits.push(limit);
    }
    if let Some((limit, cap)) = window("weekly") {
        cap_weekly = cap;
        limits.push(limit);
    }
    // 月度：官方页面显示「已用 N%」（总额 = 官方套餐表按 cap 组合 / planId 反查）；`monthlyCredits` 是剩余。
    let credits = v.get("credits");
    if let Some(monthly_left) = num(credits.and_then(|c| c.get("monthlyCredits"))) {
        let total = monthly_total_for(cap_5h, cap_weekly).or_else(|| monthly_total_for_plan(plan_id));
        let (used, limit, fraction, status) = match total {
            Some(t) if t > 0.0 => {
                let used = (t - monthly_left).max(0.0);
                let fraction = used / t;
                let status = if fraction >= 1.0 {
                    "exhausted"
                } else if fraction >= 0.8 {
                    "warning"
                } else {
                    "ok"
                };
                (Some(used), Some(t), fraction, status)
            }
            _ => (None, None, 0.0, "ok"),
        };
        let mut notes = vec![];
        let purchased = num(credits.and_then(|c| c.get("purchasedCredits"))).unwrap_or(0.0);
        if purchased > 0.0 {
            notes.push(format!("purchased: {purchased:.2} credits"));
        }
        limits.push(UsageLimit {
            id: "monthly".into(),
            label: "Monthly limit".into(),
            window_id: "monthly".into(),
            window_label: "Monthly".into(),
            used_fraction: fraction,
            percent: fraction * 100.0,
            status: status.into(),
            resets_at: period_end_ms,
            duration_ms: None,
            notes,
            used,
            limit,
            remaining: Some(monthly_left),
            unit: "credits".into(),
        });
    }
    if limits.is_empty() {
        return Err("响应里没有可用的窗口数据".into());
    }
    Ok(limits)
}

/// RFC 3339 → epoch 毫秒（subscriptions 的 `currentPeriodEnd` 是 ISO 串）。
fn parse_iso_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|dt| dt.timestamp_millis())
}

/// 解析 deepseek 的 `/user/balance` 响应（每个币种一条「余额」行；`total_balance` 是字符串）。
pub fn parse_deepseek_balance(v: &serde_json::Value) -> Result<Vec<UsageLimit>, String> {
    let available = v.get("is_available").and_then(|x| x.as_bool()).unwrap_or(false);
    let infos = v
        .get("balance_infos")
        .and_then(|x| x.as_array())
        .ok_or_else(|| "响应里没有 balance_infos".to_string())?;
    let mut limits = vec![];
    for info in infos {
        let currency = info.get("currency").and_then(|x| x.as_str()).unwrap_or("CNY");
        let total = info
            .get("total_balance")
            .and_then(|x| x.as_str())
            .and_then(|s| s.trim().parse::<f64>().ok())
            .or_else(|| num(info.get("total_balance")));
        let Some(total) = total else { continue };
        limits.push(UsageLimit {
            id: format!("balance-{}", currency.to_lowercase()),
            label: "Balance".into(),
            window_id: "balance".into(),
            window_label: "Balance".into(),
            used_fraction: 0.0,
            percent: 0.0,
            status: if available { "ok" } else { "exhausted" }.into(),
            resets_at: None,
            duration_ms: None,
            notes: vec![],
            used: None,
            limit: None,
            remaining: Some(total),
            unit: currency.to_lowercase(),
        });
    }
    if limits.is_empty() {
        return Err("响应里没有可解析的余额".into());
    }
    Ok(limits)
}

// ---------- 余额型解析（2026-09-30 调研；响应形状出处见每条注释） ----------

/// openrouter：`GET /api/v1/key`（普通 key 可用）与 `GET /api/v1/credits`（**仅管理密钥**，
/// 普通 key 403）的合成解析。文档：
/// openrouter.ai/docs/api/api-reference/api-keys/get-current-key、…/credits/get-credits。
///
/// `key`：`{data:{limit, limit_remaining, limit_reset, usage, usage_monthly, is_free_tier,…}}`
/// （`limit`/`limit_remaining` 可为 null = 没设 per-key 上限）；`credits`：
/// `{data:{total_credits, total_usage}}`。优先账户级余额（credits 差），其次 per-key 剩余，
/// 再其次只给累计消费（行名「已消费」）。
pub fn parse_openrouter(
    key_res: Result<serde_json::Value, String>,
    credits_res: Result<serde_json::Value, String>,
) -> Result<Vec<UsageLimit>, String> {
    if let Ok(v) = credits_res {
        if let (Some(total), Some(used)) = (
            num(v.pointer("/data/total_credits")),
            num(v.pointer("/data/total_usage")),
        ) {
            let remaining = (total - used).max(0.0);
            return Ok(vec![balance_row(
                "balance",
                "Balance",
                remaining,
                "usd",
                balance_status(remaining),
                vec![format!("credits {} · used {}", money(total), money(used))],
            )]);
        }
    }
    let v = key_res?;
    let data = v.get("data").ok_or_else(|| "响应里没有 data".to_string())?;
    let usage = num_str(data.get("usage"));
    let mut notes = vec![];
    if let Some(u) = usage {
        notes.push(format!("usage {}", money(u)));
    }
    match num_str(data.get("limit_remaining")) {
        Some(remaining) => {
            if let Some(limit) = num_str(data.get("limit")) {
                let reset = text_of(data.get("limit_reset")).unwrap_or("—");
                notes.push(format!("limit {} ({reset})", money(limit)));
            }
            Ok(vec![balance_row("balance", "Balance", remaining, "usd", balance_status(remaining), notes)])
        }
        None => {
            // 没设 per-key 上限：账户余额需要管理密钥（上面已试），这里退化为展示累计消费
            let spent = usage.ok_or_else(|| "响应里没有可用的额度或消费数据".to_string())?;
            notes.push("no per-key limit set".into());
            let mut row = balance_row("spent", "Spent", spent, "usd", "ok", notes);
            row.window_id = "spent".to_string();
            row.remaining = None;
            row.used = Some(spent);
            Ok(vec![row])
        }
    }
}

/// vercel-ai-gateway：`GET /v1/credits`（文档 vercel.com/docs/ai-gateway/sdks-and-apis/rest-api#check-credit-balance）
/// → `{balance:"95.50", total_used:"4.50"}`（字符串，USD）。
pub fn parse_vercel_credits(v: &serde_json::Value) -> Result<Vec<UsageLimit>, String> {
    let balance = num_str(v.get("balance")).ok_or_else(|| "响应里没有 balance".to_string())?;
    let mut notes = vec![];
    if let Some(used) = num_str(v.get("total_used")) {
        notes.push(format!("total spend {}", money(used)));
    }
    Ok(vec![balance_row("balance", "Balance", balance, "usd", balance_status(balance), notes)])
}

/// moonshot（Kimi 开放平台）：`GET /v1/users/me/balance`（文档 platform.kimi.com/docs/api/balance）
/// → `{code:0, status:true, data:{available_balance, voucher_balance, cash_balance}}`。
/// `.ai`（国际，USD）与 `.cn`（国内，CNY）两个站点**账号体系独立、key 不通用**。
pub fn parse_moonshot_balance(v: &serde_json::Value, unit: &str) -> Result<Vec<UsageLimit>, String> {
    let code = v.get("code").and_then(|x| x.as_i64()).unwrap_or(0);
    if code != 0 {
        return Err(format!("平台返回错误码 {code}"));
    }
    let data = v.get("data").ok_or_else(|| "响应里没有 data".to_string())?;
    let available = num_str(data.get("available_balance")).ok_or_else(|| "响应里没有可用余额".to_string())?;
    let mut notes = vec![];
    if let Some(cash) = num_str(data.get("cash_balance")) {
        notes.push(format!("cash {}", money(cash)));
    }
    if let Some(voucher) = num_str(data.get("voucher_balance")) {
        notes.push(format!("voucher {}", money(voucher)));
    }
    Ok(vec![balance_row("balance", "Balance", available, unit, balance_status(available), notes)])
}

/// siliconflow（**国际站**）：`GET /v1/user/info`（文档
/// docs.siliconflow.com/en/api-reference/userinfo/get-user-info）→
/// `{code:20000, status:true, data:{balance:"0.88", chargeBalance:"88.00", totalBalance:"88.88"}}`
/// （全字符串；国际站计价为美元）。**国内站同名接口官方 2026-08 已下线**（410），不注册。
pub fn parse_siliconflow_user(v: &serde_json::Value) -> Result<Vec<UsageLimit>, String> {
    let code = v.get("code").and_then(|x| x.as_i64()).unwrap_or(0);
    if code != 20000 && code != 0 {
        return Err(format!("平台返回错误码 {code}"));
    }
    let data = v.get("data").ok_or_else(|| "响应里没有 data".to_string())?;
    let total = num_str(data.get("totalBalance")).ok_or_else(|| "响应里没有余额".to_string())?;
    let mut notes = vec![];
    if let Some(charge) = num_str(data.get("chargeBalance")) {
        notes.push(format!("recharged {}", money(charge)));
    }
    if let Some(gift) = num_str(data.get("balance")) {
        notes.push(format!("gift {}", money(gift)));
    }
    Ok(vec![balance_row("balance", "Balance", total, "usd", balance_status(total), notes)])
}

/// stepfun：`GET /v1/accounts`（文档 platform.stepfun.com/docs/zh/api-reference/accounts/get）
/// → `{object:"account", type:"prepaid"|"postpaid", balance, total_cash_balance,
/// total_voucher_balance}`（人民币）。
pub fn parse_stepfun_account(v: &serde_json::Value) -> Result<Vec<UsageLimit>, String> {
    let balance = num_str(v.get("balance")).ok_or_else(|| "响应里没有 balance".to_string())?;
    let mut notes = vec![];
    if let Some(kind) = text_of(v.get("type")) {
        notes.push(format!("account {kind}"));
    }
    if let Some(cash) = num_str(v.get("total_cash_balance")) {
        notes.push(format!("cash {}", money(cash)));
    }
    if let Some(voucher) = num_str(v.get("total_voucher_balance")) {
        notes.push(format!("voucher {}", money(voucher)));
    }
    Ok(vec![balance_row("balance", "Balance", balance, "cny", balance_status(balance), notes)])
}

/// novita：`GET /openapi/v1/billing/balance/detail`（文档 novita.ai/docs/api-reference/basic-get-user-balance）
/// → `{availableBalance, cashBalance, creditLimit, pendingCharges, outstandingInvoices}`，
/// 全是**字符串**且单位为 1/10000 USD（`10000` = $1）。
pub fn parse_novita_balance(v: &serde_json::Value) -> Result<Vec<UsageLimit>, String> {
    let raw = num_str(v.get("availableBalance")).ok_or_else(|| "响应里没有 availableBalance".to_string())?;
    let available = raw / 10_000.0;
    let mut notes = vec![];
    if let Some(cash) = num_str(v.get("cashBalance")) {
        notes.push(format!("cash {}", money(cash / 10_000.0)));
    }
    if let Some(limit) = num_str(v.get("creditLimit")).filter(|l| *l > 0.0) {
        notes.push(format!("credit limit {}", money(limit / 10_000.0)));
    }
    if let Some(pending) = num_str(v.get("pendingCharges")).filter(|p| *p > 0.0) {
        notes.push(format!("pending {}", money(pending / 10_000.0)));
    }
    Ok(vec![balance_row("balance", "Balance", available, "usd", balance_status(available), notes)])
}

/// deepinfra：`GET /payment/checklist?compute_owed=true`（文档
/// docs.deepinfra.com/api-reference/billing/get-checklist）→ `{stripe_balance, limit, recent,
/// suspended, suspend_reason, …}`；`stripe_balance` **负值 = 可用余额**（正值 = 欠款）。
pub fn parse_deepinfra_checklist(v: &serde_json::Value) -> Result<Vec<UsageLimit>, String> {
    let stripe = num_str(v.get("stripe_balance")).ok_or_else(|| "响应里没有 stripe_balance".to_string())?;
    let available = (-stripe).max(0.0);
    let mut notes = vec![];
    if stripe > 0.0 {
        notes.push(format!("owed {}", money(stripe)));
    }
    if let Some(recent) = num_str(v.get("recent")) {
        notes.push(format!("recent {}", money(recent)));
    }
    let suspended = v.get("suspended").and_then(|x| x.as_bool()).unwrap_or(false);
    if suspended {
        let reason = text_of(v.get("suspend_reason")).unwrap_or("suspended");
        notes.push(format!("suspended: {reason}"));
    }
    let status = if suspended { "exhausted" } else { balance_status(available) };
    Ok(vec![balance_row("balance", "Balance", available, "usd", status, notes)])
}

/// aimlapi：`GET /v2/billing`（文档 docs.aimlapi.com/api-references/service-endpoints/account-balance）
/// → `{current_balance, currency}`。
pub fn parse_aimlapi_billing(v: &serde_json::Value) -> Result<Vec<UsageLimit>, String> {
    let balance = num_str(v.get("current_balance")).ok_or_else(|| "响应里没有 current_balance".to_string())?;
    let unit = text_of(v.get("currency")).unwrap_or("USD").to_lowercase();
    Ok(vec![balance_row("balance", "Balance", balance, &unit, balance_status(balance), vec![])])
}

/// aiand：`GET /billing/balance`（文档 docs.aiand.com/billing/balance）
/// → `{balance:"12.34", currency:"usd"}`。
pub fn parse_aiand_balance(v: &serde_json::Value) -> Result<Vec<UsageLimit>, String> {
    let balance = num_str(v.get("balance")).ok_or_else(|| "响应里没有 balance".to_string())?;
    let unit = text_of(v.get("currency")).unwrap_or("usd").to_lowercase();
    Ok(vec![balance_row("balance", "Balance", balance, &unit, balance_status(balance), vec![])])
}

/// nanogpt：`POST /api/check-balance`（文档 docs.nano-gpt.com/api-reference/endpoint/check-balance，
/// 认证头 `x-api-key`；语义只读）→ `{usd_balance:"129.46", nano_balance:"26.71", …}`（字符串）。
pub fn parse_nanogpt_balance(v: &serde_json::Value) -> Result<Vec<UsageLimit>, String> {
    let usd = num_str(v.get("usd_balance")).ok_or_else(|| "响应里没有 usd_balance".to_string())?;
    let mut notes = vec![];
    if let Some(nano) = num_str(v.get("nano_balance")) {
        notes.push(format!("nano {}", money(nano)));
    }
    Ok(vec![balance_row("balance", "Balance", usd, "usd", balance_status(usd), notes)])
}

/// kilo：`GET /api/profile/balance`（官方开源客户端同款端点：Kilo-Org/kilocode 的
/// `packages/kilo-gateway/src/api/profile.ts`；公开文档只写控制台余额）→ `{balance:<number>}`（USD）。
pub fn parse_kilo_balance(v: &serde_json::Value) -> Result<Vec<UsageLimit>, String> {
    let balance = num_str(v.get("balance")).ok_or_else(|| "响应里没有 balance".to_string())?;
    Ok(vec![balance_row("balance", "Balance", balance, "usd", balance_status(balance), vec![])])
}

/// venice：`GET /api/v1/billing/balance`（文档 docs.venice.ai/api-reference/endpoint/billing/balance；
/// **需要 ADMIN 权限的 key**，推理 key 401）→ `{canConsume, consumptionCurrency,
/// balances:{diem,usd}, diemEpochAllocation}`。
pub fn parse_venice_balance(v: &serde_json::Value) -> Result<Vec<UsageLimit>, String> {
    let usd = num_str(v.pointer("/balances/usd"));
    let diem = num_str(v.pointer("/balances/diem"));
    let (remaining, unit) = match (usd, diem) {
        (Some(u), _) => (u, "usd"),
        (None, Some(d)) => (d, "diem"),
        _ => return Err("响应里没有余额字段".to_string()),
    };
    let mut notes = vec![];
    if unit == "usd" {
        if let Some(d) = diem {
            notes.push(format!("diem {}", money(d)));
        }
    }
    if let Some(alloc) = num_str(v.get("diemEpochAllocation")) {
        notes.push(format!("daily allocation {}", money(alloc)));
    }
    let can_consume = v.get("canConsume").and_then(|x| x.as_bool()).unwrap_or(true);
    let status = if can_consume { balance_status(remaining) } else { "exhausted" };
    Ok(vec![balance_row("balance", "Balance", remaining, unit, status, notes)])
}

/// zenmux：`GET /api/v1/management/payg/balance`（文档 zenmux.ai/docs/api/platform/payg-balance.html；
/// **需要单独的 Management Key**）→ `{success, data:{currency, total_credits, top_up_credits,
/// bonus_credits}}`（total = top-up + bonus）。
pub fn parse_zenmux_balance(v: &serde_json::Value) -> Result<Vec<UsageLimit>, String> {
    if v.get("success").and_then(|x| x.as_bool()) == Some(false) {
        return Err("平台返回 success=false".to_string());
    }
    let data = v.get("data").ok_or_else(|| "响应里没有 data".to_string())?;
    let total = num_str(data.get("total_credits")).ok_or_else(|| "响应里没有 total_credits".to_string())?;
    let unit = text_of(data.get("currency")).unwrap_or("usd").to_lowercase();
    let mut notes = vec![];
    if let Some(top) = num_str(data.get("top_up_credits")) {
        notes.push(format!("top-up {}", money(top)));
    }
    if let Some(bonus) = num_str(data.get("bonus_credits")) {
        notes.push(format!("bonus {}", money(bonus)));
    }
    Ok(vec![balance_row("balance", "Balance", total, &unit, balance_status(total), notes)])
}

/// minimax-code-cn：`GET /v1/token_plan/remains`（**plan 型**；与上游 `minimax-code` 探针
/// 同款接口与形状，国内域 `api.minimaxi.com`）→ `{base_resp:{status_code,status_msg},
/// model_remains:[{model_name, start_time, end_time, current_interval_remaining_percent,
/// current_interval_total_count, current_interval_usage_count, weekly_*…}]}`（形状取自 omp
/// 二进制里的同一实现）。间隔窗 id 按时长命名（5 小时 → `5h`）、每周 → `7d`；
/// 两个计数都为 0 的模型视为无配额、跳过。
pub fn parse_minimax_token_plan(v: &serde_json::Value) -> Result<Vec<UsageLimit>, String> {
    let code = v.pointer("/base_resp/status_code").and_then(|x| x.as_i64()).unwrap_or(0);
    if code != 0 {
        let msg = text_of(v.pointer("/base_resp/status_msg")).unwrap_or("Token Plan 不可用");
        return Err(format!("平台返回错误码 {code}：{msg}"));
    }
    let items = v
        .get("model_remains")
        .and_then(|x| x.as_array())
        .ok_or_else(|| "响应里没有 model_remains".to_string())?;
    let mut limits = vec![];
    for item in items {
        let model = text_of(item.get("model_name")).unwrap_or("MiniMax").to_string();
        let model_label = {
            let mut it = model.chars();
            match it.next() {
                Some(first) => first.to_uppercase().collect::<String>() + it.as_str(),
                None => model.clone(),
            }
        };
        let interval_total = num(item.get("current_interval_total_count"));
        let weekly_total = num(item.get("current_weekly_total_count"));
        if interval_total.unwrap_or(0.0) <= 0.0 && weekly_total.unwrap_or(0.0) <= 0.0 {
            continue;
        }
        let start = num(item.get("start_time"));
        let end = num(item.get("end_time"));
        let interval_ms = match (start, end) {
            (Some(s), Some(e)) => Some(e - s),
            _ => None,
        };
        let (interval_id, interval_label) = match interval_ms {
            Some(ms) if ms > 0.0 && (ms as i64) % 3_600_000 == 0 => {
                let hours = (ms as i64) / 3_600_000;
                (format!("{hours}h"), format!("{hours} Hour"))
            }
            _ => ("interval".to_string(), "Interval".to_string()),
        };
        let windows = [
            (
                interval_id.as_str(),
                interval_label.as_str(),
                num(item.get("current_interval_remaining_percent")),
                end.map(|e| e as i64),
                num(item.get("current_interval_usage_count")),
                interval_total,
            ),
            (
                "7d",
                "7 Day",
                num(item.get("current_weekly_remaining_percent")),
                item.get("weekly_end_time").and_then(|x| x.as_i64()),
                num(item.get("current_weekly_usage_count")),
                weekly_total,
            ),
        ];
        for (window_id, window_label, remaining_pct, resets_at, used, total) in windows {
            let Some(pct) = remaining_pct else { continue };
            if total.unwrap_or(0.0) <= 0.0 {
                continue;
            }
            let fraction = ((100.0 - pct) / 100.0).clamp(0.0, 1.0);
            let status = if fraction >= 1.0 {
                "exhausted"
            } else if fraction >= 0.8 {
                "warning"
            } else {
                "ok"
            };
            let mut notes = vec![];
            if let (Some(u), Some(t)) = (used, total) {
                notes.push(format!("Requests: {}/{}", u as i64, t as i64));
            }
            limits.push(UsageLimit {
                id: format!("{model}:{window_id}"),
                label: format!("{model_label} {window_label}"),
                window_id: window_id.to_string(),
                window_label: window_label.to_string(),
                used_fraction: fraction,
                percent: fraction * 100.0,
                status: status.to_string(),
                resets_at,
                duration_ms: None,
                notes,
                used: None,
                limit: None,
                remaining: None,
                unit: "percent".into(),
            });
        }
    }
    if limits.is_empty() {
        return Err("响应里没有可用的配额窗口".into());
    }
    Ok(limits)
}

// ---------- 网络与编排 ----------

/// GET 一个 JSON 接口（Bearer 认证）。错误消息不含凭据。
async fn fetch_json(url: &str, key: &str) -> Result<serde_json::Value, String> {
    let resp = HTTP
        .get(url)
        .bearer_auth(key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("读取响应失败：{e}"))?;
    if !status.is_success() {
        return Err(format!("HTTP {}：{}", status.as_u16(), short_error(&body)));
    }
    serde_json::from_str(&body).map_err(|e| format!("响应不是合法 JSON：{e}"))
}

/// POST 一个 JSON 接口（`x-api-key` 认证；nanogpt 的余额查询是语义只读的 POST）。
async fn fetch_json_x_api_key(url: &str, key: &str) -> Result<serde_json::Value, String> {
    let resp = HTTP
        .post(url)
        .header("x-api-key", key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("读取响应失败：{e}"))?;
    if !status.is_success() {
        return Err(format!("HTTP {}：{}", status.as_u16(), short_error(&body)));
    }
    serde_json::from_str(&body).map_err(|e| format!("响应不是合法 JSON：{e}"))
}

/// 取某供应商的凭据（`omp token <provider> --raw`）。
async fn fetch_key(bin: &str, provider: &str) -> Result<String, String> {
    let out = crate::providers::run_omp(bin, &["token", provider, "--raw"]).await?;
    extract_key(&out).ok_or_else(|| "omp 里没有这个供应商的可用凭据".to_string())
}

/// 跑一个补充探针（key → 请求 → 解析）。
pub async fn probe(bin: &str, provider: &str) -> Result<Vec<UsageLimit>, String> {
    let key = fetch_key(bin, provider).await?;
    probe_with_key(provider, &key).await
}

/// 探针主体（凭据已取得）：按 provider 分派到各端点。独立函数便于「真实端点路由」慢测试
/// 用无效 key 全量跑一遍（验证路由存在性 / 401 映射，不做任何写操作）。
pub async fn probe_with_key(provider: &str, key: &str) -> Result<Vec<UsageLimit>, String> {
    match provider {
        "commandcode" => {
            // 两个端点并行：credits（必需）与 subscriptions（尽力——拿「月度重置时刻 + 套餐名」，
            // 免费层 / 失败时为 None，不影响额度本身）
            let credits_fut = fetch_json("https://api.commandcode.ai/alpha/billing/credits", key);
            let subs_fut = fetch_json("https://api.commandcode.ai/alpha/billing/subscriptions", key);
            let (credits, subs) = tokio::join!(credits_fut, subs_fut);
            let (period_end, plan_id) = match subs.ok().and_then(|s| s.get("data").cloned()) {
                Some(data) => (
                    data.get("currentPeriodEnd").and_then(|x| x.as_str()).and_then(parse_iso_ms),
                    data.get("planId").and_then(|x| x.as_str()).map(str::to_string),
                ),
                None => (None, None),
            };
            parse_commandcode_credits(&credits?, period_end, plan_id.as_deref())
        }
        "deepseek" => {
            let v = fetch_json("https://api.deepseek.com/user/balance", key).await?;
            parse_deepseek_balance(&v)
        }
        "openrouter" => {
            let (k, c) = tokio::join!(
                fetch_json(OPENROUTER_KEY_URL, key),
                fetch_json(OPENROUTER_CREDITS_URL, key),
            );
            parse_openrouter(k, c)
        }
        "vercel-ai-gateway" => {
            let v = fetch_json(VERCEL_CREDITS_URL, key).await?;
            parse_vercel_credits(&v)
        }
        "moonshot" => {
            // 两个站点账号体系独立（key 不通用）：谁成功用谁（omp 默认域是 .ai，USD；
            // .cn 是人民币）
            let (us, cn) = tokio::join!(
                fetch_json(MOONSHOT_BALANCE_URL_US, key),
                fetch_json(MOONSHOT_BALANCE_URL_CN, key),
            );
            let mut first_err: Option<String> = None;
            for (res, unit) in [(us, "usd"), (cn, "cny")] {
                match res {
                    Ok(v) => match parse_moonshot_balance(&v, unit) {
                        Ok(rows) => return Ok(rows),
                        Err(e) => first_err = first_err.or(Some(e)),
                    },
                    Err(e) => first_err = first_err.or(Some(e)),
                }
            }
            Err(first_err.unwrap_or_else(|| "moonshot 余额查询失败".to_string()))
        }
        "siliconflow" => {
            let v = fetch_json(SILICONFLOW_USER_URL, key).await?;
            parse_siliconflow_user(&v)
        }
        "stepfun" => {
            let v = fetch_json(STEPFUN_ACCOUNTS_URL, key).await?;
            parse_stepfun_account(&v)
        }
        "novita" => {
            let v = fetch_json(NOVITA_BALANCE_URL, key).await?;
            parse_novita_balance(&v)
        }
        "deepinfra" => {
            let v = fetch_json(DEEPINFRA_CHECKLIST_URL, key).await?;
            parse_deepinfra_checklist(&v)
        }
        "aimlapi" => {
            let v = fetch_json(AIMLAPI_BILLING_URL, key).await?;
            parse_aimlapi_billing(&v)
        }
        "aiand" => {
            let v = fetch_json(AIAND_BALANCE_URL, key).await?;
            parse_aiand_balance(&v)
        }
        "nanogpt" => {
            let v = fetch_json_x_api_key(NANOGPT_BALANCE_URL, key).await?;
            parse_nanogpt_balance(&v)
        }
        "kilo" => {
            let v = fetch_json(KILO_BALANCE_URL, key).await?;
            parse_kilo_balance(&v)
        }
        "venice" => {
            let v = fetch_json(VENICE_BALANCE_URL, key)
                .await
                .map_err(|e| explain_auth(e, "该接口需要 ADMIN 权限的 key（推理 key 查不了用量）"))?;
            parse_venice_balance(&v)
        }
        "zenmux" => {
            let v = fetch_json(ZENMUX_BALANCE_URL, key)
                .await
                .map_err(|e| explain_auth(e, "该接口需要 Management Key（在 zenmux.ai 平台单独创建，与标准 API key 不同）"))?;
            parse_zenmux_balance(&v)
        }
        "minimax-code-cn" => {
            let v = fetch_json(MINIMAX_CN_REMAINS_URL, key).await?;
            parse_minimax_token_plan(&v)
        }
        other => Err(format!("没有为 {other} 注册补充探针")),
    }
}

/// 把补充探针拿到的窗口并进 omp 已有报告：只补**缺失的 `window_id`**，不覆盖 omp 的读数；
/// 额度窗口排在 `balance` 之前（余额行永远收尾）。
///
/// `monthly` 没有上限时（套餐表反查不到，只是余额的另一种说法）不补——留原本的余额行，
/// 免得同一个读数在浮层里出现两遍。
pub fn merge_missing_limits(report: &mut ProviderUsageReport, extra: Vec<UsageLimit>) -> usize {
    let mut added = 0;
    let mut insert_at = report
        .limits
        .iter()
        .position(|l| l.window_id == "balance")
        .unwrap_or(report.limits.len());
    for limit in extra {
        if report.limits.iter().any(|l| l.window_id == limit.window_id) {
            continue;
        }
        if limit.window_id == "monthly" && limit.limit.is_none() {
            continue;
        }
        report.limits.insert(insert_at, limit);
        insert_at += 1;
        added += 1;
    }
    added
}

/// 逐个跑补充探针：omp 没给报告的供应商整份补，omp 已报的 commandcode 只补缺的月度窗口。
/// 成功的并进 `usage`，失败的收集成 `extra_failures`（界面显示「查询失败」而不是「无用量数据」）。
///
/// **omp 已给报告的供应商也会补缺**：omp 18.12 起自带 commandcode 的 5 小时 / 每周 / 余额，
/// 但没有月度窗口（官方 credits 端点只有 `monthlyCredits` 一个剩余值）——不补的话「月额度」
/// 就只剩一行 credits 余额，用户看不到月度进度条。只补缺失窗口，omp 以后自己报了月度就以
/// omp 为准（不会覆盖）。
pub async fn run_probes(bin: &str, usage: &mut ProviderUsage) -> Vec<ExtraProbeFailure> {
    let mut failures = vec![];
    for provider in EXTRA_PROBES {
        if let Some(index) = usage.reports.iter().position(|r| r.provider == provider) {
            // 已报的供应商不看 configured_providers（模型目录缓存冷启动时可能是空的；
            // omp 报了它，就说明这份凭据确实配置着）。commandcode 只补 omp 缺的月度窗口。
            if provider == "commandcode"
                && !usage.reports[index].limits.iter().any(|l| l.window_id == "monthly")
            {
                match probe(bin, provider).await {
                    Ok(limits) => {
                        merge_missing_limits(&mut usage.reports[index], limits);
                    }
                    Err(message) => failures.push(ExtraProbeFailure {
                        provider: provider.to_string(),
                        message: format!("月度额度：{message}"),
                    }),
                }
            }
            continue;
        }
        if !usage.configured_providers.iter().any(|c| c == provider) {
            continue;
        }
        match probe(bin, provider).await {
            Ok(limits) if !limits.is_empty() => usage.reports.push(ProviderUsageReport {
                provider: provider.to_string(),
                plan_type: None,
                account_label: None,
                fetched_at: chrono::Utc::now().timestamp_millis(),
                limits,
            }),
            Ok(_) => {}
            Err(message) => failures.push(ExtraProbeFailure {
                provider: provider.to_string(),
                message,
            }),
        }
    }
    failures
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_key_takes_clean_tokens_only() {
        assert_eq!(extract_key("  cc-abcdef0123456789abcdef  \n"), Some("cc-abcdef0123456789abcdef".into()));
        assert_eq!(extract_key(""), None);
        assert_eq!(extract_key("No active credential found for provider \"deepseek\".\nConfigured providers: commandcode"), None);
        assert_eq!(extract_key("short"), None, "过短的输出不是 token");
        assert_eq!(extract_key("two words token"), None, "含空白不是单行 token");
    }

    /// 本机实测（2026-09-18）的 `/alpha/billing/credits` 响应，逐字节照抄。
    const COMMANDCODE: &str = r#"{
      "credits": { "belowThreshold": false, "creditThreshold": 0, "monthlyCredits": 54.768619927, "purchasedCredits": 0, "freeCredits": 0 },
      "windowLimits": {
        "limited": true, "exceeded": null,
        "fiveHour": { "used": 0.306242895, "cap": 14, "exceeded": false, "resetAt": 1789727992310 },
        "weekly": { "used": 15.231380073, "cap": 35, "exceeded": false, "resetAt": 1790043631859 }
      }
    }"#;

    #[test]
    fn commandcode_maps_windows_and_monthly_credits() {
        let v: serde_json::Value = serde_json::from_str(COMMANDCODE).unwrap();
        let limits = parse_commandcode_credits(&v, Some(1791500000000), Some("individual-goat")).expect("实测响应必须能解析");
        assert_eq!(limits.len(), 3, "5 小时 / 每周 / 月度三档");

        let h5 = &limits[0];
        assert_eq!((h5.id.as_str(), h5.window_id.as_str()), ("rolling-5h", "5h"));
        assert!((h5.used.unwrap() - 0.306242895).abs() < 1e-9);
        assert_eq!(h5.limit, Some(14.0));
        assert!((h5.percent - 2.1874).abs() < 0.01, "used/cap 折算百分比");
        assert_eq!(h5.status, "ok");
        assert_eq!(h5.resets_at, Some(1789727992310));
        assert_eq!(h5.unit, "credits");
        assert!(h5.remaining.unwrap() > 13.6);

        let weekly = &limits[1];
        assert_eq!(weekly.window_id, "7d");
        assert!((weekly.percent - 43.518).abs() < 0.01);

        // 月度与官方页面同口径：cap 组合（14/35）反查 GOAT 月额度 70 → 已用 = 70 - 剩余
        let monthly = &limits[2];
        assert_eq!(monthly.window_id, "monthly");
        assert_eq!(monthly.limit, Some(70.0), "GOAT 月额度由 5h/weekly cap 反查");
        assert!((monthly.used.unwrap() - (70.0 - 54.768619927)).abs() < 1e-6);
        assert!((monthly.percent - 21.759).abs() < 0.01, "官方页面显示「已用 22%」同口径");
        assert_eq!(monthly.resets_at, Some(1791500000000), "月度重置来自 subscriptions 的 currentPeriodEnd");
        assert!((monthly.remaining.unwrap() - 54.768619927).abs() < 1e-6);
    }

    #[test]
    fn commandcode_unknown_plan_shows_remaining_without_fake_percent() {
        // cap 组合不在官方套餐表里（表变了 / 新套餐）：月度只给剩余额，不猜百分比
        let out = r#"{"credits":{"monthlyCredits":5},"windowLimits":{
          "fiveHour":{"used":1,"cap":7,"resetAt":1},
          "weekly":{"used":2,"cap":9,"resetAt":2}}}"#;
        let v: serde_json::Value = serde_json::from_str(out).unwrap();
        let limits = parse_commandcode_credits(&v, None, None).unwrap();
        let monthly = limits.iter().find(|l| l.window_id == "monthly").expect("月度行仍在");
        assert_eq!(monthly.limit, None);
        assert_eq!(monthly.used, None);
        assert_eq!(monthly.percent, 0.0);
        assert_eq!(monthly.remaining, Some(5.0));
        assert_eq!(monthly.resets_at, None);
    }

    #[test]
    fn commandcode_monthly_total_falls_back_to_plan_id() {
        // cap 组合不认识（上游调了窗口），但 subscriptions 给了 planId：照样能画月度进度条
        let out = r#"{"credits":{"monthlyCredits":40},"windowLimits":{
          "fiveHour":{"used":1,"cap":7,"resetAt":1},
          "weekly":{"used":2,"cap":9,"resetAt":2}}}"#;
        let v: serde_json::Value = serde_json::from_str(out).unwrap();
        let limits = parse_commandcode_credits(&v, None, Some("individual-pro")).unwrap();
        let monthly = limits.iter().find(|l| l.window_id == "monthly").expect("月度行");
        assert_eq!(monthly.limit, Some(80.0), "Pro 套餐 $80/月");
        assert_eq!(monthly.used, Some(40.0));
        assert_eq!(monthly.percent, 50.0);
        assert_eq!(monthly.unit, "credits");

        // Go 的新旧两套 cap 都认，planId 不必覆盖它
        let go_new = serde_json::json!({"credits":{"monthlyCredits":9},
          "windowLimits":{"fiveHour":{"used":1,"cap":2},"weekly":{"used":1,"cap":5}}});
        let limits = parse_commandcode_credits(&go_new, None, None).unwrap();
        assert_eq!(limits.iter().find(|l| l.window_id == "monthly").unwrap().limit, Some(10.0));
        let go_old = serde_json::json!({"credits":{"monthlyCredits":9},
          "windowLimits":{"fiveHour":{"used":1,"cap":3},"weekly":{"used":1,"cap":6}}});
        let limits = parse_commandcode_credits(&go_old, None, None).unwrap();
        assert_eq!(limits.iter().find(|l| l.window_id == "monthly").unwrap().limit, Some(10.0));

        // 未知 planId 不猜
        assert_eq!(monthly_total_for_plan(Some("individual-enterprise")), None);
        assert_eq!(monthly_total_for_plan(Some("provider")), None);
        assert_eq!(monthly_total_for_plan(Some("individual-max-20x")), Some(300.0));
        assert_eq!(monthly_total_for_plan(Some("team-pro")), Some(40.0));
    }

    #[test]
    fn merge_missing_limits_keeps_omp_windows_and_inserts_monthly_before_balance() {
        let mut report = ProviderUsageReport {
            provider: "commandcode".into(),
            plan_type: None,
            account_label: None,
            fetched_at: 1,
            limits: vec![
                UsageLimit {
                    id: "commandcode:5h".into(),
                    label: "5-hour limit".into(),
                    window_id: "5h".into(),
                    window_label: "5-hour".into(),
                    used_fraction: 0.1,
                    percent: 10.0,
                    status: "ok".into(),
                    resets_at: Some(1),
                    duration_ms: Some(18_000_000),
                    notes: vec![],
                    used: Some(1.4),
                    limit: Some(14.0),
                    remaining: Some(12.6),
                    unit: "credits".into(),
                },
                UsageLimit {
                    id: "commandcode:balance".into(),
                    label: "Credit balance".into(),
                    window_id: "balance".into(),
                    window_label: "Credit balance".into(),
                    used_fraction: 0.0,
                    percent: 0.0,
                    status: "ok".into(),
                    resets_at: None,
                    duration_ms: None,
                    notes: vec![],
                    used: None,
                    limit: None,
                    remaining: Some(5.36),
                    unit: "credits".into(),
                },
            ],
        };
        let extra = vec![
            // omp 已经有的窗口：不覆盖 omp 的读数
            UsageLimit { id: "probe-5h".into(), window_id: "5h".into(), label: "probe".into(), window_label: "probe".into(), used_fraction: 0.9, percent: 90.0, status: "warning".into(), resets_at: None, duration_ms: None, notes: vec![], used: Some(12.6), limit: Some(14.0), remaining: Some(1.4), unit: "credits".into() },
            // 缺的月度：插在 balance 之前
            UsageLimit { id: "monthly".into(), window_id: "monthly".into(), label: "Monthly".into(), window_label: "Monthly".into(), used_fraction: 0.923, percent: 92.3, status: "warning".into(), resets_at: Some(2), duration_ms: None, notes: vec![], used: Some(64.64), limit: Some(70.0), remaining: Some(5.36), unit: "credits".into() },
        ];
        assert_eq!(merge_missing_limits(&mut report, extra), 1);
        let order: Vec<_> = report.limits.iter().map(|l| l.window_id.as_str()).collect();
        assert_eq!(order, vec!["5h", "monthly", "balance"]);
        assert_eq!(report.limits[0].percent, 10.0, "omp 的窗口读数不被探针覆盖");
        assert_eq!(report.limits[1].limit, Some(70.0));
    }

    #[test]
    fn merge_missing_limits_skips_monthly_without_limit() {
        let mut report = ProviderUsageReport {
            provider: "commandcode".into(),
            plan_type: None,
            account_label: None,
            fetched_at: 1,
            limits: vec![],
        };
        let monthly_only = UsageLimit {
            id: "monthly".into(),
            label: "Monthly".into(),
            window_id: "monthly".into(),
            window_label: "Monthly".into(),
            used_fraction: 0.0,
            percent: 0.0,
            status: "ok".into(),
            resets_at: None,
            duration_ms: None,
            notes: vec![],
            used: None,
            limit: None,
            remaining: Some(5.0),
            unit: "credits".into(),
        };
        assert_eq!(merge_missing_limits(&mut report, vec![monthly_only]), 0);
        assert!(report.limits.is_empty(), "没有上限的月度只是余额的另一种说法，不补");
    }

    #[test]
    fn commandcode_status_reflects_exceeded_and_thresholds() {
        let out = r#"{"credits":{"monthlyCredits":1},"windowLimits":{
          "fiveHour":{"used":14,"cap":14,"exceeded":true,"resetAt":1},
          "weekly":{"used":30,"cap":35,"exceeded":false,"resetAt":2}}}"#;
        let v: serde_json::Value = serde_json::from_str(out).unwrap();
        let limits = parse_commandcode_credits(&v, None, None).unwrap();
        assert_eq!(limits[0].status, "exhausted", "exceeded=true → exhausted");
        assert_eq!(limits[1].status, "warning", "85.7% → warning");
        assert_eq!(limits[2].status, "warning", "月度 69/70 = 98.6% → warning");
    }

    #[test]
    fn commandcode_missing_data_is_an_error_not_a_fake_zero() {
        assert!(parse_commandcode_credits(&serde_json::json!({}), None, None).is_err());
        assert!(parse_commandcode_credits(&serde_json::json!({"credits":{}}), None, None).is_err());
        // 只有窗口、没有 credits 也成立
        let only_window = serde_json::json!({"windowLimits":{"fiveHour":{"used":1,"cap":2,"resetAt":3}}});
        let limits = parse_commandcode_credits(&only_window, None, None).unwrap();
        assert_eq!(limits.len(), 1);
    }

    /// deepseek 官方文档（api-docs.deepseek.com/zh-cn/api/get-user-balance）的响应形状。
    #[test]
    fn deepseek_maps_balance_lines() {
        let v = serde_json::json!({
            "is_available": true,
            "balance_infos": [
                { "currency": "CNY", "total_balance": "110.00", "granted_balance": "10.00", "topped_up_balance": "100.00" }
            ]
        });
        let limits = parse_deepseek_balance(&v).unwrap();
        assert_eq!(limits.len(), 1);
        assert_eq!(limits[0].window_id, "balance");
        assert_eq!(limits[0].remaining, Some(110.0));
        assert_eq!(limits[0].unit, "cny");
        assert_eq!(limits[0].status, "ok");

        let unavailable = serde_json::json!({
            "is_available": false,
            "balance_infos": [{ "currency": "USD", "total_balance": "0.00" }]
        });
        let limits = parse_deepseek_balance(&unavailable).unwrap();
        assert_eq!(limits[0].status, "exhausted");
        assert_eq!(limits[0].unit, "usd");
    }

    #[test]
    fn deepseek_without_balance_is_an_error() {
        assert!(parse_deepseek_balance(&serde_json::json!({})).is_err());
        assert!(parse_deepseek_balance(&serde_json::json!({"is_available": true, "balance_infos": []})).is_err());
    }

    #[test]
    fn short_error_prefers_machine_readable_message() {
        assert_eq!(
            short_error(r#"{"success":false,"error":{"code":"UNAUTHORIZED","status":401,"message":"You're logged out."}}"#),
            "You're logged out."
        );
        assert_eq!(short_error("plain text line\nsecond"), "plain text line");
        assert_eq!(short_error(""), "");
    }

    /// 真实 commandcode 端到端（默认跳过；`cargo test -- --ignored` 手动跑）：
    /// 本机装了 omp 且配了 commandcode 凭据时，跑真实 `omp token` + 真实 HTTP，
    /// **alpha 端点漂移会在这里先炸**。无凭据 / 离线时跳过（打印原因）。
    #[test]
    #[ignore]
    fn real_commandcode_probe() {
        let bin = std::env::var("OMP_BIN").unwrap_or_else(|_| "omp".into());
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        match rt.block_on(probe(&bin, "commandcode")) {
            Ok(limits) => {
                assert!(limits.len() >= 2, "至少有 5 小时 / 每周两档窗口");
                for l in &limits {
                    println!(
                        "  {} window={} used={:?}/{:?} percent={:.2}% remaining={:?} unit={} status={} resetsAt={:?}",
                        l.id, l.window_id, l.used, l.limit, l.percent, l.remaining, l.unit, l.status, l.resets_at
                    );
                }
                let monthly = limits.iter().find(|l| l.window_id == "monthly");
                if let Some(m) = monthly {
                    println!("月度（官方页面同口径）：已用 {:.2}% / 总额 {:?} / 剩余 {:?}", m.percent, m.limit, m.remaining);
                }
            }
            Err(e) => eprintln!("跳过：commandcode 探针不可用（{e}）"),
        }
    }

    /// 真实 omp 原生报告 + 壳侧补月度（默认跳过）：omp 18.12 的 commandcode 报告只有
    /// 5h / 7d / balance，`run_probes` 必须把月度插在 balance 之前。无 omp / 无凭据时跳过。
    #[test]
    #[ignore]
    fn real_native_commandcode_report_gets_monthly() {
        let bin = std::env::var("OMP_BIN").unwrap_or_else(|_| "omp".into());
        let Ok(out) = std::process::Command::new(&bin)
            .args(["usage", "--json"])
            .stdin(std::process::Stdio::null())
            .output()
        else {
            eprintln!("跳过：无法运行 {bin}（设 OMP_BIN 指定路径）");
            return;
        };
        if !out.status.success() {
            eprintln!("跳过：omp usage 退出码 {:?}", out.status.code());
            return;
        }
        let mut usage = crate::provider_usage::parse_usage_json(&String::from_utf8_lossy(&out.stdout))
            .expect("真实输出必须能解析");
        let Some(_index) = usage.reports.iter().position(|r| r.provider == "commandcode") else {
            eprintln!("跳过：本机 commandcode 没有原生报告");
            return;
        };
        // 模型目录缓存冷启动时 configured_providers 是空的：补月度不能依赖它
        usage.configured_providers.clear();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        let failures = rt.block_on(run_probes(&bin, &mut usage));
        for f in &failures {
            eprintln!("补查失败 {}：{}", f.provider, f.message);
        }
        let report = usage.reports.iter().find(|r| r.provider == "commandcode").expect("报告还在");
        let monthly = report.limits.iter().find(|l| l.window_id == "monthly").expect("月度窗口必须补上");
        assert!(monthly.limit.is_some(), "planId / cap 组合反查不到月总额会让月度退化成余额行：{monthly:?}");
        let order: Vec<_> = report.limits.iter().map(|l| l.window_id.as_str()).collect();
        if let Some(balance_at) = order.iter().position(|w| *w == "balance") {
            let monthly_at = order.iter().position(|w| *w == "monthly").unwrap();
            assert!(monthly_at < balance_at, "月度要排在余额之前：{order:?}");
        }
        println!("原生 commandcode 报告补月度：{order:?} / 已用 {:.2}% / {:?}/{:?}", monthly.percent, monthly.used, monthly.limit);
    }

    // ---------- 2026-09-30 新增探针的解析单测（fixture 形状取自各官方文档） ----------

    #[test]
    fn openrouter_prefers_account_credits_then_key_limit_then_spend() {
        // 管理密钥：账户级 credits 差
        let credits = Ok(serde_json::json!({"data":{"total_credits":100.5,"total_usage":25.75}}));
        let key = Ok(serde_json::json!({"data":{"limit":null,"limit_remaining":null,"usage":25.75}}));
        let rows = parse_openrouter(key, credits).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].remaining, Some(74.75));
        assert_eq!(rows[0].unit, "usd");
        assert_eq!(rows[0].status, "ok");

        // 普通 key（/credits 403）：per-key 剩余额度
        let credits = Err("HTTP 403：Only management keys can perform this operation".into());
        let key = Ok(serde_json::json!({"data":{"limit":100,"limit_remaining":74.5,"limit_reset":"monthly","usage":25.5}}));
        let rows = parse_openrouter(key, credits).unwrap();
        assert_eq!(rows[0].remaining, Some(74.5));
        assert!(rows[0].notes.iter().any(|n| n.contains("monthly")));

        // 没设 per-key 上限、也拿不到 credits：退化为「已消费」
        let credits = Err("HTTP 403".into());
        let key = Ok(serde_json::json!({"data":{"limit":null,"limit_remaining":null,"usage":25.5}}));
        let rows = parse_openrouter(key, credits).unwrap();
        assert_eq!(rows[0].window_id, "spent");
        assert_eq!(rows[0].remaining, None);
        assert_eq!(rows[0].used, Some(25.5));

        // 两个都失败 → 错误（保留 key 侧的原始错误）
        assert!(parse_openrouter(Err("HTTP 500：boom".into()), Err("HTTP 403".into())).is_err());
    }

    #[test]
    fn vercel_credits_parses_string_amounts() {
        let v = serde_json::json!({"balance":"95.50","total_used":"4.50"});
        let rows = parse_vercel_credits(&v).unwrap();
        assert_eq!(rows[0].remaining, Some(95.5));
        assert_eq!(rows[0].unit, "usd");
        assert!(rows[0].notes[0].contains("4.50"));
        assert!(parse_vercel_credits(&serde_json::json!({})).is_err());
    }

    #[test]
    fn moonshot_balance_maps_currency_by_site() {
        let v = serde_json::json!({"code":0,"status":true,"data":{"available_balance":110.5,"voucher_balance":10.0,"cash_balance":100.5}});
        let rows = parse_moonshot_balance(&v, "usd").unwrap();
        assert_eq!(rows[0].remaining, Some(110.5));
        assert_eq!(rows[0].unit, "usd");
        assert!(rows[0].notes.iter().any(|n| n.contains("voucher 10.00")));

        let rows = parse_moonshot_balance(&v, "cny").unwrap();
        assert_eq!(rows[0].unit, "cny");

        let err = parse_moonshot_balance(&serde_json::json!({"code":401,"message":"x"}), "usd").unwrap_err();
        assert!(err.contains("401"), "{err}");
    }

    #[test]
    fn siliconflow_user_info_maps_total_balance() {
        let v = serde_json::json!({"code":20000,"message":"OK","status":true,"data":{"balance":"0.88","chargeBalance":"88.00","totalBalance":"88.88"}});
        let rows = parse_siliconflow_user(&v).unwrap();
        assert_eq!(rows[0].remaining, Some(88.88));
        assert!(rows[0].notes.iter().any(|n| n.contains("recharged 88.00")));
        let err = parse_siliconflow_user(&serde_json::json!({"code":30014,"data":null,"message":"Token is invalid."})).unwrap_err();
        assert!(err.contains("30014"), "{err}");
    }

    #[test]
    fn stepfun_account_maps_balance_and_breakdown() {
        let v = serde_json::json!({"object":"account","type":"prepaid","balance":0.0,"total_cash_balance":0.0,"total_voucher_balance":26.0});
        let rows = parse_stepfun_account(&v).unwrap();
        assert_eq!(rows[0].remaining, Some(0.0));
        assert_eq!(rows[0].status, "exhausted");
        assert_eq!(rows[0].unit, "cny");
        assert!(rows[0].notes.iter().any(|n| n.contains("voucher 26.00")));
    }

    #[test]
    fn novita_balance_scales_ten_thousandths() {
        let v = serde_json::json!({"availableBalance":"1000000","cashBalance":"800000","creditLimit":"200000","pendingCharges":"0","outstandingInvoices":"0"});
        let rows = parse_novita_balance(&v).unwrap();
        assert_eq!(rows[0].remaining, Some(100.0));
        assert!(rows[0].notes.iter().any(|n| n.contains("cash 80.00")));
        assert!(rows[0].notes.iter().any(|n| n.contains("credit limit 20.00")));
        assert!(!rows[0].notes.iter().any(|n| n.contains("pending")), "0 值 pending 不进 notes");
    }

    #[test]
    fn deepinfra_negative_stripe_balance_is_available() {
        let v = serde_json::json!({"stripe_balance":-12.5,"recent":3.25,"suspended":false});
        let rows = parse_deepinfra_checklist(&v).unwrap();
        assert_eq!(rows[0].remaining, Some(12.5));
        assert_eq!(rows[0].status, "ok");

        let owed = serde_json::json!({"stripe_balance":7.0,"suspended":true,"suspend_reason":"payment-method"});
        let rows = parse_deepinfra_checklist(&owed).unwrap();
        assert_eq!(rows[0].remaining, Some(0.0));
        assert_eq!(rows[0].status, "exhausted");
        assert!(rows[0].notes.iter().any(|n| n.contains("owed 7.00")));
        assert!(rows[0].notes.iter().any(|n| n.contains("payment-method")));
    }

    #[test]
    fn aimlapi_and_aiand_use_their_currency_field() {
        let rows = parse_aimlapi_billing(&serde_json::json!({"current_balance":42.5,"currency":"USD"})).unwrap();
        assert_eq!((rows[0].remaining, rows[0].unit.as_str()), (Some(42.5), "usd"));
        let rows = parse_aiand_balance(&serde_json::json!({"balance":"1234.5","currency":"jpy"})).unwrap();
        assert_eq!((rows[0].remaining, rows[0].unit.as_str()), (Some(1234.5), "jpy"));
    }

    #[test]
    fn nanogpt_and_kilo_balances() {
        let rows = parse_nanogpt_balance(
            &serde_json::json!({"usd_balance":"129.46956147","nano_balance":"26.71801147","nanoDepositAddress":"nano_x"}),
        )
        .unwrap();
        assert!((rows[0].remaining.unwrap() - 129.46956147).abs() < 1e-9);
        assert!(rows[0].notes.iter().any(|n| n.contains("nano 26.72")));

        let rows = parse_kilo_balance(&serde_json::json!({"balance":12.75})).unwrap();
        assert_eq!(rows[0].remaining, Some(12.75));
        assert_eq!(rows[0].unit, "usd");
    }

    #[test]
    fn venice_prefers_usd_and_honors_can_consume() {
        let v = serde_json::json!({"canConsume":true,"consumptionCurrency":"USD","balances":{"diem":5.0,"usd":12.5},"diemEpochAllocation":5.0});
        let rows = parse_venice_balance(&v).unwrap();
        assert_eq!(rows[0].remaining, Some(12.5));
        assert_eq!(rows[0].unit, "usd");
        assert!(rows[0].notes.iter().any(|n| n.contains("diem 5.00")));

        let blocked = serde_json::json!({"canConsume":false,"balances":{"usd":0.0}});
        let rows = parse_venice_balance(&blocked).unwrap();
        assert_eq!(rows[0].status, "exhausted");

        let diem_only = serde_json::json!({"canConsume":true,"balances":{"diem":3.0,"usd":null}});
        let rows = parse_venice_balance(&diem_only).unwrap();
        assert_eq!((rows[0].remaining, rows[0].unit.as_str()), (Some(3.0), "diem"));
    }

    #[test]
    fn zenmux_balance_and_success_flag() {
        let v = serde_json::json!({"success":true,"data":{"currency":"usd","total_credits":120.0,"top_up_credits":100.0,"bonus_credits":20.0}});
        let rows = parse_zenmux_balance(&v).unwrap();
        assert_eq!(rows[0].remaining, Some(120.0));
        assert!(rows[0].notes.iter().any(|n| n.contains("bonus 20.00")));
        assert!(parse_zenmux_balance(&serde_json::json!({"success":false})).is_err());
    }

    #[test]
    fn minimax_cn_token_plan_windows() {
        let v = serde_json::json!({
            "base_resp": {"status_code": 0},
            "model_remains": [
                {
                    "model_name": "general",
                    "start_time": 1790000000000i64, "end_time": 1790018000000i64,
                    "current_interval_remaining_percent": 72.5,
                    "current_interval_total_count": 40, "current_interval_usage_count": 11,
                    "current_interval_status": 1,
                    "weekly_start_time": 1790000000000i64, "weekly_end_time": 1790604800000i64,
                    "current_weekly_remaining_percent": 10.0,
                    "current_weekly_total_count": 200, "current_weekly_usage_count": 180,
                    "current_weekly_status": 1
                },
                { "model_name": "no-quota", "current_interval_total_count": 0, "current_weekly_total_count": 0 }
            ]
        });
        let rows = parse_minimax_token_plan(&v).unwrap();
        assert_eq!(rows.len(), 2, "无配额的模型跳过");
        assert_eq!(rows[0].window_id, "5h");
        assert!((rows[0].percent - 27.5).abs() < 1e-9);
        assert_eq!(rows[0].status, "ok");
        assert_eq!(rows[0].resets_at, Some(1790018000000));
        assert_eq!(rows[0].notes, vec!["Requests: 11/40".to_string()]);
        assert_eq!(rows[0].label, "General 5 Hour");
        assert_eq!(rows[1].window_id, "7d");
        assert!((rows[1].percent - 90.0).abs() < 1e-9);
        assert_eq!(rows[1].status, "warning");

        let err = parse_minimax_token_plan(&serde_json::json!({"base_resp":{"status_code":1004,"status_msg":"login fail"}})).unwrap_err();
        assert!(err.contains("1004"), "{err}");
    }

    #[test]
    fn err_status_and_explain_auth() {
        assert_eq!(err_status("HTTP 401：invalid key"), Some(401));
        assert_eq!(err_status("网络请求失败：timeout"), None);
        assert_eq!(explain_auth("HTTP 403：nope".into(), "需要 Management Key"), "需要 Management Key（HTTP 403：nope）");
        assert_eq!(explain_auth("网络请求失败：x".into(), "hint"), "网络请求失败：x");
    }

    /// 真实端点路由核对（默认跳过；`cargo test -- --ignored` 手动跑）：用**无效 key** 对
    /// 全部补充探针各打一次真实端点——验证：路由存在（不是 404 / DNS 失败）、401 / 业务码
    /// 被正确归一成可读消息、解析层不 panic。**只发查询请求（GET / 语义只读的 POST），
    /// 不发任何写操作**。
    #[test]
    #[ignore]
    fn real_extra_probe_routes() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        let mut unexpected = vec![];
        for provider in EXTRA_PROBES {
            match rt.block_on(probe_with_key(provider, "omp-inn-invalid-probe-key")) {
                Ok(rows) => unexpected.push(format!("{provider}: 无效 key 却返回了 {} 行", rows.len())),
                Err(e) => println!("  {provider}: {e}"),
            }
        }
        assert!(unexpected.is_empty(), "以下探针行为异常：{unexpected:?}");
    }
}
