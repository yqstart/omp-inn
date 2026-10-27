import type { ModelInfo } from "@shared/types";
import { selectorBelongsToProvider } from "./modelSelector";

/**
 * **我的模型**（本应用偏好，omp 无此概念）：localStorage 里的 selector 数组，按挑选顺序。
 * selector = `ModelInfo.selector`（`provider/id`，与 omp 角色值同格式），整串存取不拆分——
 * 模型的 id 里可能出现 `/`（如 `commandcode/meta/muse-spark-…`）。
 *
 * 作用域（「置顶」口径）：**只在壳侧**——本应用所有模型选择器（模型角色 / 失败转移目标 /
 * 聊天下拉）的候选始终是全量可用模型，星标项按挑选顺序**置顶**（见 `orderModelsByStars`）；
 * 可选范围不受影响（不挡新人、不缩小选单）。**不写 omp 的 `enabledModels`**：
 * omp 终端里 `/model` 的可选范围不受影响。
 *
 * 存储键沿用旧版「常用模型」的 `omp.favoriteModels.v1`——升级不丢已挑的模型。
 */
const KEY = "omp.favoriteModels.v1";

/** 坏数据一律丢弃：非数组 → []；非字符串 / 空白项跳过；去重保首现顺序；字符串去首尾空白。 */
export function normalizeMyModels(raw: unknown): string[] {
 if (!Array.isArray(raw)) return [];
 const out: string[] = [];
 for (const x of raw) {
  if (typeof x !== "string") continue;
  const s = x.trim();
  if (!s || out.includes(s)) continue;
  out.push(s);
 }
 return out;
}

export function loadMyModels(): string[] {
 try {
  if (typeof localStorage === "undefined") return [];
  const raw = localStorage.getItem(KEY);
  return raw ? normalizeMyModels(JSON.parse(raw)) : [];
 } catch {
  return []; // 坏 JSON / 无痕模式一律当没配过
 }
}

export function saveMyModels(list: string[]): void {
 try {
  localStorage.setItem(KEY, JSON.stringify(list));
 } catch {
  // 写失败不阻断本次操作（与 setSidebarWidth 同口径）
 }
}

/** 勾选开关：已存在则移除（其余项顺序不变），否则追加到末尾。 */
export function toggleMyModel(list: string[], selector: string): string[] {
 return list.includes(selector) ? list.filter((s) => s !== selector) : [...list, selector];
}

/**
 * 删除某供应商下的全部收藏（该供应商登出 / 被删除后同步清理）。
 * 只影响本应用的置顶清单；其它供应商的收藏与顺序不变。
 */
export function removeProviderModels(list: string[], providerId: string): string[] {
 return list.filter((selector) => !selectorBelongsToProvider(selector, providerId));
}

/** 批量加入（保序、去重；已存在的保持原位）。供应商「全选」用。 */
export function addManyMyModels(list: string[], selectors: string[]): string[] {
 const set = new Set(list);
 const out = [...list];
 for (const s of selectors) {
  if (!set.has(s)) {
   set.add(s);
   out.push(s);
  }
 }
 return out;
}

/** 批量移除。供应商「清空」用。 */
export function removeManyMyModels(list: string[], selectors: string[]): string[] {
 const drop = new Set(selectors);
 return list.filter((s) => !drop.has(s));
}

/** 按存储顺序解析成 `{selector, model}`；目录里没有的模型 `model: null`（设置页要照样列出来给人清理）。 */
export function myModelEntries(
 list: string[],
 catalog: ModelInfo[],
): { selector: string; model: ModelInfo | null }[] {
 const bySelector = new Map(catalog.map((m) => [m.selector, m]));
 return list.map((selector) => ({ selector, model: bySelector.get(selector) ?? null }));
}

/**
 * 选单分区的共用实现（**「我的模型」置顶组的唯一实现点**）：`starred` = `list` 里存在的
 * 星标模型（按 `myModels` 存储顺序），`others` = 其余模型（**星标项不重复出现**，调用方
 * 按供应商分组用）。存储里目录已不存在的 selector 直接忽略（只留在设置页的「我的模型」
 * 列表里标「已不可用」清理）；`myModels` 为空或一个都对不上时返回空组 + `list` 原数组。
 * 设置模型的弹窗（`ModelPickList`）与聊天下拉（`ModelMenu`）共用这一份口径。
 */
export function splitStarredModels(
 list: ModelInfo[],
 myModels: string[],
): { starred: ModelInfo[]; others: ModelInfo[] } {
 if (myModels.length === 0) return { starred: [], others: list };
 const bySelector = new Map(list.map((m) => [m.selector, m]));
 const starred: ModelInfo[] = [];
 const starredSet = new Set<string>();
 for (const selector of myModels) {
  const model = bySelector.get(selector);
  if (!model || starredSet.has(selector)) continue;
  starredSet.add(selector);
  starred.push(model);
 }
 if (starred.length === 0) return { starred: [], others: list };
 return { starred, others: list.filter((m) => !starredSet.has(m.selector)) };
}

/**
 * 模型选择器的候选顺序（星标置顶）：星标项按 `myModels` 存储顺序在前，其余按 `catalog`
 * 原顺序在后——只改顺序、不收窄范围（`splitStarredModels` 的拼接形态；设置页把排好序的
 * 候选交给弹窗，弹窗内再按同一口径分「我的模型」组，搜索平铺时星标同样在前）。
 * `myModels` 为空（或一个都对不上）时返回 `catalog` 原数组。
 */
export function orderModelsByStars(catalog: ModelInfo[], myModels: string[]): ModelInfo[] {
 const { starred, others } = splitStarredModels(catalog, myModels);
 return starred.length === 0 ? others : [...starred, ...others];
}
