import { describe, expect, it } from "vitest";
import type { PluginDoctorFinding, PluginItem } from "@shared/types";
import { doctorSummary, enabledFeatureNames, toggleFeature } from "./plugins";

const item = (over: Partial<PluginItem> = {}): PluginItem => ({
 name: "p",
 version: "1.0.0",
 path: "/p",
 description: "",
 features: [
  { name: "search", description: "", defaultEnabled: true, enabled: true },
  { name: "web", description: "", defaultEnabled: false, enabled: false },
 ],
 featuresCustomized: false,
 enabled: true,
 ...over,
});

describe("插件特性（整组覆盖写）", () => {
 it("生效集合按后端算好的 enabled 取", () => {
  expect(enabledFeatureNames(item())).toEqual(["search"]);
  expect(
   enabledFeatureNames(
    item({ featuresCustomized: true, features: [{ name: "web", description: "", defaultEnabled: false, enabled: true }] }),
   ),
  ).toEqual(["web"]);
 });

 it("开一个特性不丢其它默认开启的特性（从 null 出发的老 bug）", () => {
  expect(toggleFeature(item(), "web", true)).toEqual(["search", "web"]);
  expect(enabledFeatureNames(item({ features: [{ name: "web", description: "", defaultEnabled: false, enabled: true }, { name: "search", description: "", defaultEnabled: true, enabled: false }] }))).toEqual(["web"]);
 });

 it("关一个特性只摘它自己，顺序按 manifest 键序", () => {
  expect(toggleFeature(item(), "search", false)).toEqual([]);
  expect(
   toggleFeature(
    item({ features: [{ name: "b", description: "", defaultEnabled: false, enabled: true }, { name: "a", description: "", defaultEnabled: false, enabled: true }] }),
    "a",
    false,
   ),
  ).toEqual(["b"]);
 });
});

describe("体检结论汇总", () => {
 const f = (status: string, fixed = false): PluginDoctorFinding => ({ name: status, status, message: "", fixed });

 it("按状态计数，已修复的单独数", () => {
  expect(doctorSummary([f("ok"), f("warning"), f("error"), f("error", true)])).toEqual({
   ok: 1,
   warning: 1,
   error: 2,
   fixed: 1,
  });
  expect(doctorSummary([])).toEqual({ ok: 0, warning: 0, error: 0, fixed: 0 });
 });

 it("未知状态不混进任何一档（上游加档位时界面不该瞎报）", () => {
  expect(doctorSummary([f("info"), f("ok")])).toEqual({ ok: 1, warning: 0, error: 0, fixed: 0 });
 });
});
