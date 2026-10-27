import { describe, expect, it } from "vitest";
import { TEXT } from "./locale";
import {
 SECTION_LABEL_KEYS,
 SETTING_KIND_KEYS,
 choiceOptions,
 filterCatalog,
 groupCatalog,
 jsonDraftFrom,
 jsonPreview,
 parseJsonDraft,
 parseNumberDraft,
} from "./allSettings";
import type { OmpCatalogItem, OmpSettingsCatalog } from "@shared/types";

const zh = TEXT["zh-CN"];
const en = TEXT.en;

/** 造一项（默认值为 boolean true；测试只覆盖关心的字段）。 */
const item = (over: Partial<OmpCatalogItem>): OmpCatalogItem => ({
 key: "k",
 value: true,
 kind: "boolean",
 description: "",
 section: "",
 options: [],
 redacted: false,
 ...over,
});

const catalog = (sections: string[], items: OmpCatalogItem[]): OmpSettingsCatalog => ({ sections, items });

describe("设置页的分组与搜索", () => {
 it("每个已知分组的 label 都在中英字典里（拼错就是界面上的 undefined）", () => {
  for (const k of Object.values(SECTION_LABEL_KEYS)) {
   expect(zh[k], `zh 缺 ${k}`).toBeTruthy();
   expect(en[k], `en 缺 ${k}`).toBeTruthy();
  }
 });

 it("schema 类型名都在中英字典里（未知类型由调用处回退上游原文）", () => {
  for (const k of Object.values(SETTING_KIND_KEYS)) {
   expect(zh[k], `zh 缺 ${k}`).toBeTruthy();
   expect(en[k], `en 缺 ${k}`).toBeTruthy();
  }
 });

 it("groupCatalog：顺序照上游分组、未归组的放最后、空分组不渲染", () => {
  const c = catalog(
   ["appearance", "context", "empty", "tools"],
   [
    item({ key: "theme.dark", section: "tools" }), // 分组顺序说了算，不是出现顺序
    item({ key: "a.b", section: "appearance" }),
    item({ key: "c.d", section: "appearance" }),
    item({ key: "loose.key", section: "" }),
   ],
  );
  const groups = groupCatalog(c);
  expect(groups.map((g) => g.section)).toEqual(["appearance", "tools", ""]);
  expect(groups[0].items.map((i) => i.key)).toEqual(["a.b", "c.d"]);
  expect(groups[2].items.map((i) => i.key)).toEqual(["loose.key"]);
 });

 it("filterCatalog：空查询原样返回；键前缀 < 键子串 < 说明，同档保持原顺序", () => {
  const items = [
   item({ key: "statusLine.preset", description: "compaction related" }),
   item({ key: "compaction.enabled", description: "About compaction" }),
   item({ key: "theme.compactionTint" }),
   item({ key: "unrelated.key" }),
  ];
  expect(filterCatalog(items, "  ").map((i) => i.key)).toEqual(items.map((i) => i.key));

  // `compaction.enabled` 键前缀命中；`theme.compactionTint` 键子串命中；`statusLine.preset` 只在说明里命中
  expect(filterCatalog(items, "compaction").map((i) => i.key)).toEqual([
   "compaction.enabled",
   "theme.compactionTint",
   "statusLine.preset",
  ]);
 });

 it("filterCatalog：名称（当前语言）也参与匹配，档位排在说明之前", () => {
  const items = [
   item({ key: "zzz.plain", description: "自动压缩上下文说明" }),
   item({ key: "aaa.compactThing" }),
   item({ key: "mmm.key", description: "无关" }),
  ];
  const nameOf = (key: string) => (key === "mmm.key" ? "自动压缩上下文" : null);
  // 键前缀（aaa）→ 名称（mmm）→ 说明（zzz）；中文界面下搜「压缩」能命中名称
  expect(filterCatalog(items, "compact", nameOf).map((i) => i.key)).toEqual(["aaa.compactThing"]);
  expect(filterCatalog(items, "压缩", nameOf).map((i) => i.key)).toEqual(["mmm.key", "zzz.plain"]);
  expect(filterCatalog(items, "压缩", (key) => (key === "mmm.key" ? "自动压缩上下文" : null)).map((i) => i.key)).toEqual([
   "mmm.key",
   "zzz.plain",
  ]);
 });

 it("filterCatalog：大小写不敏感、没命中给空数组", () => {
  const items = [item({ key: "Tui.Mouse" })];
  expect(filterCatalog(items, "tui.mouse")).toHaveLength(1);
  expect(filterCatalog(items, "tui.MOUSE")).toHaveLength(1);
  expect(filterCatalog(items, "nope")).toEqual([]);
 });

 it("filterCatalog：同档内保持上游顺序（稳定排序）", () => {
  const items = [item({ key: "aa.edit" }), item({ key: "bb.edit" }), item({ key: "cc.edit" })];
  expect(filterCatalog(items, "edit").map((i) => i.key)).toEqual(["aa.edit", "bb.edit", "cc.edit"]);
 });
});

describe("设置页的编辑器辅助", () => {
 it("choiceOptions：enum 键当前值在表里按表顺序；不在表里补一条；非字符串不补", () => {
  const base = item({ kind: "enum", options: ["a", "b"], value: "b" });
  expect(choiceOptions(base, zh).map((o) => o.value)).toEqual(["a", "b"]);

  expect(choiceOptions({ ...base, value: "brand-new" }, zh).map((o) => o.value)).toEqual([
   "a",
   "b",
   "brand-new",
  ]);
  expect(choiceOptions({ ...base, value: null }, zh).map((o) => o.value)).toEqual(["a", "b"]);
  expect(choiceOptions({ ...base, value: 42 }, zh).map((o) => o.value)).toEqual(["a", "b"]);
  // 空串是「显式空值」，不是表里的一项，也不补
  expect(choiceOptions({ ...base, value: "" }, zh).map((o) => o.value)).toEqual(["a", "b"]);
  // enum 却没有取值表（文本清单那一路失败的降级态）：空数组，界面据此退化成文本输入框
  expect(choiceOptions(item({ kind: "enum", options: [], value: "x" }), zh)).toEqual([]);
 });

 it("choiceOptions：配了翻译的键走 OPTION_LABELS，未配的键 / 取值原样显示上游值", () => {
  // update.channel 的 stable / canary 在字典里有 sv* label
  const channel = item({
   key: "update.channel",
   kind: "enum",
   options: ["stable", "canary"],
   value: "stable",
  });
  expect(choiceOptions(channel, zh).map((o) => o.label)).toEqual(["稳定版", "尝鲜版"]);
  expect(choiceOptions(channel, en).map((o) => o.label)).toEqual(["Stable", "Canary"]);

  // 同一取值跨键共享（off / auto 这类公共词）
  const market = item({
   key: "marketplace.autoUpdate",
   kind: "enum",
   options: ["off", "notify", "auto"],
   value: "auto",
  });
  expect(choiceOptions(market, zh).map((o) => o.label)).toEqual(["关闭", "仅提醒", "自动"]);

  // 没配 label 的键（思考档——档位名原样，与常用设置页同一口径）原样显示上游取值
  const thinking = item({
   key: "defaultThinkingLevel",
   kind: "enum",
   options: ["minimal", "medium", "high"],
   value: "medium",
  });
  expect(choiceOptions(thinking, zh).map((o) => o.label)).toEqual(["minimal", "medium", "high"]);

  // 配了翻译的键里，没配的取值（含补进来的当前值）原样显示上游值
  const mixed = item({
   key: "update.channel",
   kind: "enum",
   options: ["stable", "canary", "weird-new"],
   value: "weird-new",
  });
  expect(choiceOptions(mixed, zh).map((o) => o.label)).toEqual(["稳定版", "尝鲜版", "weird-new"]);
 });

 it("choiceOptions：string 键一律给空数组（调用方退化成文本输入框）", () => {
  // 四稿筛掉 TUI 键后，清单里不再有「string 但取值有限」的运行时表（主题 / 输入框形态那类）：
  // 普通 string 键（路径 / URL / 主题…）没有表 → 空数组，界面用文本输入框而不是残废下拉
  expect(choiceOptions(item({ key: "theme.dark", kind: "string", value: "dark" }), zh)).toEqual([]);
  expect(choiceOptions(item({ key: "searxng.endpoint", kind: "string", value: "" }), zh)).toEqual([]);
  expect(choiceOptions(item({ key: "python.interpreter", kind: "string", value: "" }), zh)).toEqual([]);
 });

 it("parseNumberDraft：空 / 非有限数 → null，其余按十进制解析", () => {
  for (const bad of ["", "   ", "abc", "NaN", "Infinity", "--1"]) {
   expect(parseNumberDraft(bad), bad).toBeNull();
  }
  expect(parseNumberDraft("42")).toBe(42);
  expect(parseNumberDraft(" -1 ")).toBe(-1);
  expect(parseNumberDraft("0.95")).toBe(0.95);
 });

 it("jsonDraftFrom：未设置按类型给空容器，否则缩进 JSON", () => {
  expect(jsonDraftFrom(item({ kind: "array", value: null }))).toBe("[]");
  expect(jsonDraftFrom(item({ kind: "record", value: null }))).toBe("{}");
  expect(jsonDraftFrom(item({ kind: "array", value: ["a"] }))).toBe('[\n  "a"\n]');
  expect(jsonDraftFrom(item({ kind: "record", value: { a: 1 } }))).toBe('{\n  "a": 1\n}');
 });

 it("parseJsonDraft：合法 JSON 且形状对 → ok；形状不符 / 不合法 → 对应原因", () => {
  expect(parseJsonDraft('["a","b"]', "array")).toEqual({ ok: true, value: ["a", "b"] });
  expect(parseJsonDraft('{"a":1}', "record")).toEqual({ ok: true, value: { a: 1 } });

  const badJson = parseJsonDraft("{oops", "record");
  expect(badJson.ok).toBe(false);
  if (!badJson.ok) {
   expect(badJson.error.reason).toBe("invalid");
   expect(badJson.error.message).toBeTruthy();
  }

  const notArray = parseJsonDraft('{"a":1}', "array");
  expect(notArray.ok).toBe(false);
  if (!notArray.ok) expect(notArray.error.reason).toBe("array");

  const notRecord = parseJsonDraft("[1]", "record");
  expect(notRecord.ok).toBe(false);
  if (!notRecord.ok) expect(notRecord.error.reason).toBe("record");
  expect(parseJsonDraft("null", "record").ok).toBe(false);
 });

 it("jsonPreview：未设置给空串，其余给紧凑 JSON", () => {
  expect(jsonPreview(null)).toBe("");
  expect(jsonPreview(undefined)).toBe("");
  expect(jsonPreview(["a", "b"])).toBe('["a","b"]');
  expect(jsonPreview({ a: 1 })).toBe('{"a":1}');
 });

 it("面板用到的界面文案都在字典里", () => {
  const keys = [
   "allSettingsNotSet",
   "allSettingsRedacted",
   "allSettingsRedactedHint",
   "allSettingsEditJson",
   "allSettingsJsonInvalid",
   "allSettingsJsonNeedArray",
   "allSettingsJsonNeedRecord",
   "allSettingsEmpty",
   "allSettingsUngrouped",
   "allSettingsSave",
   "allSettingsJsonAria",
  ] as const;
  for (const k of keys) {
   expect(zh[k], `zh 缺 ${k}`).toBeTruthy();
   expect(en[k], `en 缺 ${k}`).toBeTruthy();
  }
 });
});
