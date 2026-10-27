import { describe, expect, it } from "vitest";
import type { SkillItem } from "@shared/types";
import { TEXT } from "./locale";
import { groupSkills, parseSkillSource, skillProviderLabelKey, skillSourceLabel, sortDisabled } from "./skills";

const skill = (name: string, source: string, over: Partial<SkillItem> = {}): SkillItem => ({
 name,
 description: "",
 filePath: `/x/${name}/SKILL.md`,
 baseDir: `/x/${name}`,
 source,
 hide: false,
 ...over,
});

describe("技能来源解析", () => {
 it("拆 provider:level", () => {
  expect(parseSkillSource("agents:user")).toEqual({ provider: "agents", level: "user" });
  expect(parseSkillSource("omp-plugins:user")).toEqual({ provider: "omp-plugins", level: "user" });
  expect(parseSkillSource("native")).toEqual({ provider: "native", level: "" });
 });

 it("已知 provider 给字典键，未知值退回原样", () => {
  expect(skillProviderLabelKey("native")).toBe("skillProvNative");
  expect(skillProviderLabelKey("omp-managed")).toBe("skillProvOmpManaged");
  expect(skillProviderLabelKey("omp-plugins")).toBe("skillProvOmpPlugins");
  expect(skillProviderLabelKey("something-new")).toBe(null);
 });

 it("来源说明：已知 provider 走字典，未知原样拼接；没有 level 时只显示 provider", () => {
  expect(skillSourceLabel("native:project", TEXT["zh-CN"])).toBe("项目级 · omp 原生目录");
  expect(skillSourceLabel("weird:user", TEXT["zh-CN"])).toBe("用户级 · weird");
  expect(skillSourceLabel("weird", TEXT["zh-CN"])).toBe("weird");
 });
});

describe("技能分组", () => {
 it("项目级 → 用户级 → 其它，组内按名字序，空组不出现", () => {
  const groups = groupSkills([
   skill("b", "agents:user"),
   skill("a", "native:project"),
   skill("c", "agents:user"),
   skill("z", "weird"),
  ]);
  expect(groups.map((g) => g.id)).toEqual(["project", "user", "other"]);
  expect(groups[0].items.map((s) => s.name)).toEqual(["a"]);
  expect(groups[1].items.map((s) => s.name)).toEqual(["b", "c"]);
  expect(groups[2].items.map((s) => s.name)).toEqual(["z"]);
  expect(groupSkills([])).toEqual([]);
  expect(groupSkills([skill("only", "agents:user")]).map((g) => g.id)).toEqual(["user"]);
 });
});

describe("停用名单排序", () => {
 it("按名字排，不改内容", () => {
  expect(sortDisabled(["web", "a", "中文"])).toEqual(["a", "web", "中文"]);
  expect(sortDisabled([])).toEqual([]);
 });
});
