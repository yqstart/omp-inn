import type { ContextUsage } from "@shared/types";

/**
 * 上下文**用量**的格式化口径（输入框工具行的容量环 / 面板与状态条共用）。
 *
 * 注意与 `src/lib/context.ts` 的分工：那个是输入框上方「上下文条」的项目 + 目录取值，
 * 与用量无关。这里是 token 数字与百分比的口径。
 */

/**
 * 上下文占用百分比（0–100），全应用唯一入口。
 *
 * omp `get_state.contextUsage.percent` 实测**就是 0–100 的百分比**（18.2.1 真机：
 * `tokens: 28529, contextWindow: 1000000, percent: 2.8529`），不是 0–1 比例。
 * 历史上这里写过「≤1 就乘 100」的区间猜测，会把真正占 0.9% 的会话显示成 90%
 * （连带误触发「上下文 ≥80%」的压缩入口）——所以不再做任何猜测：
 * `percent` 缺失时按 omp 同式（tokens / window × 100）补算。
 */
export function contextPercent(
 cu: Pick<ContextUsage, "tokens" | "contextWindow" | "percent"> | null | undefined,
): number | null {
 if (!cu) return null;
 if (cu.percent != null) return cu.percent;
 if (cu.tokens != null && cu.contextWindow) return (cu.tokens / cu.contextWindow) * 100;
 return null;
}

/** 百分比文案：≥10% 取整，小比例留一位小数（与状态条同口径）。 */
export function fmtPercent(pct: number): string {
 return pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
}

/** token 用量：B / M / K，再小走本地化千分位（与设置 ›「使用统计」同量纲）。 */
export function fmtTokens(n: number, locale = "en-US"): string {
 if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
 if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
 if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`;
 return n.toLocaleString(locale);
}

/** 上下文窗口的整档写法（与模型目录里的 `1M` / `200K` 角标同规矩）。 */
export function fmtWindow(n: number): string {
 if (!n) return "";
 if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
 return `${Math.round(n / 1000)}K`;
}
