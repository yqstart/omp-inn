import { useEffect } from "react";
import { Database, Speedometer } from "reicon-react";
import type { SessionLiveStats } from "@shared/types";
import { contextPercent, fmtTokens } from "../../lib/ctxUsage";
import { fmt } from "../../lib/locale";
import { useProviderUsage } from "../../lib/providerUsage";
import {
 LIVE_STATS_RUNNING_MS,
 fmtHitRate,
 fmtSpan,
 fmtTps,
 liveStatsReadable,
 liveTokensReadable,
 loadSessionLiveStats,
 useSessionLiveStats,
} from "../../lib/sessionLiveStats";
import { hasUsageEntry } from "../../lib/usageLimits";
import { useDropdown } from "../../lib/useDropdown";
import { usePopoverAnchor } from "../../lib/usePopoverAnchor";
import { useText } from "../../lib/useText";
import { useApp } from "../../stores/app";
import { UsageLimits } from "../composer/UsageLimits";
import { ContextMeter } from "./ContextMeter";

/**
 * 输入卡**底部统计条**（2026-10-16，对齐 DeepSeek Harness 的 composer dock）：
 *
 * ```
 * ⊘ 7 轮 259 步 · 230 tok/s   🗄 63.6M tok · 缓存命中 99%   ◐ 46%   ⛽ 41% · 5 小时
 * ```
 *
 * 四项从左到右：**会话统计**（轮 / 步 / 吞吐，点开是模型用时 · 工具用时 · TTFT 平均 · 输出速度）、
 * **Token 用量**（累计总量 + 缓存命中率，点开是四项分解）、**上下文占用**（容量环，点开是分项）、
 * **供应商用量**（最紧窗口读数，点开是全部供应商的全部窗口）。前三项与 DH 逐项对应，
 * 第四项是上游没有、本应用补的（omp 拿得到配额，入口从工具行搬到这里）。
 *
 * 口径（都是 omp 真值 / 会话记录的聚合，前端只格式化，见 `lib/sessionLiveStats.ts`）：
 * - 门槛与 DH 一致：**整条**在四项都没内容时不渲染（不占版面、不留空行）；
 *   会话统计项要求「步数 > 0」，Token 项要求「计费输入或输出非 0」，上下文 / 供应商各自
 *   沿用原有门槛（没有真值就不出现）；
 * - 收敛：打开会话拉一次；**运行中每 3 秒**回读（读数随步推进），终态翻转再拉一次拿终值
 *   ——omp 不推这类投影，只能这样收敛；失败保留旧值，不打断阅读。
 * - **独占一行、整条靠右**（2026-10-16 用户口径）：它是**输入卡外部**的一行（2026-10-20 用户口径：
 *   从卡片内部移到卡片下方；`Composer` 里挂在卡片 `div` 之外、与卡片同宽的容器里），`justify-end`
 *   让四项贴整卡右缘排。**不许**塞进工具行那个 `flex flex-wrap` 容器——那样它只是行尾的又一个
 *   flex item，会与模型 / 思考档 / 发送键**同行**（用户实测的错位）；也不再放回卡片内部。
 * - **浮层的包含块 = 本统计条根**（`relative` 在根上，四项的按钮包装器**不许**自带 `relative`：
 *   它一旦定位就成了浮层的包含块，`lib/usePopoverAnchor` 的实测也就失去基准），但**水平位置跟随被点的项**
 *   （2026-10-16 用户口径）——只贴条缘展开的浮层离按钮很远（用户实测：点中间的容量环、浮层跑到卡片最右侧）；
 *   纯 CSS 兜底（`right-0`）只在无布局环境下生效。
 *   为什么不用「相对按钮 left-0」：窄窗口下统计条会 `flex-wrap` 换行、用量项可能落到行首，相对按钮的
 *   宽浮层会向左溢出输入卡、被中列的 `overflow-hidden` 裁掉（用户实测：浮层左半截看不见）。
 *   现在的做法两头兼顾：包含块仍是整条（`max-w-full` 保证不超出），水平位置由实测夹在 `[0, 条宽 − 浮层宽]`。
 */
export function SessionStatsBar() {
 const sid = useApp((s) => s.activeSessionId);
 const status = useApp((s) => (sid ? s.statusBySession[sid]?.state : undefined));
 const snap = useSessionLiveStats(sid);
 // 上下文 / 供应商两项的可见性判据（容器决定整条要不要露面，子项内部同一判据）
 const ctxPct = contextPercent(useApp((s) => s.currentRuntime?.contextUsage));
 const usage = useProviderUsage();
 const running = status === "running" || status === "awaiting-approval";
 const stats = snap.data;

 useEffect(() => {
  if (!sid) return;
  void loadSessionLiveStats(sid, true);
 }, [sid, running]);

 useEffect(() => {
  if (!sid || !running) return;
  const timer = window.setInterval(() => void loadSessionLiveStats(sid, true), LIVE_STATS_RUNNING_MS);
  return () => window.clearInterval(timer);
 }, [sid, running]);

 const showStats = liveStatsReadable(stats);
 const showTokens = liveTokensReadable(stats);
 const showUsage = hasUsageEntry(usage.data, usage.error);
 if (!showStats && !showTokens && ctxPct == null && !showUsage) return null;

 return (
  <div className="relative flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5 px-2 pt-0.5 pb-0.5 text-[11px] text-faint">
   {showStats && stats && <TurnStatsItem stats={stats} />}
   {showTokens && stats && <TokenStatsItem stats={stats} />}
   <ContextMeter />
   <UsageLimits />
  </div>
 );
}

/** 会话统计项（轮 / 步 · 吞吐）：点开是四行用时与速度。 */
function TurnStatsItem({ stats }: { stats: SessionLiveStats }) {
 const t = useText();
 const open = useApp((s) => s.composerMenu === "liveStats");
 const setOpen = (v: boolean) => useApp.setState({ composerMenu: v ? "liveStats" : null });
 const ref = useDropdown(open, () => setOpen(false));
 const { anchorRef, panelRef } = usePopoverAnchor<HTMLButtonElement>(open);
 // 四行各自独立判断（上游同口径）：该聚合为 0 就不出那一行，全为 0 时整项不可点
 const rows: { label: string; value: string }[] = [];
 if (stats.modelMs > 0) rows.push({ label: t.liveStatsModelTime, value: fmtSpan(stats.modelMs, t) });
 if (stats.toolMs > 0) rows.push({ label: t.liveStatsToolTime, value: fmtSpan(stats.toolMs, t) });
 if (stats.ttftMs != null) rows.push({ label: t.liveStatsTtftAvg, value: fmtSpan(stats.ttftMs, t) });
 if (stats.tps != null) rows.push({ label: t.liveStatsTpsLabel, value: fmt(t.liveStatsTpsValue, fmtTps(stats.tps)) });
 const clickable = rows.length > 0;
 return (
  <div ref={ref}>
   <button
    ref={anchorRef}
    onClick={() => clickable && setOpen(!open)}
    disabled={!clickable}
    className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 whitespace-nowrap transition-colors duration-100 enabled:cursor-pointer enabled:hover:bg-hover disabled:cursor-default"
    aria-label={fmt(t.liveStatsTurnsAria, stats.turns, stats.steps)}
    aria-expanded={open}
    title={t.liveStatsTurnsTitle}
   >
    <Speedometer size={13} aria-hidden className="shrink-0 text-muted" />
    <span className="font-mono text-muted tabular-nums">{fmt(t.liveStatsTurns, stats.turns, stats.steps)}</span>
    {stats.tps != null && (
     <>
      <span aria-hidden className="text-faint/60">
       ·
      </span>
      <span className="font-mono text-muted tabular-nums">{fmt(t.liveStatsTpsValue, fmtTps(stats.tps))}</span>
     </>
    )}
   </button>
   {open && clickable && (
    <div
     ref={panelRef}
     className="absolute right-0 bottom-full z-10 mb-1 w-72 max-w-full rounded-lg border border-border bg-elevated p-3 shadow-pop"
     aria-label={t.statsTitle}
    >
     <div className="flex items-baseline justify-between gap-2">
      <span className="text-[13px] font-semibold">{t.statsTitle}</span>
      <span className="font-mono text-[11px] text-muted tabular-nums">
       {fmt(t.liveStatsRoundsSummary, stats.turns, stats.steps, stats.toolCalls)}
      </span>
     </div>
     <div className="mt-2 flex flex-col gap-1">
      {rows.map((r) => (
       <div key={r.label} className="flex items-baseline gap-3 text-[13px]">
        <span className="text-muted">{r.label}</span>
        <span className="ml-auto font-mono text-foreground tabular-nums">{r.value}</span>
       </div>
      ))}
     </div>
    </div>
   )}
  </div>
 );
}

/** Token 用量项（累计总量 · 缓存命中）：点开是分项分解。 */
function TokenStatsItem({ stats }: { stats: SessionLiveStats }) {
 const t = useText();
 const locale = useApp((s) => s.locale);
 const open = useApp((s) => s.composerMenu === "liveTokens");
 const setOpen = (v: boolean) => useApp.setState({ composerMenu: v ? "liveTokens" : null });
 const ref = useDropdown(open, () => setOpen(false));
 const { anchorRef, panelRef } = usePopoverAnchor<HTMLButtonElement>(open);
 const numLocale = locale === "zh-CN" ? "zh-CN" : "en-US";
 const n = (v: number) => v.toLocaleString(numLocale);
 const tok = stats.tokens;
 const billed = tok.input + tok.cacheRead + tok.cacheWrite;
 const rows: { label: string; value: string }[] = [];
 if (stats.cacheHitRate != null) rows.push({ label: t.liveStatsHitRateLabel, value: fmtHitRate(stats.cacheHitRate) });
 rows.push({ label: t.liveStatsUncachedInput, value: n(tok.input) });
 rows.push({ label: t.liveStatsCacheReadLabel, value: n(tok.cacheRead) });
 if (tok.cacheWrite > 0) rows.push({ label: t.liveStatsCacheWriteLabel, value: n(tok.cacheWrite) });
 rows.push({ label: t.liveStatsOutputLabel, value: n(tok.output) });
 if (tok.reasoning > 0) rows.push({ label: t.liveStatsReasoningLabel, value: n(tok.reasoning) });
 if (stats.cost > 0) rows.push({ label: t.liveStatsCostLabel, value: `$${stats.cost.toFixed(2)}` });
 return (
  <div ref={ref}>
   <button
    ref={anchorRef}
    onClick={() => setOpen(!open)}
    className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 whitespace-nowrap transition-colors duration-100 hover:bg-hover"
    aria-label={fmt(t.liveStatsTokensAria, fmtTokens(billed + tok.output, numLocale), stats.cacheHitRate == null ? "—" : fmtHitRate(stats.cacheHitRate))}
    aria-expanded={open}
    title={t.liveStatsTokensTitle}
   >
    <Database size={13} aria-hidden className="shrink-0 text-muted" />
    <span className="font-mono text-muted tabular-nums">{fmt(t.liveStatsTokensInline, fmtTokens(billed + tok.output, numLocale))}</span>
    {stats.cacheHitRate != null && (
     <>
      <span aria-hidden className="text-faint/60">
       ·
      </span>
      <span className="font-mono text-muted tabular-nums">{fmt(t.liveStatsCacheHitInline, fmtHitRate(stats.cacheHitRate))}</span>
     </>
    )}
   </button>
   {open && (
    <div
     ref={panelRef}
     className="absolute right-0 bottom-full z-10 mb-1 w-80 max-w-full rounded-lg border border-border bg-elevated p-3 shadow-pop"
     aria-label={t.liveStatsTokensTitle}
    >
     <div className="flex items-baseline justify-between gap-2">
      <span className="text-[13px] font-semibold">{t.liveStatsTokensTitle}</span>
      <span className="font-mono text-[11px] text-muted tabular-nums">{fmt(t.liveStatsTokensInline, n(billed + tok.output))}</span>
     </div>
     <div className="mt-2 flex flex-col gap-1">
      {rows.map((r) => (
       <div key={r.label} className="flex items-baseline gap-3 text-[13px]">
        <span className="text-muted">{r.label}</span>
        <span className="ml-auto font-mono text-foreground tabular-nums">{r.value}</span>
       </div>
      ))}
     </div>
    </div>
   )}
  </div>
 );
}
