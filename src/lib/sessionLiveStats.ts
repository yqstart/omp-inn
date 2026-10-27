import { useSyncExternalStore } from "react";
import { api } from "@shared/api";
import type { SessionLiveStats } from "@shared/types";
import { fmt, type Text } from "./locale";

/**
 * 会话累计统计条（输入卡底部）的数据层：按会话 id 的模块级快照 + 单飞拉取 + 新鲜度节流。
 *
 * 数据源是后端 `get_session_live_stats`（只读会话 jsonl 聚合，口径见 `live_stats.rs` 模块头）。
 * omp 不推这类投影（上游 DH 是自己事件级增量折叠，我们没有这条链路），所以收敛靠两件事：
 * **运行中**每 [`LIVE_STATS_RUNNING_MS`] 回读一次（读数随步推进），**终态翻转**再回读一次拿终值
 * ——节流与单飞都在这里，组件只负责调用。
 *
 * 失败**保留上一份数据**（继续显示旧值，不闪空）；拉不到不影响阅读，不弹错。
 */

/** 新鲜度阈值：距上次成功拉取不足这么久就不重复拉（重挂载 / 会话切换共用）。 */
export const LIVE_STATS_FRESH_MS = 2000;
/** 运行中的回读间隔（一轮进行中读数会涨；空闲时不刷）。 */
export const LIVE_STATS_RUNNING_MS = 3000;

export type LiveStatsSnapshot = {
 data: SessionLiveStats | null;
 error: string | null;
 loading: boolean;
 /** 本地最近一次**成功**拉取时刻（epoch 毫秒；0 = 还没成功过）。 */
 fetchedAt: number;
};

/** 没有该会话记录时的空快照（引用稳定，`useSyncExternalStore` 要求）。 */
const EMPTY: LiveStatsSnapshot = { data: null, error: null, loading: false, fetchedAt: 0 };

const snapshots = new Map<string, LiveStatsSnapshot>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function emit(sid: string, next: LiveStatsSnapshot): void {
 snapshots.set(sid, next);
 for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
 listeners.add(fn);
 return () => {
  listeners.delete(fn);
 };
}

/** 某个会话的统计快照（读不到给空快照）。 */
export function liveStatsSnapshot(sid: string | null): LiveStatsSnapshot {
 return (sid && snapshots.get(sid)) || EMPTY;
}

/** 订阅某个会话的统计快照的 React hook。 */
export function useSessionLiveStats(sid: string | null): LiveStatsSnapshot {
 return useSyncExternalStore(
  subscribe,
  () => liveStatsSnapshot(sid),
 );
}

/**
 * 拉一次会话统计（节流 + 单飞）。
 * - `force = false` 且 2 秒内已成功拉过 → 直接跳过；
 * - 进行中的请求被复用（运行中的定时回读与终态回读可能撞在一起）。
 */
export function loadSessionLiveStats(sid: string, force = false): Promise<void> {
 const cur = snapshots.get(sid);
 if (!force && cur?.data && Date.now() - cur.fetchedAt < LIVE_STATS_FRESH_MS) return Promise.resolve();
 const flying = inflight.get(sid);
 if (flying) return flying;
 emit(sid, { data: cur?.data ?? null, error: cur?.error ?? null, loading: true, fetchedAt: cur?.fetchedAt ?? 0 });
 const p = api
  .getSessionLiveStats(sid)
  .then((data) => {
   emit(sid, { data, error: null, loading: false, fetchedAt: Date.now() });
  })
  .catch((e: unknown) => {
   emit(sid, {
    data: cur?.data ?? null,
    error: e instanceof Error ? e.message : String(e),
    loading: false,
    fetchedAt: cur?.fetchedAt ?? 0,
   });
  })
  .finally(() => {
   inflight.delete(sid);
  });
 inflight.set(sid, p);
 return p;
}

/** 会话被归档 / 删除时清掉它的统计缓存（与事件流缓存同一处调用，见 `dropSessionCaches`）。 */
export function forgetSessionLiveStats(sid: string): void {
 snapshots.delete(sid);
 inflight.delete(sid);
}

/** 单测隔离用：清空全部缓存。 */
export function __resetSessionLiveStats(): void {
 snapshots.clear();
 inflight.clear();
 listeners.clear();
}

// ---------- 展示口径（纯函数，组件与单测共用） ----------

/**
 * 会话统计项该不该露面（与上游 DH 同一门槛）：**步数为 0 且没有任何 token 就不渲染**
 * （新建会话 / 还没落盘的会话不占版面）；文件读不全时也不显示（宁可没有，不给偏低的数字）。
 */
export function liveStatsReadable(stats: SessionLiveStats | null): boolean {
 if (!stats || stats.truncated) return false;
 return stats.steps > 0 || stats.tokens.total > 0;
}

/** Token 项该不该露面：计费输入或输出有一项非 0（同 DH 的 `hasTokens`）。 */
export function liveTokensReadable(stats: SessionLiveStats | null): boolean {
 if (!stats || stats.truncated) return false;
 const t = stats.tokens;
 return t.input + t.cacheRead + t.cacheWrite > 0 || t.output > 0;
}

/**
 * 耗时口径（对齐 DeepSeek Harness 的「2 分 42 秒」）：<1 分钟给一位小数的秒，
 * <1 小时给「N 分 N 秒」，再长给「N 小时 N 分」——不显示毫秒，也不四舍五入成「0 秒」。
 */
export function fmtSpan(ms: number, t: Text): string {
 const total = Math.max(0, ms) / 1000;
 if (total < 60) return fmt(t.spanSec, total.toFixed(1));
 const secs = Math.floor(total);
 const m = Math.floor(secs / 60);
 const s = secs % 60;
 if (m < 60) return fmt(t.spanMinSec, m, s);
 const h = Math.floor(m / 60);
 return fmt(t.spanHourMin, h, m % 60);
}

/** 输出速度：≥10 取整、<10 留一位小数（与上游 DH 的 `formatTokensPerSecond` 同规矩）。 */
export function fmtTps(tps: number): string {
 return tps >= 10 ? String(Math.round(tps)) : tps.toFixed(1);
}

/** 缓存命中率：整数百分比（DH 的 `formatCacheHitPercent` 默认档）。 */
export function fmtHitRate(rate: number): string {
 return `${Math.round(rate * 100)}%`;
}
