/**
 * 「使用统计」Token 活动热力图的纯计算：三档取值、分档阈值、色档、月份刻度。
 *
 * 数据形状由后端给（`usage.rs`：最近 53 周、周日对齐、逐日补零、到今天为止）——
 * 这里只做可视化归一，不改数字本身；「每日 / 每周 / 累计」三档只是对同一份逐日数据换取值，
 * 格子与布局完全不变（所以切换不发请求、不重扫）。
 */
import type { UsageHeatModel, UsageHeatRow } from "@shared/types";

/** 热力图三档口径：当天 / 该格所在整周 / 窗口起点到当天。 */
export type HeatMode = "day" | "week" | "cumulative";

/** 三档顺序即界面顺序。 */
export const HEAT_MODES: readonly HeatMode[] = ["day", "week", "cumulative"];

/** 色档阈值：非零值的 p25 / p50 / p75（GitHub 口径的四分位分档）。 */
export function heatThresholds(totals: readonly number[]): [number, number, number] {
 const nonzero = totals.filter((v) => v > 0).sort((a, b) => a - b);
 if (nonzero.length === 0) {
  // 没有参照（一整年都没有用量）：任何正数都落最浅一档
  return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
 }
 const last = nonzero.length - 1;
 return [nonzero[Math.floor(0.25 * last)], nonzero[Math.floor(0.5 * last)], nonzero[Math.floor(0.75 * last)]];
}

/** 0 = 没用量（空格），1–4 由浅到深（阈值边界归入较浅一档）。 */
export function heatLevel(total: number, [p25, p50, p75]: [number, number, number]): 0 | 1 | 2 | 3 | 4 {
 if (total <= 0) return 0;
 if (total <= p25) return 1;
 if (total <= p50) return 2;
 if (total <= p75) return 3;
 return 4;
}

/**
 * 三档取值（长度与 `cells` 一致，逐格对齐）：
 * - `day` = 当天 token；
 * - `week` = 该格所在周的合计（同一列 7 格同值，竖着看就是一周一根「柱」）；
 * - `cumulative` = 窗口起点到当天的累计（越靠右越深，最后一格 = 窗口总量）。
 *
 * 列按 7 天切：后端从周日对齐补零，最后一列可能不满 7 格（今天在周中）。
 */
export function heatValues(cells: readonly UsageHeatRow[], mode: HeatMode): number[] {
 const daily = cells.map((c) => c.total);
 if (mode === "day") return daily;
 if (mode === "week") {
  const out = new Array<number>(daily.length).fill(0);
  for (let i = 0; i < daily.length; i += 7) {
   const end = Math.min(i + 7, daily.length);
   let sum = 0;
   for (let j = i; j < end; j++) sum += daily[j];
   for (let j = i; j < end; j++) out[j] = sum;
  }
  return out;
 }
 let acc = 0;
 return daily.map((v) => (acc += v));
}

/**
 * 某一格在指定档位下的按模型拆分（悬停读数的明细行）：每日 = 当天；每周 = 该格所在整周；
 * 累计 = 窗口起点到当天（含当天）。结果按 token 降序（同值按模型名），与后端同一形状。
 */
export function heatModels(
 cells: readonly UsageHeatRow[],
 mode: HeatMode,
 index: number,
): UsageHeatModel[] {
 const start = Math.floor(index / 7) * 7;
 const rows =
  mode === "day"
   ? [cells[index]]
   : mode === "week"
    ? cells.slice(start, start + 7)
    : cells.slice(0, index + 1);
 const merged: UsageHeatModel[] = [];
 for (const row of rows) {
  for (const m of row.models) {
   const hit = merged.find((x) => x.model === m.model);
   if (hit) hit.total += m.total;
   else merged.push({ ...m });
  }
 }
 return merged.sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));
}

/**
 * 月份刻度：某月从哪一列开始（该列包含 1 号、或跨月）就在哪一列下方标注（标签是月份短名，
 * 跟随界面语言）。窗口起点落在月中时，起点那一列不标——那个月的第一周不在日历里。
 */
export function monthTicks(
 cells: readonly UsageHeatRow[],
 locale: string,
): { col: number; label: string }[] {
 const fmtMonth = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });
 const out: { col: number; label: string }[] = [];
 let marked = "";
 for (let i = 0; i < cells.length; i += 7) {
  const head = cells[i].date.split("-").map(Number);
  // 每列最后一天：不满 7 格的尾列取实际最后一行
  const tail = cells[Math.min(i + 6, cells.length - 1)].date.split("-").map(Number);
  const crosses = tail[0] !== head[0] || tail[1] !== head[1];
  if (head[2] !== 1 && !crosses) continue;
  const month = `${tail[0]}-${tail[1]}`;
  if (month === marked) continue;
  marked = month;
  out.push({ col: i / 7, label: fmtMonth.format(Date.UTC(tail[0], tail[1] - 1, 1)) });
 }
 return out;
}
