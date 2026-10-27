import type { PluginDoctorFinding, PluginItem } from "@shared/types";

/**
 * 插件页的纯逻辑（设置 ›「插件」）：体检结论汇总与特性集合的两道换算。
 * 读 / 写都经 `omp plugin`（见 `src-tauri/src/plugins.rs`），这里只做界面侧的格式化，
 * 不重新解释上游数据。
 */

/** 体检结论汇总（`--fix` 已修复的项单独数，界面要能把它们和「仍然有问题」区分开）。 */
export function doctorSummary(findings: PluginDoctorFinding[]): {
 ok: number;
 warning: number;
 error: number;
 fixed: number;
} {
 let ok = 0;
 let warning = 0;
 let error = 0;
 let fixed = 0;
 for (const f of findings) {
  if (f.fixed) fixed += 1;
  if (f.status === "ok") ok += 1;
  else if (f.status === "error") error += 1;
  else if (f.status === "warning") warning += 1;
 }
 return { ok, warning, error, fixed };
}

/** 当前**生效**的特性名（后端已按「显式列表 ? 列表 : default」算好 `enabled`）。 */
export function enabledFeatureNames(item: PluginItem): string[] {
 return item.features.filter((f) => f.enabled).map((f) => f.name);
}

/**
 * 开关一个特性后的**完整集合**（`--set` 是整组覆盖，必须把其余特性的现状一起带上）。
 *
 * 为什么不让用户逐项 `--enable` / `--disable`：上游 `enabledFeatures: null` 表示「按每个特性
 * 自己的 `default`」——从 null 出发逐项 enable 会把默认开启的特性一起丢掉（实测）。界面按
 * 「当前生效集合」整组写，语义才一致（代价：写过之后就是显式列表，不再回落默认）。
 * 顺序按 manifest 的键序，保证同一状态写出的 JSON 稳定。
 */
export function toggleFeature(item: PluginItem, name: string, on: boolean): string[] {
 const set = new Set(enabledFeatureNames(item));
 if (on) set.add(name);
 else set.delete(name);
 return item.features.map((f) => f.name).filter((n) => set.has(n));
}
