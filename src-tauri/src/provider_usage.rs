//! 供应商用量（Provider usage）：把 `omp usage --json` 报的各供应商限额窗口
//! （5 小时滚动 / 每周 / 每月）映射到设置页「供应商用量」。
//!
//! **与 `usage.rs` 的分工**：那边统计的是**本地**会话 jsonl 的 token 消耗（设置 › 使用统计），
//! 这边展示的是**供应商侧**的配额窗口——只有 omp 自己拿得到（各 provider 的上游用量接口），
//! 壳侧不直连任何配额 API、不读凭证库，只解析 `omp usage --json` 的输出（与供应商页走
//! `omp auth-broker` 同款做法）。V6 曾在输入框上下文条给过同一份数据的入口（当时的
//! `quota.rs`，已删除），V11 随聊天界面删除，本模块是它在设置页的恢复版。
//!
//! 上游事实（omp 18.2.1 / 18.2.5 实测）：
//! - `omp usage --json` 输出 `{generatedAt, reports[], accountsWithoutUsage[], disabledCredentials[], capacity{}}`；
//!   `reports[].limits[]` 是各窗口：`{id, label, scope, window{id,label,resetsAt,durationMs?,resetLabel?},
//!   amount{used,usedFraction,remainingFraction,unit}, status, notes?}`。
//! - **无数据 = `reports: []` + 退出码 0**（未认证 / 上游失败都是这个形状），
//!   所以**不能靠退出码判断失败**——空报告是正常结果，不是错误。
//! - 时间戳（`generatedAt` / `fetchedAt` / `window.resetsAt`）全是 **epoch 毫秒整数**（不是 ISO 串）；
//!   `amount.used` 是 0–100 刻度，`usedFraction` / `remainingFraction` 是 0–1 小数。
//! - `window.durationMs` 对 monthly **缺失**（月窗锚定订阅周年日，不是固定时长），一律按可选解析。
//! - `window` / `amount` / `status` 都可能缺席（上游按 provider 自定义），全按可选解析：
//!   `id` 在就保留这条窗口，其余缺什么补中性值。
//! - `metadata`（`planType` / `email` / `accountId` / `orgName` …）是 provider 自定义对象，
//!   字段不保证存在——多账号时用它做行标识，没有就不显示。
//! - 调用成本：冷启动约 1s，omp 自身报告缓存命中约 0.2s；`fetchedAt` 是**数据真实抓取时刻**，
//!   `generatedAt` 是本次渲染时刻（两者之差即缓存年龄，界面用来标「更新于 N 前」）。
//! - JSON 里的账号身份字段（email 等）可能包含本地身份信息，**只回传、不落盘、不上报**。
//!
//! **只读**：不调 `omp usage invalidate`（那是清缓存的写操作，会改 omp 状态）。

use serde::Serialize;
use tauri::State;

use crate::commands::{cmd_err, discover_omp_path, AppState, CmdError};

// ---------- 视图类型 ----------

/// 一个限额窗口（5 小时 / 每周 / 每月…）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimit {
    /// omp 的窗口 id（`rolling-5h` / `weekly` / `monthly`；未知值原样透传）。
    pub id: String,
    /// 上游展示名（`5 Hour limit`）——本应用按 `window_id` 走字典，这里只作兜底。
    pub label: String,
    /// 窗口标识（`5h` / `7d` / `monthly`）；语义归类用它，不用 `id`。
    pub window_id: String,
    /// 窗口短名（`5 Hour` / `Weekly` / `Monthly`）。
    pub window_label: String,
    /// 已用比例（0–1 小数；超限时可能 >1，原样透传）。
    pub used_fraction: f64,
    /// 已用百分比（0–100 刻度，同上）。
    pub percent: f64,
    /// 上游状态（`ok` / `warning` / `exhausted`；开放枚举，未知值原样透传）。
    pub status: String,
    /// 下次重置时刻（epoch 毫秒；上游没给为 None）。
    pub resets_at: Option<i64>,
    /// 窗口时长（毫秒；monthly 恒缺省）。
    pub duration_ms: Option<i64>,
    /// 上游备注（如套餐说明、超卖提示）；没有为空数组。
    pub notes: Vec<String>,
    /// 金额 / 数量绝对值（**仅非 percent 单位有意义**；percent 单位时全为 None，避免把 0–100 刻度当绝对值用）。
    pub used: Option<f64>,
    /// 额度上限（与 `used` 同单位；余额型窗口没有上限时为 None）。
    pub limit: Option<f64>,
    /// 剩余额（余额型窗口的主值；上游没给为 None）。
    pub remaining: Option<f64>,
    /// 计量单位：`percent`（0–100）/ `usd` / `cny` / `credits` / `tokens` …（开放枚举，原样透传）。
    pub unit: String,
}

/// 一个供应商的用量报告（一个账号一份——同一 provider 多账号时有多份）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsageReport {
    pub provider: String,
    /// 套餐名（`OpenCode Go`）；上游没给为 None。
    pub plan_type: Option<String>,
    /// 账号标识（email / accountId / orgName 里第一个可用的）；多账号区分用，单账号通常为 None。
    pub account_label: Option<String>,
    /// 数据真实抓取时刻（epoch 毫秒；0 = 上游未给）。
    pub fetched_at: i64,
    pub limits: Vec<UsageLimit>,
}

/// 已认证但本次拿不到用量的账号（上游明细，界面给一行说明）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreportedAccount {
    pub provider: String,
    /// `api_key` / `oauth`。
    pub kind: String,
    pub email: Option<String>,
    pub account_id: Option<String>,
}

/// 被自动停用的凭据（刷新失败 / 上游失效；界面提示需重新登录）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisabledCredential {
    pub provider: String,
    pub kind: String,
    pub email: Option<String>,
    pub account_id: Option<String>,
    /// 停用原因（上游英文原文）；上游没给为 None。
    pub cause: Option<String>,
    /// 停用时刻（epoch 毫秒）；上游没给为 None。
    pub disabled_at_ms: Option<i64>,
}

/// 补充探针（壳侧查询，见 `extra_usage.rs`）的失败记录：这些供应商**能查**但这次没查到，
/// 界面显示「查询失败 + 原因」，与「无用量数据」（上游根本没有探针）区分开。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraProbeFailure {
    pub provider: String,
    pub message: String,
}

/// 用量总览（前端只格式化与按比例画条，不重算）。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    /// 本次渲染时刻（epoch 毫秒）。
    pub generated_at: i64,
    pub reports: Vec<ProviderUsageReport>,
    /// 已认证但这个供应商没有探针 / 这次没报用量的账号明细。
    pub accounts_without_usage: Vec<UnreportedAccount>,
    pub disabled_credentials: Vec<DisabledCredential>,
    /// 已配置的供应商 id（取自模型目录，与设置页「已配置」同一条口径）。
    ///
    /// **为什么需要它**：`omp usage` 只报**有探针**的供应商，没探针的（如 V6 实测的
    /// `commandcode`——omp 有它的 api-key 登录但没有它的用量实现）连
    /// `accountsWithoutUsage` 都不出现，全量输出里等于不存在。界面拿这份集合减去
    /// `reports`，才能把「配了这个供应商，但上游没给用量」如实说出来，而不是静默少一块。
    pub configured_providers: Vec<String>,
    /// 补充探针（壳侧查询，见 `extra_usage.rs`）的失败记录；没有失败为空数组。
    pub extra_failures: Vec<ExtraProbeFailure>,
}

// ---------- 解析（纯函数，可测） ----------

fn text_of(v: Option<&serde_json::Value>) -> Option<&str> {
    v.and_then(|x| x.as_str()).filter(|s| !s.trim().is_empty())
}

/// 数字字段：JSON 里是整数（毫秒 / 百分比），但按 f64 读以兼容小数刻度。
fn num_of(v: Option<&serde_json::Value>) -> Option<f64> {
    v.and_then(|x| x.as_f64().or_else(|| x.as_i64().map(|i| i as f64)))
}

fn int_of(v: Option<&serde_json::Value>) -> Option<i64> {
    num_of(v).map(|f| f as i64)
}

/// 解析一个限额窗口。只要求 `id` 存在（其余全容错：老版本 / 新 provider 缺字段都不该让整块消失）。
fn parse_limit(v: &serde_json::Value) -> Option<UsageLimit> {
    let id = text_of(v.get("id"))?.to_string();
    let window = v.get("window");
    let scope = v.get("scope");
    let window_id = text_of(window.and_then(|w| w.get("id")))
        .or_else(|| text_of(scope.and_then(|s| s.get("windowId"))))
        .unwrap_or(&id)
        .to_string();
    let label = text_of(v.get("label")).map(str::to_string).unwrap_or_else(|| id.clone());
    let window_label = text_of(window.and_then(|w| w.get("label")))
        .map(str::to_string)
        .unwrap_or_else(|| label.clone());
    // 单位与绝对值：`unit = percent` 时 `used` 是 0–100 刻度，其它单位（usd / credits / tokens…）
    // 是绝对值——两种语义不能混进同一个字段，percent 型一律把绝对值面清空。
    let amount = v.get("amount");
    let unit = text_of(amount.and_then(|a| a.get("unit"))).unwrap_or("percent").to_string();
    let is_percent = unit == "percent";
    let raw_used = num_of(amount.and_then(|a| a.get("used")));
    let raw_limit = num_of(amount.and_then(|a| a.get("limit")));
    let raw_remaining = num_of(amount.and_then(|a| a.get("remaining")));
    let used_pct = raw_used.filter(|_| is_percent);
    // 比例与百分比：优先同源取 `usedFraction`；缺了用绝对值的 used/limit；再缺用 percent 刻度折算
    let used_fraction = num_of(amount.and_then(|a| a.get("usedFraction")))
        .or_else(|| match (raw_used, raw_limit) {
            (Some(u), Some(l)) if l > 0.0 => Some(u / l),
            _ => None,
        })
        .or_else(|| used_pct.map(|p| p / 100.0))
        .unwrap_or(0.0);
    let notes = v
        .get("notes")
        .and_then(|n| n.as_array())
        .map(|arr| arr.iter().filter_map(|n| text_of(Some(n)).map(str::to_string)).collect())
        .unwrap_or_default();
    Some(UsageLimit {
        id,
        label,
        window_id,
        window_label,
        used_fraction,
        percent: used_pct.unwrap_or(used_fraction * 100.0),
        status: text_of(v.get("status")).unwrap_or("ok").to_string(),
        resets_at: int_of(window.and_then(|w| w.get("resetsAt"))),
        duration_ms: int_of(window.and_then(|w| w.get("durationMs"))),
        notes,
        used: raw_used.filter(|_| !is_percent),
        limit: raw_limit.filter(|_| !is_percent),
        remaining: raw_remaining.filter(|_| !is_percent),
        unit,
    })
}

/// 账号标识：email → accountId → orgName 里第一个可用的（上游字段全可选）。
fn account_label(meta: Option<&serde_json::Value>) -> Option<String> {
    ["email", "accountId", "orgName"]
        .iter()
        .find_map(|k| text_of(meta.and_then(|m| m.get(*k))).map(str::to_string))
}

fn parse_report(v: &serde_json::Value) -> Option<ProviderUsageReport> {
    let provider = text_of(v.get("provider"))?.to_string();
    let limits = v
        .get("limits")
        .and_then(|l| l.as_array())
        .map(|arr| arr.iter().filter_map(parse_limit).collect())
        .unwrap_or_default();
    let metadata = v.get("metadata");
    Some(ProviderUsageReport {
        provider,
        plan_type: text_of(metadata.and_then(|m| m.get("planType"))).map(str::to_string),
        account_label: account_label(metadata),
        fetched_at: int_of(v.get("fetchedAt")).unwrap_or(0),
        limits,
    })
}

fn parse_unreported(v: &serde_json::Value) -> Option<UnreportedAccount> {
    Some(UnreportedAccount {
        provider: text_of(v.get("provider"))?.to_string(),
        kind: text_of(v.get("type")).unwrap_or("unknown").to_string(),
        email: text_of(v.get("email")).map(str::to_string),
        account_id: text_of(v.get("accountId")).map(str::to_string),
    })
}

fn parse_disabled(v: &serde_json::Value) -> Option<DisabledCredential> {
    Some(DisabledCredential {
        provider: text_of(v.get("provider"))?.to_string(),
        kind: text_of(v.get("type")).unwrap_or("unknown").to_string(),
        email: text_of(v.get("email")).map(str::to_string),
        account_id: text_of(v.get("accountId")).map(str::to_string),
        cause: text_of(v.get("cause")).map(str::to_string),
        disabled_at_ms: int_of(v.get("disabledAtMs")),
    })
}

/// 解析 `omp usage --json` 的输出。
///
/// **空 `reports` 是正常结果**（没有任何供应商报用量），不是错误；只有「输出根本不是 JSON」
/// 才算失败——界面据此区分「没有可显示的用量」与「读取失败」。
pub fn parse_usage_json(out: &str) -> Result<ProviderUsage, String> {
    let v: serde_json::Value =
        serde_json::from_str(out.trim()).map_err(|e| format!("输出不是合法 JSON：{e}"))?;
    let items = |key: &str| -> Vec<&serde_json::Value> {
        v.get(key)
            .and_then(|x| x.as_array())
            .map(|a| a.iter().collect())
            .unwrap_or_default()
    };
    Ok(ProviderUsage {
        generated_at: int_of(v.get("generatedAt")).unwrap_or(0),
        reports: items("reports").into_iter().filter_map(parse_report).collect(),
        accounts_without_usage: items("accountsWithoutUsage").into_iter().filter_map(parse_unreported).collect(),
        disabled_credentials: items("disabledCredentials").into_iter().filter_map(parse_disabled).collect(),
        // 由命令层用模型目录补齐（解析层不碰第二次调用，保持纯函数可测）
        configured_providers: vec![],
        // 同上：由命令层跑补充探针（见 extra_usage.rs）
        extra_failures: vec![],
    })
}

// ---------- 命令 ----------

fn omp_bin(state: &State<'_, AppState>) -> Result<String, CmdError> {
    discover_omp_path(state).ok_or_else(|| {
        cmd_err(
            "OMP_MISSING",
            "未找到 omp，无法读取供应商用量".into(),
            Some("请先在设置 ›「关于」里指定 omp 路径".into()),
        )
    })
}

/// 各供应商的滚动用量：跑 `omp usage --json` 并解析（**只读**，不动 omp 缓存）。
///
/// 「已配置供应商」**只从模型目录的内存缓存里取，绝不自己跑 `omp models --json`**：
/// 那条命令冷启动实测约 **10 秒**（要逐个供应商探测），用量刷新不该被它拖住——
/// 而供应商集合是慢变量，缓存过期也照用；完全没有缓存时才不带这份数据
/// （界面退化为不显示「无用量数据」的说明行，等模型目录自然刷新后下一次就有了）。
#[tauri::command]
pub async fn get_provider_usage(state: State<'_, AppState>) -> Result<ProviderUsage, CmdError> {
    let bin = omp_bin(&state)?;
    let out = crate::providers::run_omp(&bin, &["usage", "--json"])
        .await
        .map_err(|e| cmd_err("PROVIDER_USAGE_FAILED", format!("读取供应商用量失败：{e}"), None))?;
    let mut usage = parse_usage_json(&out)
        .map_err(|e| cmd_err("PROVIDER_USAGE_PARSE_FAILED", format!("供应商用量解析失败：{e}"), None))?;
    if let Some((_, catalog)) = state.models_cache.lock().await.clone() {
        let mut configured: Vec<String> =
            crate::providers::configured_set(&catalog).into_iter().collect();
        configured.sort();
        usage.configured_providers = configured;
    }
    // 补充探针：omp 没有实现的供应商（deepseek 等）由壳侧补查；omp 已报的 commandcode
    // 也补它缺的月度窗口（omp 18.12 只报 5h / 每周 / 余额，见 extra_usage.rs）
    usage.extra_failures = crate::extra_usage::run_probes(&bin, &mut usage).await;
    Ok(usage)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本机实测（omp 18.2.5 / opencode-go，2026-09-18）的真实输出，逐字节照抄。
    const REAL: &str = r#"{
      "generatedAt": 1789717791117,
      "reports": [
        {
          "provider": "opencode-go",
          "fetchedAt": 1789717741696,
          "limits": [
            {
              "id": "rolling-5h",
              "label": "5 Hour limit",
              "scope": { "provider": "opencode-go", "windowId": "5h", "shared": true },
              "window": { "id": "5h", "label": "5 Hour", "resetsAt": 1789728611833, "durationMs": 18000000 },
              "amount": { "used": 8, "usedFraction": 0.08, "remainingFraction": 0.92, "unit": "percent" },
              "status": "ok"
            },
            {
              "id": "weekly",
              "label": "Weekly limit",
              "scope": { "provider": "opencode-go", "windowId": "7d", "shared": true },
              "window": { "id": "7d", "label": "Weekly", "resetsAt": 1789948800833, "durationMs": 604800000 },
              "amount": { "used": 91, "usedFraction": 0.91, "remainingFraction": 0.09, "unit": "percent" },
              "status": "warning"
            },
            {
              "id": "monthly",
              "label": "Monthly limit",
              "scope": { "provider": "opencode-go", "windowId": "monthly", "shared": true },
              "window": { "id": "monthly", "label": "Monthly", "resetsAt": 1791784779833 },
              "amount": { "used": 46, "usedFraction": 0.46, "remainingFraction": 0.54, "unit": "percent" },
              "status": "ok"
            }
          ],
          "metadata": { "planType": "OpenCode Go", "endpoint": "https://opencode.ai/zen/go/v1/usage" }
        }
      ],
      "accountsWithoutUsage": [],
      "disabledCredentials": [],
      "capacity": { "opencode-go": [] }
    }"#;

    #[test]
    fn parses_real_output_window_by_window() {
        let u = parse_usage_json(REAL).expect("真实输出应能解析");
        assert_eq!(u.generated_at, 1789717791117);
        assert_eq!(u.reports.len(), 1);
        let r = &u.reports[0];
        assert_eq!(r.provider, "opencode-go");
        assert_eq!(r.plan_type.as_deref(), Some("OpenCode Go"));
        assert_eq!(r.account_label, None, "实测 metadata 没有身份字段时不编造");
        assert_eq!(r.fetched_at, 1789717741696);
        assert_eq!(r.limits.len(), 3, "三档窗口都要在");

        let h5 = &r.limits[0];
        assert_eq!((h5.id.as_str(), h5.window_id.as_str()), ("rolling-5h", "5h"));
        assert_eq!(h5.window_label, "5 Hour");
        assert_eq!(h5.percent, 8.0);
        assert!((h5.used_fraction - 0.08).abs() < 1e-9);
        assert_eq!(h5.status, "ok");
        assert_eq!(h5.resets_at, Some(1789728611833));
        assert_eq!(h5.duration_ms, Some(18_000_000));
        assert!(h5.notes.is_empty());

        let weekly = &r.limits[1];
        assert_eq!(weekly.window_id, "7d");
        assert_eq!(weekly.status, "warning");
        assert_eq!(weekly.duration_ms, Some(604_800_000));
    }

    #[test]
    fn monthly_window_has_no_duration() {
        let u = parse_usage_json(REAL).expect("真实输出应能解析");
        let monthly = &u.reports[0].limits[2];
        assert_eq!(monthly.id, "monthly");
        assert_eq!(monthly.duration_ms, None, "月窗锚定订阅周年日，上游不给 durationMs");
        assert_eq!(monthly.resets_at, Some(1791784779833), "但重置时刻照给");
    }

    #[test]
    fn empty_reports_is_ok_not_an_error() {
        let u = parse_usage_json(r#"{"generatedAt": 1, "reports": [], "capacity": {}}"#)
            .expect("空报告是正常结果（未认证 / 上游没数据），不是错误");
        assert!(u.reports.is_empty());
        assert!(u.accounts_without_usage.is_empty());
        assert!(u.disabled_credentials.is_empty());
    }

    #[test]
    fn broken_output_is_an_error() {
        assert!(parse_usage_json("").is_err());
        assert!(parse_usage_json("Error: something went wrong").is_err());
        assert!(parse_usage_json("[1,2,3]").is_ok(), "数组不是对象：按缺字段处理，不算解析失败");
    }

    #[test]
    fn tolerates_missing_fields_and_skips_limits_without_id() {
        let out = r#"{
          "reports": [
            { "provider": "p1", "limits": [
              { "id": "weekly", "amount": { "used": 80, "unit": "percent" } },
              { "amount": { "used": 50 } },
              { "id": "" }
            ] }
          ]
        }"#;
        let u = parse_usage_json(out).expect("缺字段不该炸");
        let r = &u.reports[0];
        assert_eq!(r.plan_type, None);
        assert_eq!(r.account_label, None);
        assert_eq!(r.fetched_at, 0);
        assert_eq!(r.limits.len(), 1, "缺 id / 空 id 的窗口直接跳过");
        let w = &r.limits[0];
        // 只有 `used`（unit = percent）时按 0–100 刻度折算比例
        assert_eq!(w.percent, 80.0);
        assert!((w.used_fraction - 0.8).abs() < 1e-9);
        assert_eq!(w.window_id, "weekly", "缺 window.id 时退回 limits[].id");
        assert_eq!(w.window_label, "weekly", "缺 window.label 时退回 label");
        assert_eq!((w.resets_at, w.duration_ms), (None, None));
        assert_eq!(w.status, "ok", "缺 status 按 ok");
        assert!(w.notes.is_empty(), "缺 notes 按空数组");
    }

    #[test]
    fn keeps_provider_order_exhausted_status_and_notes() {
        let out = r#"{
          "generatedAt": 9,
          "reports": [
            { "provider": "a", "limits": [ { "id": "monthly", "window": { "id": "monthly" }, "amount": { "usedFraction": 1.0 }, "status": "exhausted", "notes": ["overage billed"] } ] },
            { "provider": "b", "limits": [] }
          ],
          "accountsWithoutUsage": [{ "provider": "c", "type": "oauth", "email": "c@example.com" }],
          "disabledCredentials": [
            { "provider": "d", "type": "oauth", "email": "d@example.com", "cause": "oauth refresh failed", "disabledAtMs": 42 },
            { "provider": "e" }
          ]
        }"#;
        let u = parse_usage_json(out).expect("应能解析");
        assert_eq!(
            u.reports.iter().map(|r| r.provider.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"],
            "顺序保持上游给的（前端再把当前供应商提前）"
        );
        assert_eq!(u.reports[0].limits[0].status, "exhausted");
        assert_eq!(u.reports[0].limits[0].notes, vec!["overage billed"]);
        assert_eq!(u.accounts_without_usage.len(), 1);
        assert_eq!(u.accounts_without_usage[0].email.as_deref(), Some("c@example.com"));
        assert_eq!(u.disabled_credentials.len(), 2);
        assert_eq!(u.disabled_credentials[0].cause.as_deref(), Some("oauth refresh failed"));
        assert_eq!(u.disabled_credentials[0].disabled_at_ms, Some(42));
        assert_eq!(u.disabled_credentials[1].kind, "unknown");
    }

    #[test]
    fn account_label_prefers_email_then_account_id() {
        let out = r#"{
          "reports": [
            { "provider": "anthropic", "limits": [], "metadata": { "email": "me@example.com", "accountId": "acc-1" } },
            { "provider": "anthropic", "limits": [], "metadata": { "accountId": "acc-2", "orgName": "Org" } },
            { "provider": "anthropic", "limits": [], "metadata": { "orgName": "Org only" } },
            { "provider": "anthropic", "limits": [] }
          ]
        }"#;
        let u = parse_usage_json(out).expect("应能解析");
        assert_eq!(u.reports[0].account_label.as_deref(), Some("me@example.com"));
        assert_eq!(u.reports[1].account_label.as_deref(), Some("acc-2"));
        assert_eq!(u.reports[2].account_label.as_deref(), Some("Org only"));
        assert_eq!(u.reports[3].account_label, None);
    }

    /// 真实 `omp usage --json` 端到端（默认跳过；`cargo test -- --ignored` 手动跑）：
    /// 本机已装 omp 且至少一个供应商可用时，跑真实命令并确认输出能被解析——
    /// **上游 schema 漂移会在这里先炸**，而不是等用户打开设置页看到「解析失败」。
    /// 无凭据（exit 1）是合法环境（CI），跳过不当失败，只把 stderr 尾部打出来供核对。
    #[test]
    #[ignore]
    fn real_omp_usage_json_parses() {
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
            let err = String::from_utf8_lossy(&out.stderr);
            let tail = err.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("");
            eprintln!("跳过：omp usage 退出码 {:?}（{tail}）", out.status.code());
            return;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let usage = parse_usage_json(&text).expect("真实输出必须能解析");
        println!(
            "reports={} accountsWithoutUsage={} disabled={}",
            usage.reports.len(),
            usage.accounts_without_usage.len(),
            usage.disabled_credentials.len()
        );
        for r in &usage.reports {
            println!(
                "  {} plan={:?} account={:?} limits={}",
                r.provider,
                r.plan_type,
                r.account_label,
                r.limits.iter().map(|l| format!("{}({})", l.window_id, l.percent)).collect::<Vec<_>>().join(", ")
            );
            for l in &r.limits {
                assert!(!l.id.is_empty(), "每条窗口必须有 id（skip 掉才是异常）");
            }
        }
    }
}
