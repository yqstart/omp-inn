/**
 * 设置面板的纯逻辑（设置 ›「常用设置」，三稿）。
 *
 * 数据来自后端 `get_omp_settings_catalog`（`omp config list` 文本 + `--json` 两路合并）：
 * 分组与 enum 取值表来自人读文本，类型化值与上游说明来自 JSON。这里只做**展示与编辑**的
 * 纯函数——分组、搜索、下拉选项、草稿解析，接口形状见 `OmpCatalogItem` / `OmpSettingsCatalog`；
 * 页面显示哪些键由 `settingsList.ts` 的展示清单过滤（本模块不关心）。
 *
 * 口径：
 * - 分组名（`appearance` / `context` / …）是上游的机器名，label 走字典（`sg_` + 分组名，
 *   与常用设置页共用同一批键）；未来上游加新分组时原样显示机器名，不吞信息；
 * - 搜索：键前缀 → 键子串 → 名称（当前语言）→ 说明 四档排序（同档保持上游顺序）；大小写不敏感；
 * - 枚举下拉的选项 label 走 `OPTION_LABELS`（展示清单里配了翻译的键；普通词翻界面
 *   语言、专有名词与档位名原样——与常用设置页同一套「选项表 + sv* 字典」做法）；
 *   没配的键 / 取值原样显示上游值；上游没有取值表（或非 enum）时 `choiceOptions` 给空
 *   数组，界面退化成文本输入框；
 * - array / record 的编辑走 JSON 文本（上游按 JSON 解析这两个类型，见 `settings.rs` 头注释）：
 *   草稿解析在 `parseJsonDraft`，类型不符 / JSON 不合法都在前端先挡下来；
 * - `value === null` + `redacted === false` = 未设置（上游没有显式值）；`redacted === true` =
 *   值被上游隐藏（令牌类键，`config list` 一律脱敏）。
 */

import type { OmpCatalogItem, OmpSettingsCatalog } from "@shared/types";
import type { Text } from "./locale";
import { OPTION_LABELS } from "./settingsList";

/**
 * 上游分组 → 字典键（`sg_` 前缀与常用设置页共用）。
 * 未知分组（上游将来加了新分组）在调用处回退成机器名，不吞信息；空分组 = 未归组。
 */
export const SECTION_LABEL_KEYS: Record<string, keyof Text> = {
 appearance: "sg_appearance",
 context: "sg_context",
 files: "sg_files",
 interaction: "sg_interaction",
 internal: "sg_internal",
 memory: "sg_memory",
 model: "sg_model",
 providers: "sg_providers",
 shell: "sg_shell",
 tasks: "sg_tasks",
 tools: "sg_tools",
};

/**
 * omp schema 类型（`kind`）→ 字典键。
 * 未知类型（上游将来加了新的 schema 类型）在调用处回退成上游原文，不吞信息。
 */
export const SETTING_KIND_KEYS: Record<string, keyof Text> = {
 boolean: "settingKindBoolean",
 number: "settingKindNumber",
 enum: "settingKindEnum",
 string: "settingKindString",
 array: "settingKindArray",
 record: "settingKindRecord",
};

/** 一个渲染分组：`section` = 上游分组名（`""` = 未分组）。 */
export type CatalogGroup = { section: string; items: OmpCatalogItem[] };

/**
 * 目录 → 分组列表：顺序照**上游清单**（`catalog.sections`），未归组的项放最后一组。
 * 组内保持上游顺序（文本清单的顺序 = omp 自己的排列）。
 */
export function groupCatalog(catalog: OmpSettingsCatalog): CatalogGroup[] {
 const groups: CatalogGroup[] = catalog.sections.map((section) => ({ section, items: [] }));
 const bySection = new Map(groups.map((g) => [g.section, g]));
 const ungrouped: CatalogGroup = { section: "", items: [] };
 for (const item of catalog.items) {
  const group = item.section ? bySection.get(item.section) : undefined;
  (group ?? ungrouped).items.push(item);
 }
 // 空分组（上游有标题但一项都没有）不渲染；未分组组只在真有项时出现
 const out = groups.filter((g) => g.items.length > 0);
 if (ungrouped.items.length > 0) out.push(ungrouped);
 return out;
}

/** 打分：0 = 键前缀、1 = 键子串、2 = 名称子串、3 = 说明子串，-1 = 不匹配（越小越靠前，同分保持原顺序）。 */
function matchScore(item: OmpCatalogItem, q: string, nameOf?: (key: string) => string | null): number {
 const key = item.key.toLowerCase();
 if (key.startsWith(q)) return 0;
 if (key.includes(q)) return 1;
 if ((nameOf?.(item.key) ?? "").toLowerCase().includes(q)) return 2;
 if (item.description.toLowerCase().includes(q)) return 3;
 return -1;
}

/**
 * 搜索过滤：键 / 名称（当前语言）/ 上游说明的大小写不敏感子串匹配，按 `matchScore` 稳定排序。
 * 空查询原样返回（调用方省掉一次拷贝的语义，不必再排序）。
 * `nameOf` = 键 → 当前语言的短名（`OMP_SETTING_NAMES` 的取用方）——中文界面下搜「压缩」要能命中。
 */
export function filterCatalog(
 items: readonly OmpCatalogItem[],
 query: string,
 nameOf?: (key: string) => string | null,
): OmpCatalogItem[] {
 const q = query.trim().toLowerCase();
 if (!q) return [...items];
 const scored: { item: OmpCatalogItem; score: number; index: number }[] = [];
 items.forEach((item, index) => {
  const score = matchScore(item, q, nameOf);
  if (score >= 0) scored.push({ item, score, index });
 });
 scored.sort((a, b) => a.score - b.score || a.index - b.index);
 return scored.map((s) => s.item);
}

/**
 * 一个键的下拉可选项。
 *
 * 取值来源：**enum 键**取上游取值表（文本清单解析来的 `item.options`）；其余键（普通
 * string / 路径 / URL，以及 enum 却没有取值表的降级态）给空数组——调用方据此用文本
 * 输入框，不摆「只有当前值这一项」的残废下拉。
 * （历史：`theme.dark` / `composer.shape` 这类「string 但取值有限」的运行时表随四稿
 * 筛掉 TUI 键一并退场，见 `settingsList.ts` 头部沿革。）
 *
 * 当前值不在表里时**原样补一条**，不吞信息；label 走 `OPTION_LABELS`
 * （普通词翻界面语言、专有名词与档位名原样）。
 */
export function choiceOptions(item: OmpCatalogItem, t: Text): { value: string; label: string }[] {
 const base = item.kind === "enum" ? [...item.options] : [];
 if (base.length === 0) return [];
 const current = typeof item.value === "string" ? item.value : null;
 if (current !== null && current !== "" && !base.includes(current)) base.push(current);
 const labels = OPTION_LABELS[item.key];
 return base.map((value) => {
  const labelKey = labels?.[value];
  return { value, label: labelKey ? t[labelKey] : value };
 });
}

/** 数字草稿解析：空串 / 非有限数一律 null（调用方丢弃草稿，不写 omp）。 */
export function parseNumberDraft(raw: string): number | null {
 const trimmed = raw.trim();
 if (trimmed === "") return null;
 const n = Number(trimmed);
 return Number.isFinite(n) ? n : null;
}

/** 行内值的紧凑预览（array / record 的折叠态与只读类型用）；`null` → 空串。 */
export function jsonPreview(value: unknown): string {
 if (value === null || value === undefined) return "";
 try {
  return JSON.stringify(value);
 } catch {
  return String(value);
 }
}

/** JSON 编辑器的初始文本：未设置时按类型给空容器，否则是缩进好的 JSON。 */
export function jsonDraftFrom(item: OmpCatalogItem): string {
 if (item.value === null || item.value === undefined) {
  return item.kind === "array" ? "[]" : "{}";
 }
 try {
  return JSON.stringify(item.value, null, 2) ?? "";
 } catch {
  return "";
 }
}

/** `parseJsonDraft` 的失败原因：不合法 JSON / 不是数组 / 不是对象。
 *  `message` = 上游解析器的原文（拼接在「JSON 不合法：」后面）。 */
export type JsonDraftError = { reason: "invalid" | "array" | "record"; message?: string };
export type JsonDraftResult = { ok: true; value: unknown } | { ok: false; error: JsonDraftError };

/** 解析 JSON 草稿并按 schema 类型校验形状（array 要数组、record 要对象）。 */
export function parseJsonDraft(raw: string, kind: string): JsonDraftResult {
 let value: unknown;
 try {
  value = JSON.parse(raw);
 } catch (e) {
  return { ok: false, error: { reason: "invalid", message: e instanceof Error ? e.message : undefined } };
 }
 if (kind === "array" && !Array.isArray(value)) return { ok: false, error: { reason: "array" } };
 if (kind === "record" && (value === null || typeof value !== "object" || Array.isArray(value))) {
  return { ok: false, error: { reason: "record" } };
 }
 return { ok: true, value };
}
