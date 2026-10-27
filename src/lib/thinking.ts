/**
 * 思考档工具：可用档推导 + 默认档夹取 + 真值归一。
 *
 * 硬约束（omp 18.10.3 rpc-ui 实测）：
 * - 合法档 = 当前模型 `thinking.efforts`，但 `off` 恒定合法（不在 efforts 内亦生效）；
 * - 非法档 `set_thinking_level` 同样回 `success:true`（静默忽略）→ 只能前端先过滤，禁止先发再报错；
 * - 切模型时 omp **保留仍然合法的档位**，切到无思考模型直接丢档、之后切回也不会自动恢复 →
 *   壳侧只在「档位缺失 / 对新模型非法」时落 **omp 配置的默认档**（`defaultThinkingLevel`，
 *   见 `lib/thinkingDefault.ts`；后端同口径在 `runtime.rs` 的 `auto_think_level`），有效档不覆盖。
 */

/** 档位强度序（与 omp CLI `--thinking` 全集一致，off 最弱）。 */
export const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 该模型可选档：off 恒在首位，其余按强度序取 efforts 交集（未知档忽略）。 */
export function thinkingLevelsOf(efforts: readonly string[] | null | undefined): string[] {
  const set = new Set(efforts ?? []);
  return THINKING_ORDER.filter((lv) => lv === "off" || set.has(lv));
}

/**
 * 把期望的档位夹到该模型的支持集：支持则原样，否则退回该模型最高档。
 * `want` 传 omp 配置的默认档（`defaultThinkingLevel`）——没读到（null）/ `auto` /
 * 该模型不支持，一律走最高档兜底，不编造档位。
 */
export function clampThinking(
  want: string | null | undefined,
  efforts: readonly string[] | null | undefined,
): string {
  const levels = thinkingLevelsOf(efforts);
  return want && levels.includes(want) ? want : (levels[levels.length - 1] ?? "off");
}

/**
 * 依据 omp 真值算 UI 应显示的档位。
 * `fallback` = omp 配置的默认档（真值缺失 / 非法时显示它，夹到支持集；不传 = 最高档）。
 * `shouldSync` = 真值缺失或非法（切模型后会丢档），需下发纠正为同一档。
 */
export function resolveThinking(
  efforts: readonly string[] | null | undefined,
  actual: string | null | undefined,
  fallback?: string | null,
): { level: string; shouldSync: boolean } {
  const levels = thinkingLevelsOf(efforts);
  if (actual && levels.includes(actual)) return { level: actual, shouldSync: false };
  return { level: clampThinking(fallback, efforts), shouldSync: levels.length > 1 };
}
