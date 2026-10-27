import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "@shared/api";
import { useApp } from "../../stores/app";
import { fmt } from "../../lib/locale";
import { useText } from "../../lib/useText";
import { HEAT_MODES, heatLevel, heatModels, heatThresholds, heatValues, monthTicks, type HeatMode } from "../../lib/usageHeat";
import type { UsageHeatRow, UsageStats } from "@shared/types";

/** 统计范围：与 ZCode 的「使用统计」同档（今日 / 近 7 日 / 近 30 日 / 全部）。 */
type RangeKey = "today" | "7d" | "30d" | "all";

const RANGES: { key: RangeKey; days: number | null }[] = [
 { key: "today", days: 1 },
 { key: "7d", days: 7 },
 { key: "30d", days: 30 },
 { key: "all", days: null },
];

/** token 数：过万转 K / M / B（密集表格里可读性优先），小数字走千分位。 */
function fmtTokens(n: number, locale: string): string {
 if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
 if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
 if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`;
 return n.toLocaleString(locale);
}

/** 比例：≥10% 取整，小比例留一位小数。 */
function fmtPercent(x: number): string {
 return x >= 0.1 ? `${Math.round(x * 100)}%` : `${(x * 100).toFixed(1)}%`;
}

/** 一张总览卡：标签（11px faint）+ 数值（mono）+ 可选副行（过长换行，不截断关键数字）。 */
function Tile({ label, value, sub }: { label: string; value: string; sub?: ReactNode }) {
 return (
  <div className="min-w-0 rounded-md bg-surface p-4">
   <div className="text-[11px] leading-4 text-faint">{label}</div>
   <div className="mt-2 truncate font-mono text-[18px] font-medium tabular-nums" title={value}>
    {value}
   </div>
   {sub && <div className="mt-2 text-[11px] leading-relaxed text-muted">{sub}</div>}
  </div>
 );
}

/** 热力图色档：0 档空格 + 4 档 accent 由浅到深（单强调色靠透明度分级，不引第二配色）。 */
const HEAT_LEVEL_CLASS = ["bg-active", "bg-accent/20", "bg-accent/45", "bg-accent/70", "bg-accent"];

/**
 * 「Token 活动」热力图：一列一周（周日在最上）、一行一天，颜色越重用量越多。
 *
 * 数据是后端给的最近 53 周（**不随上方范围切换**）；右上三档只换每个格子的取值口径
 * （每日 = 当天 / 每周 = 整周合计 / 累计 = 窗口起点到当天），格子与布局完全不变——
 * 切换不发请求、不重扫。格子随面板宽度自适应（53 列铺满一行），底部是按列对齐的月份刻度。
 */
function Heatmap({ cells, numLocale }: { cells: UsageHeatRow[]; numLocale: string }) {
 const t = useText();
 const cardRef = useRef<HTMLElement>(null);
 const [mode, setMode] = useState<HeatMode>("day");
 /** 悬停的格子：序号 + 光标相对卡片的坐标（浮层跟随；卡片宽度用来把浮层夹在卡内）。 */
 const [hover, setHover] = useState<{ i: number; x: number; y: number; width: number } | null>(null);
 const values = useMemo(() => heatValues(cells, mode), [cells, mode]);
 const thresholds = useMemo(() => heatThresholds(values), [values]);
 const months = useMemo(() => monthTicks(cells, numLocale), [cells, numLocale]);
 const cols = Math.ceil(cells.length / 7);
 const labels: Record<HeatMode, string> = {
  day: t.usageHeatDay,
  week: t.usageHeatWeek,
  cumulative: t.usageHeatCumulative,
 };

 /** 浮层标题：这个格子代表哪段时间（三档各自的说法）。 */
 const cellLabel = (i: number): string => {
  if (mode === "week") {
   const start = Math.floor(i / 7) * 7;
   return `${cells[start].date} – ${cells[Math.min(start + 6, cells.length - 1)].date}`;
  }
  if (mode === "cumulative") return fmt(t.usageHeatThrough, cells[i].date);
  return cells[i].date;
 };

 /** 悬停的格子：0 用量的格子不出浮层（值按当前档位取，切档后自动跟着变）。 */
 const hovered = hover && values[hover.i] > 0 ? hover : null;
 /** 浮层明细：当前档位下该格的按模型拆分（每日 = 当天 / 每周 = 整周 / 累计 = 到当天）。 */
 const hoveredModels = hovered ? heatModels(cells, mode, hovered.i) : [];
 const onCellEnter = (clientX: number, clientY: number, i: number) => {
  const card = cardRef.current;
  if (!card) return;
  const rect = card.getBoundingClientRect();
  setHover({ i, x: clientX - rect.left, y: clientY - rect.top, width: rect.width });
 };

 return (
  <section
   ref={cardRef}
   aria-label={t.usageHeatTitle}
   onMouseLeave={() => setHover(null)}
   className="relative mt-6 rounded-md bg-surface p-3"
  >
   <div className="flex flex-wrap items-center gap-2">
    <h3 className="text-xs font-medium text-muted">{t.usageHeatTitle}</h3>
    <div role="radiogroup" aria-label={t.usageHeatModeAria} className="ml-auto flex gap-1 rounded-md bg-background p-1">
     {HEAT_MODES.map((m) => (
      <button
       key={m}
       role="radio"
       aria-checked={mode === m}
       onClick={() => setMode(m)}
       className={`min-h-7 cursor-pointer rounded-md px-2.5 py-1 text-[12px] transition-colors duration-100 ${mode === m ? "bg-active font-medium text-accent" : "text-muted hover:bg-hover hover:text-foreground"
        }`}
      >
       {labels[m]}
      </button>
     ))}
    </div>
   </div>
   <div
    role="img"
    aria-label={fmt(t.usageHeatAria, labels[mode])}
    className="mt-3 grid gap-1"
    style={{
     gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
     gridTemplateRows: "repeat(7, auto)",
     gridAutoFlow: "column",
     alignItems: "start",
    }}
   >
    {cells.map((c, i) => (
     <span
      key={c.date}
      onMouseEnter={(e) => onCellEnter(e.clientX, e.clientY, i)}
      className={`aspect-square rounded-xs ${HEAT_LEVEL_CLASS[heatLevel(values[i], thresholds)]} ${hover?.i === i ? "ring-1 ring-foreground/40" : ""}`}
     />
    ))}
   </div>
   <div className="relative mt-2 h-4">
    {months.map((m) => {
     const pct = ((m.col + 2.5) / cols) * 100;
     return (
      <span
       key={m.col}
       className={`absolute top-0 whitespace-nowrap text-[10px] leading-4 text-faint ${pct < 6 ? "" : pct > 94 ? "-translate-x-full" : "-translate-x-1/2"
        }`}
       style={{ left: `${pct}%` }}
      >
       {m.label}
      </span>
     );
    })}
   </div>
   {hovered && (
    <div
     className={`pointer-events-none absolute z-10 w-56 rounded-md border border-border-soft bg-elevated px-3 py-2 shadow-lg ${hovered.i % 7 >= 5 ? "-translate-y-full" : ""
      }`}
     style={{ left: Math.max(8, Math.min(hovered.x + 12, hovered.width - 232)), top: hovered.y + (hovered.i % 7 >= 5 ? -8 : 14) }}
    >
     <div className="text-[11px] text-faint">{cellLabel(hovered.i)}</div>
     <div className="mt-0.5 font-mono text-[12px]">{fmtTokens(values[hovered.i], numLocale)} tokens</div>
     {hoveredModels.length > 0 && (
      <div className="mt-1.5 flex flex-col gap-0.5 border-t border-border-soft pt-1.5">
       {hoveredModels.slice(0, 6).map((m) => (
        <div key={m.model} className="flex items-baseline justify-between gap-3">
         <span className="min-w-0 truncate text-[11px] text-muted">{m.model || t.usageHeatUnknownModel}</span>
         <span className="shrink-0 font-mono text-[11px]">{fmtTokens(m.total, numLocale)}</span>
        </div>
       ))}
       {hoveredModels.length > 6 && (
        <div className="text-[11px] text-faint">{fmt(t.usageHeatModelsRest, hoveredModels.length - 6)}</div>
       )}
      </div>
     )}
    </div>
   )}
   {/* 底部对照条：0 档空格 → 4 档 accent（与格子同一套色档，从左到右由浅到深） */}
   <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5 text-[10px] text-faint">
    <span>{t.usageHeatLess}</span>
    <span className="flex items-center gap-[3px]" aria-hidden>
     {HEAT_LEVEL_CLASS.map((cls) => (
      <span key={cls} className={`h-3 w-3 rounded-[3px] ${cls}`} />
     ))}
    </span>
    <span>{t.usageHeatMore}</span>
   </div>
  </section>
 );
}

/**
 * 设置 ›「使用统计」：把 omp 本地会话记录与壳侧账本里的用量聚合成一页统计。
 *
 * 口径（与 ZCode 的「使用统计」对齐，数据源换成 omp）：
 * - 总览三项指标：tokens 用量 / Cache 命中率 / 活跃天数（**默认看「今日」**）；
 * - 范围只作用于 tokens 用量与 Cache 命中率：**活跃天数与连续天数恒为全量历史**，不随范围缩水
 *   （「今日」档下它们与「全部」档相同）；
 * - 「Token 活动」热力图：最近 53 周的逐日日历，**不随范围切换**，右上三档换取值口径；
 * - 数据来源 = omp 会话记录（每条 assistant 消息的 `usage`，含已归档会话）**∪** 壳侧使用账本
 *   （后端按 `responseId` 去重）：**会话被删掉后那部分用量仍留在统计里**，`extras` 就是账本补上的
 *   条数（2026-10-19 用户口径：这个来源说明不再上界面，本页只留读数）；
 * - 全数字（含命中率 / 连续天数）由后端算好，前端只做格式化；
 * - 扫描有预算，超出时明说「统计可能不全」（后端 `truncated`），不假装统计完了；
 * - 本页自身**只读**（不写 omp 配置、不写覆盖层）；账本的写入在会话运行时（`runtime.rs`）。
 */
export function UsagePanel() {
 const { locale } = useApp();
 const t = useText();
 const [range, setRange] = useState<RangeKey>("today");
 const [data, setData] = useState<UsageStats | null>(null);
 const [error, setError] = useState<string | null>(null);
 /** 已拿到数据的请求键（`range#reloadKey`）：与当前请求键不一致 = 正在拉。 */
 const [loadedKey, setLoadedKey] = useState<string | null>(null);
 /** 自增即重拉（挂载 / 点刷新）；切换范围也走 effect。 */
 const [reloadKey, setReloadKey] = useState(0);

 const numLocale = locale === "zh-CN" ? "zh-CN" : "en-US";
 const reqKey = `${range}#${reloadKey}`;
 // 切范围 / 刷新时保留上一份数据显示（加个 spinner），避免整块闪空导致布局跳动
 const busy = loadedKey !== reqKey;

 useEffect(() => {
  const [key, seq] = reqKey.split("#");
  const days = RANGES.find((r) => r.key === key)?.days ?? null;
  let alive = true;
  void api
   .getUsageStats(days)
   .then((res) => {
    if (!alive) return;
    setData(res);
    setError(null);
    setLoadedKey(`${key}#${seq}`);
   })
   .catch((e: unknown) => {
    if (!alive) return;
    setData(null);
    setError(e instanceof Error ? e.message : t.usageLoadFailed);
    setLoadedKey(`${key}#${seq}`);
   });
  return () => {
   alive = false;
  };
 }, [reqKey, t]);

 const rangeLabel = (k: RangeKey): string =>
  k === "today"
   ? t.usageRangeToday
   : k === "7d"
    ? t.usageRange7d
    : k === "30d"
     ? t.usageRange30d
     : t.usageRangeAll;

 const totals = data?.totals;

 return (
  <section aria-label={t.tabUsage} className="settings-panel shrink-0">
   {/* 页头只留范围切换这一个输入控件（2026-10-19 用户口径：说明与刷新钮都不再上界面）；
       重读时机 = 切范围 / 切走页签再回来（重挂） */}
   <div className="flex flex-wrap items-center justify-end gap-2">
    <div className="flex shrink-0 flex-wrap items-center gap-0.5">
     <div role="radiogroup" aria-label={t.usageRangeAria} className="flex flex-wrap gap-1 rounded-md bg-surface p-1">
      {RANGES.map((r) => (
       <button
        key={r.key}
        role="radio"
        aria-checked={range === r.key}
        onClick={() => setRange(r.key)}
        className={`min-h-7 cursor-pointer rounded-md px-2.5 py-1 text-[12px] transition-colors duration-100 ${range === r.key
         ? "bg-active font-medium text-accent"
         : "text-muted hover:bg-hover hover:text-foreground"
         }`}
       >
        {rangeLabel(r.key)}
       </button>
      ))}
     </div>
    </div>
   </div>
   {error && (
    <div className="mt-2 flex flex-wrap items-center gap-2">
     <p role="alert" className="text-[13px] text-danger">
      {error}
     </p>
     {/* 刷新钮退场后（2026-10-19），失败就地给一次重试——不然只能切走页签再回来 */}
     <button
      onClick={() => setReloadKey((k) => k + 1)}
      disabled={busy}
      className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[13px] transition-colors duration-100 hover:bg-hover disabled:opacity-50"
     >
      {t.retry}
     </button>
    </div>
   )}
   {data?.truncated && (
    <p className="mt-2 text-[13px] text-warn">{fmt(t.usageTruncated, data.scannedFiles)}</p>
   )}

   {data === null ? (
    <p className="mt-3 text-[13px] text-muted">{busy ? t.usageLoading : ""}</p>
   ) : (
    <>
     {!totals || totals.calls === 0 ? (
      <p className="mt-3 rounded-md bg-surface px-4 py-8 text-center text-[13px] leading-relaxed text-muted">
       {t.usageEmpty}
      </p>
     ) : (
      /* 总览三张卡：tokens 用量（含未缓存输入 / 输出 / 缓存读·写）/ Cache 命中率 / 活跃天数 */
      <div className="mt-6 grid grid-cols-1 gap-3 @min-[360px]/panel:grid-cols-2 @min-[640px]/panel:grid-cols-3">
       <Tile
        label={t.usageTokens}
        value={fmtTokens(totals.total, numLocale)}
        sub={
         <span className="flex flex-wrap gap-x-2">
          <span>
           {t.usageSeriesIn} {fmtTokens(totals.input, numLocale)}
          </span>
          <span>
           {t.usageSeriesOut} {fmtTokens(totals.output, numLocale)}
          </span>
          <span>
           {t.usageSeriesCache} {fmtTokens(totals.cacheRead + totals.cacheWrite, numLocale)}
          </span>
         </span>
        }
       />
       <Tile
        label={t.usageCacheHit}
        value={totals.cacheHitRate === null ? "—" : fmtPercent(totals.cacheHitRate)}
        sub={fmt(t.usageCacheReadSub, fmtTokens(totals.cacheRead, numLocale))}
       />
       <Tile
        label={t.usageActiveDays}
        value={String(totals.activeDays)}
        sub={fmt(t.usageActiveDaysSub, totals.currentStreak, totals.longestStreak)}
       />
      </div>
     )}
     <Heatmap cells={data.heat} numLocale={numLocale} />
    </>
   )}
  </section>
 );
}
