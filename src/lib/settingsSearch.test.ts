import { describe, expect, it } from "vitest";
import type {
 ConstraintsView,
 MemoryProjectView,
 ModelCatalog,
 OmpSettingsCatalog,
 PluginsView,
 SessionView,
 SkillsView,
} from "@shared/types";
import { searchSettings, type SettingsSearchSources } from "./settingsSearch";
import { TEXT } from "./locale";

const t = TEXT["zh-CN"];

const EMPTY: SettingsSearchSources = {
 catalog: null,
 models: null,
 plugins: null,
 skills: null,
 memories: null,
 archived: null,
 constraints: null,
};

/** 常用设置目录：只放展示清单里的真实键（`todo.enabled` / `defaultThinkingLevel`）。 */
const catalog: OmpSettingsCatalog = {
 sections: ["tasks", "model"],
 items: [
  { key: "todo.enabled", value: true, kind: "boolean", description: "Enable the todo tool", section: "tasks", options: [], redacted: false },
  { key: "defaultThinkingLevel", value: "medium", kind: "enum", description: "Default thinking level", section: "model", options: [], redacted: false },
 ],
};

const models: ModelCatalog = {
 fetchedAt: 0,
 models: [
  { provider: "opencode-go", id: "deepseek-v4.1-flash", selector: "opencode-go/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextWindow: null, maxTokens: null, reasoning: null, thinking: null, input: null },
 ],
};

const plugins: PluginsView = {
 cwd: "",
 npm: [{ name: "voice-kit", version: "1.2.0", path: "/x/voice-kit", description: "文本转语音工具", features: [], featuresCustomized: false, enabled: true }],
 marketplace: [{ id: "market-timer@hub", version: "0.3.0", scope: "user", shadowedBy: null, enabled: false }],
};

const skills: SkillsView = {
 cwd: "",
 skills: [{ name: "commit-helper", description: "生成提交信息", filePath: "/x/SKILL.md", baseDir: "/x", source: "native:user", hide: false }],
 disabled: ["legacy-writer"],
 staleDisabled: [],
 warnings: [],
};

const memories: MemoryProjectView[] = [
 { dir: "a1b2", path: "/m/a1b2", name: "omp-inn", projectId: null, files: [{ path: "notes.md", size: 12, modified: 0, kind: "memory" }], totalBytes: 12, updatedAt: 0 },
];

const archived: SessionView[] = [
 { id: "0198aaaa-bbbb-7ccc-8ddd-eeeeffff0000", projectId: null, title: "重构设置页导航", cwd: "/x", timestamp: 0, archived: true, corrupt: false, note: null, running: false },
];

const SOURCES: SettingsSearchSources = { catalog, models, plugins, skills, memories, archived, constraints: null };

describe("设置搜索（跨条目）", () => {
 it("空查询 / 全空格返回空", () => {
  expect(searchSettings(SOURCES, "", t, "zh-CN")).toEqual([]);
  expect(searchSettings(SOURCES, "   ", t, "zh-CN")).toEqual([]);
 });

 it("常用设置：名称或键命中，命中行带 focusKey（跳转定位用）", () => {
  const groups = searchSettings(SOURCES, "todo", t, "zh-CN");
  const general = groups.find((g) => g.tab === "general");
  expect(general?.hits[0]?.focusKey).toBe("todo.enabled");
  expect(general?.hits[0]?.sub).toContain("todo.enabled");
  // 中文名称也能命中（OMP_SETTING_NAMES 的当前语言列）
  const zh = searchSettings(SOURCES, "思考", t, "zh-CN").find((g) => g.tab === "general");
  expect(zh?.hits.some((h) => h.focusKey === "defaultThinkingLevel")).toBe(true);
 });

 it("模型 / 插件 / 技能 / 记忆 / 归档：各自命中，非通用组不带 focusKey", () => {
  expect(searchSettings(SOURCES, "deepseek", t, "zh-CN").find((g) => g.tab === "models")?.hits[0]?.title).toContain("DeepSeek");
  expect(searchSettings(SOURCES, "voice", t, "zh-CN").find((g) => g.tab === "plugins")?.hits[0]?.title).toBe("voice-kit");
  expect(searchSettings(SOURCES, "commit", t, "zh-CN").find((g) => g.tab === "skills")?.hits[0]?.title).toBe("commit-helper");
  // 已停用的技能也在命中范围（sub 为空，仅名字）
  expect(searchSettings(SOURCES, "legacy", t, "zh-CN").find((g) => g.tab === "skills")?.hits[0]?.title).toBe("legacy-writer");
  expect(searchSettings(SOURCES, "notes", t, "zh-CN").find((g) => g.tab === "memories")?.hits[0]?.title).toBe("notes.md");
  expect(searchSettings(SOURCES, "导航", t, "zh-CN").find((g) => g.tab === "archived")?.hits[0]?.title).toContain("导航");
  for (const group of searchSettings(SOURCES, "deepseek", t, "zh-CN")) {
   if (group.tab !== "general") expect(group.hits.every((h) => h.focusKey === null)).toBe(true);
  }
 });

 it("悬空停用记录（技能已不存在）不进搜索结果", () => {
  const staleSources: SettingsSearchSources = {
   ...SOURCES,
   skills: { ...skills, staleDisabled: ["legacy-writer"] },
  };
  // 指向已删除技能的旧记录没有对应页面对象，搜出来只会跳到一个不存在的行
  expect(searchSettings(staleSources, "legacy", t, "zh-CN").some((g) => g.tab === "skills")).toBe(false);
 });

 it("大小写不敏感；无命中返回空数组；缺源不产组", () => {
  expect(searchSettings(SOURCES, "DEEPSEEK", t, "zh-CN").some((g) => g.tab === "models")).toBe(true);
  expect(searchSettings(SOURCES, "no-such-thing", t, "zh-CN")).toEqual([]);
  expect(searchSettings(EMPTY, "todo", t, "zh-CN")).toEqual([]);
 });

 it("常用设置只搜展示清单内的键（清单外的键不参与）", () => {
  const withInternal: SettingsSearchSources = {
   ...EMPTY,
   catalog: {
    sections: ["internal"],
    items: [{ key: "internal.secretKey", value: 1, kind: "number", description: "", section: "internal", options: [], redacted: false }],
   },
  };
  expect(searchSettings(withInternal, "secretKey", t, "zh-CN")).toEqual([]);
 });

 it("omp 约束：条目名 / 文件名 / 规则描述命中，跳转带 kind:name", () => {
  const constraints: ConstraintsView = {
   agentDir: "/a",
   rulesDir: "/a/rules",
   files: [
    { kind: "agents", name: "AGENTS.md", path: "/a/AGENTS.md", exists: true, content: "# 约束", hash: "x", modifiedMs: null, size: 1, error: null },
    { kind: "rules", name: "RULES.md", path: "/a/RULES.md", exists: true, content: "", hash: "x", modifiedMs: null, size: 0, error: null },
    { kind: "rule", name: "no-any.md", path: "/a/rules/no-any.md", exists: true, content: "---\ndescription: 禁止 any\ncondition:\n  - ': any'\n---\n正文", hash: "x", modifiedMs: null, size: 1, error: null },
   ],
   rulesError: null,
  };
  const sources: SettingsSearchSources = { ...EMPTY, constraints };

  const entry = searchSettings(sources, "omp 约束", t, "zh-CN").find((g) => g.tab === "constraints");
  expect(entry?.hits[0]).toMatchObject({ title: t.tabConstraints, focusKey: "agents:AGENTS.md" });

  const byRule = searchSettings(sources, "禁止", t, "zh-CN").find((g) => g.tab === "constraints");
  expect(byRule?.hits[0]).toMatchObject({ title: "no-any", focusKey: "rule:no-any.md" });

  const byFile = searchSettings(sources, "AGENTS.md", t, "zh-CN").find((g) => g.tab === "constraints");
  expect(byFile?.hits.some((h) => h.focusKey === "agents:AGENTS.md")).toBe(true);
 });
});
