import { useSyncExternalStore } from "react";
import { api } from "@shared/api";
import type { ProviderUsage, ProviderUsageDisabled, ProviderUsageReport, UsageLimit } from "@shared/types";
import { fmt, type Locale, type Text } from "./locale";

/**
 * 供应商用量（设置 ›「供应商用量」）的数据层：拉取（节流 + 单飞）、模块级快照订阅、
 * 以及告警档 / 相对时间这类纯函数。
 *
 * 数据源是后端的 `get_provider_usage`（跑 `omp usage --json`）——上游只有 omp 自己
 * 拿得到各供应商的配额窗口，壳侧只格式化、只读。V6 曾在输入框上下文条展示同一份
 * 数据（`lib/usageLimits.ts`），V11 随聊天界面删除；这里是它在设置页的恢复版。
 */

/** 新鲜度阈值：距上次成功拉取不足这么久就不重复拉（切页签回来 / 重挂载时用）。 */
export const USAGE_FRESH_MS = 60_000;

/** 用量快照（模块级；组件经 `useProviderUsage` 订阅）。 */
export type ProviderUsageSnapshot = {
 data: ProviderUsage | null;
 error: string | null;
 loading: boolean;
 /** 本地最近一次**成功**拉取时刻（epoch 毫秒；0 = 还没成功过）。节流用它。 */
 fetchedAt: number;
};

let snapshot: ProviderUsageSnapshot = { data: null, error: null, loading: false, fetchedAt: 0 };
const listeners = new Set<() => void>();
/** 同一时刻只允许一个请求在飞（重挂载 + 手动刷新可能同时触发）。 */
let inflight: Promise<void> | null = null;

function emit(next: ProviderUsageSnapshot): void {
 snapshot = next;
 for (const fn of listeners) fn();
}

export function providerUsageSnapshot(): ProviderUsageSnapshot {
 return snapshot;
}

export function subscribeProviderUsage(fn: () => void): () => void {
 listeners.add(fn);
 return () => {
  listeners.delete(fn);
 };
}

/** 订阅用量快照的 React hook（模块级 store，不占全局 Zustand）。 */
export function useProviderUsage(): ProviderUsageSnapshot {
 return useSyncExternalStore(subscribeProviderUsage, providerUsageSnapshot);
}

/**
 * 拉一次用量（节流 + 单飞）。
 *
 * - `force = false` 且距上次成功拉取不到 [`USAGE_FRESH_MS`] 时直接跳过；
 * - 失败**保留上一份数据**（界面继续显示旧值 + 一行错误），不闪空；
 * - 单飞：进行中的请求被复用，重复点击不会叠请求。
 */
export function loadProviderUsage(force = false): Promise<void> {
 if (!force && snapshot.data && Date.now() - snapshot.fetchedAt < USAGE_FRESH_MS) {
  return Promise.resolve();
 }
 if (inflight) return inflight;
 emit({ ...snapshot, loading: true });
 inflight = api
  .getProviderUsage()
  .then((usage) => {
   emit({ data: usage, error: null, loading: false, fetchedAt: Date.now() });
  })
  .catch((e: unknown) => {
   emit({ ...snapshot, error: e instanceof Error ? e.message : String(e), loading: false });
  })
  .finally(() => {
   inflight = null;
  });
 return inflight;
}

// ---------- 纯函数（组件与单测共用） ----------

/** 一个供应商分组：同 provider 的全部报告（多账号 = 多份报告，保持上游顺序）。 */
export type ProviderGroup = {
 provider: string;
 reports: ProviderUsageReport[];
};

/** 按 provider 把报告分组（保持上游顺序；多账号时同组多份报告）。 */
export function groupReports(reports: ProviderUsageReport[]): ProviderGroup[] {
 const groups: ProviderGroup[] = [];
 const index = new Map<string, ProviderGroup>();
 for (const r of reports) {
  let g = index.get(r.provider);
  if (!g) {
   g = { provider: r.provider, reports: [] };
   index.set(r.provider, g);
   groups.push(g);
  }
  g.reports.push(r);
 }
 return groups;
}

/** 报告里最新的数据抓取时刻（epoch 毫秒；没有任何报告时为 null）。界面「更新于 N 前」用它。 */
export function latestFetchedAt(usage: ProviderUsage | null): number | null {
 let latest = 0;
 for (const r of usage?.reports ?? []) {
  if (r.fetchedAt > latest) latest = r.fetchedAt;
 }
 return latest > 0 ? latest : null;
}

/** 告警档：对齐 omp 自己的判定阈值（≥80% 或 status=warning 警告、用尽 exhausted 或 ≥100%）。 */
export function levelOf(limit: UsageLimit): "ok" | "warn" | "danger" {
 if (limit.status === "exhausted" || limit.usedFraction >= 1) return "danger";
 if (limit.status === "warning" || limit.usedFraction >= 0.8) return "warn";
 return "ok";
}

/** 比例：≥10% 取整，小比例留一位小数（接收 0–100 的百分数，与使用统计同口径）。 */
export function fmtPercent(pct: number): string {
 return pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
}

/** 已知货币符号（补充探针的 `unit` 是货币小写码；omp 上游同口径给 `usd`）。 */
const CURRENCY_SYMBOLS: Record<string, string> = { usd: "$", cny: "¥" };

/** 金额 / 数量文案：已知货币走符号 + 两位小数；其它单位「数字 + 单位」。 */
export function fmtAmount(unit: string, value: number): string {
 const symbol = CURRENCY_SYMBOLS[unit.toLowerCase()];
 if (symbol) return `${symbol}${value.toFixed(2)}`;
 const text = Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
 return `${text} ${unit}`;
}

/** 不带单位的数字（「已用 / 上限」这种同单位一对值时用；整数不打小数点，小数最多两位）。 */
function fmtBareNumber(value: number): string {
 const rounded = Math.round(value * 100) / 100;
 return Number.isInteger(rounded) ? rounded.toLocaleString() : rounded.toFixed(2);
}

/**
 * 「已用 / 上限」文案（`$0.31 / $14.00`、`64.64 / 70 credits`）；两个绝对值都有才有，
 * 否则 null（界面回退百分比或剩余额）。同一单位只写一次，避免 `70.00 credits / 70.00 credits`。
 */
export function usedLimitText(l: UsageLimit): string | null {
 if (l.used === null || l.limit === null) return null;
 const symbol = CURRENCY_SYMBOLS[l.unit.toLowerCase()];
 if (symbol) return `${symbol}${l.used.toFixed(2)} / ${symbol}${l.limit.toFixed(2)}`;
 const unit = l.unit ? ` ${l.unit}` : "";
 return `${fmtBareNumber(l.used)} / ${fmtBareNumber(l.limit)}${unit}`;
}

/** 「剩余额」文案（`$54.77`）；只在没有上限时用（余额型窗口）。 */
export function remainingText(l: UsageLimit): string | null {
 if (l.remaining === null || l.limit !== null) return null;
 return fmtAmount(l.unit, l.remaining);
}

/** 该行要不要画进度条：百分比窗口（用 usedFraction）或带上限的金额窗口都画；纯余额不画。 */
export function hasBar(l: UsageLimit): boolean {
 return l.unit === "percent" || (l.used !== null && l.limit !== null);
}

/**
 * 一个窗口的读数（设置页卡片与输入卡浮层**共用这一条口径**，别各写一份）：
 * 有比例的窗口 = 百分比；纯余额窗口（没有上限）=「$X 剩余」；无比例也无上限的计数型窗口 = 数量原文。
 *
 * `percent` 字段缺省是 0——**不能拿它当读数**（把 deepseek 的 api 余额窗口显示成
 * 「Balance 0.0% + 空进度条」就是这么来的：percent 没意义、条也不该画）。真的一无所有时给 `—`。
 * `title` = 状态词（有金额细节时带上 `$已用 / $上限`，余额型带剩余额，上游 notes 附后），
 * 悬停可见；颜色不作唯一信号。
 */
export function limitReading(t: Text, limit: UsageLimit): {
 bar: boolean;
 text: string;
 title: string;
 state: string;
 level: "ok" | "warn" | "danger";
} {
 const level = levelOf(limit);
 const state = level === "danger" ? t.pusageStateDanger : level === "warn" ? t.pusageStateWarn : t.pusageStateOk;
 const money = usedLimitText(limit);
 const remaining = remainingText(limit);
 const bar = hasBar(limit);
 const text = bar
  ? fmtPercent(limit.percent)
  : remaining !== null
   ? fmt(t.pusageRemaining, remaining)
   : limit.used !== null
    ? fmtAmount(limit.unit, limit.used)
    : "—";
 // 悬停细节：状态 + 绝对值（余额型给剩余额）+ 上游备注
 const details = [state];
 if (money !== null) details.push(money);
 else if (!bar && remaining !== null) details.push(remaining);
 for (const note of limit.notes) details.push(note);
 return { bar, text, state, level, title: details.join(" · ") };
}

/**
 * 一份报告内逐窗口的显示名（整组一起算，不能只看单个窗口）。
 *
 * 同一报告里多个窗口共享一个 windowId 时（omp 给 cursor 的 `monthly` 上挂着
 * `Cursor Models` / `Other Models` / `gpt-4 requests` 三个池子），行名一律用**上游 label**
 * 区分——否则三行都显示「每月」，分不清哪个是哪个池子；上游也没给具体名
 * （label 与 windowLabel 相同）时回退字典名，保持通用供应商的本地化口径。
 */
export function windowNames(t: Text, limits: UsageLimit[]): string[] {
 // 先找出重复出现的 windowId（动态 membership，Set 的用途正当）
 const seen = new Set<string>();
 const repeated = new Set<string>();
 for (const l of limits) {
  if (seen.has(l.windowId)) repeated.add(l.windowId);
  seen.add(l.windowId);
 }
 return limits.map((l) => {
  if (repeated.has(l.windowId) && l.label !== l.windowLabel) return l.label;
  if (l.windowId === "5h") return t.pusageWindow5h;
  if (l.windowId === "7d") return t.pusageWindow7d;
  if (l.windowId === "monthly") return t.pusageWindowMonthly;
  if (l.windowId === "balance") return t.pusageWindowBalance;
  if (l.windowId === "spent") return t.pusageWindowSpent;
  return l.windowLabel || l.label;
 });
}

/**
 * 配了但上游没给用量的供应商（`configuredProviders` − `reports` − 停用凭据 − 补充探针失败的，
 * 保持字母序）。`omp usage` 只对有探针的供应商报配额，没探针的连 `accountsWithoutUsage`
 * 都不出现——界面必须把「配了却看不到」如实说出来，而不是静默少一块；
 * 停用的凭据与补充探针**失败的**各有专门块（那两块的语义是「有路径但这次没拿到」，
 * 不是「没有查询路径」），从这份清单里排除。
 *
 * 这里的「停用凭据」用的是**上游原始清单**（含用户主动登出的墓碑）——登出的供应商整个不该
 * 再进「无用量数据」块，显示侧的收窄（哪些要提示）在 `disabledCredentialsToWarn`。
 */
export function providersWithoutUsage(usage: ProviderUsage | null): string[] {
 const configured = usage?.configuredProviders ?? [];
 if (configured.length === 0) return [];
 const withData = new Set((usage?.reports ?? []).map((r) => r.provider));
 const failed = new Set((usage?.extraFailures ?? []).map((f) => f.provider));
 const disabled = new Set((usage?.disabledCredentials ?? []).map((d) => d.provider));
 return configured.filter((p) => !withData.has(p) && !failed.has(p) && !disabled.has(p));
}

/**
 * 「已停用的凭据」警示块要显示的条目：剔掉**用户主动动作的墓碑**（登出 / 删除 / 被替换），
 * 其余（刷新失败 / 上游失效……）照旧提示「重新登录该供应商即可恢复」。
 *
 * `logged out by user` 是 `omp auth-broker logout <provider>`（应用自己的供应商页「登出」即它）
 * 对凭据做的**软删**——本机 `agent.db` 实测 `disabled_cause = "logged out by user"`，行留在库里、
 * `omp usage --json` **每次**照报（上游 18.8.6 的 `gyi()` 只过滤 `deleted by user` / `replaced by …`
 * 两类，登出这类故意留着）。登出是用户要的结果：在应用里登出后弹窗再红字教你重新登录，是
 * 自相矛盾；而且墓碑长期留在库里（不会自己消失），不滤掉会一直提示。
 *
 * 别拿这份清单去算「无用量数据」（`providersWithoutUsage` 用的是上游原始清单，登出的供应商
 * 整个不该再出现在那块里）。
 */
export function disabledCredentialsToWarn(usage: ProviderUsage | null): ProviderUsageDisabled[] {
 // 上游 cause 原文前缀，大小写不敏感（后两类上游自己就过滤了，一并兜住保持口径一致）
 const actioned = /^(logged out by user|deleted by user|replaced by)/i;
 return (usage?.disabledCredentials ?? []).filter((d) => !(d.cause && actioned.test(d.cause)));
}

/**
 * 相对时长（中英文各一套写法）。粒度：<1 分钟 / 分钟 / 小时+分 / 天+小时。
 * 这属于数据层展示文本（同「更新于 N 前」），不走字典。
 */
export function formatDuration(ms: number, locale: Locale): string {
 const zh = locale !== "en";
 const min = Math.max(0, Math.floor(ms / 60_000));
 if (min < 1) return zh ? "不到 1 分钟" : "<1m";
 if (min < 60) return zh ? `${min} 分钟` : `${min}m`;
 const h = Math.floor(min / 60);
 const m = min % 60;
 if (h < 24) {
  if (m === 0) return zh ? `${h} 小时` : `${h}h`;
  return zh ? `${h} 小时 ${m} 分` : `${h}h ${m}m`;
 }
 const d = Math.floor(h / 24);
 const rh = h % 24;
 if (rh === 0) return zh ? `${d} 天` : `${d}d`;
 return zh ? `${d} 天 ${rh} 小时` : `${d}d ${rh}h`;
}

/** 「N 前」：报告更新时间用（`formatDuration` + 本地化后缀）。 */
export function formatAgo(ms: number, locale: Locale): string {
 const d = formatDuration(ms, locale);
 return locale === "en" ? `${d} ago` : `${d}前`;
}
