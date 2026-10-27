import { describe, expect, it } from "vitest";
import type { ProjectView } from "@shared/types";
import { scopeChoices, scopeValue } from "./panelScope";

const project = (name: string, path: string, missing = false): ProjectView => ({
 id: path,
 path,
 name,
 missing,
 sessionCount: 0,
 workspaceId: null,
});

describe("设置页范围选择（全局 / 项目）", () => {
 it("全局永远在首位，缺目录的项目不列", () => {
  const options = scopeChoices("全局（用户级）", [
   project("app", "/w/app"),
   project("gone", "/w/gone", true),
  ]);
  expect(options[0]).toEqual({ value: "全局（用户级）", label: "全局（用户级）", path: null });
  expect(options.map((o) => o.path)).toEqual([null, "/w/app"]);
 });

 it("同名项目把路径并进 value，按钮上才分得清", () => {
  const options = scopeChoices("全局", [project("api", "/a/api"), project("api", "/b/api")]);
  expect(options.map((o) => o.value)).toEqual(["全局", "api · /a/api", "api · /b/api"]);
 });

 it("选中路径 → value；项目消失回退全局", () => {
  const options = scopeChoices("全局", [project("app", "/w/app")]);
  expect(scopeValue(options, "/w/app")).toBe("app");
  expect(scopeValue(options, null)).toBe("全局");
  expect(scopeValue(options, "/w/gone")).toBe("全局");
  expect(scopeValue([], null)).toBe("");
 });
});
