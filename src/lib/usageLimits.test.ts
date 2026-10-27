import { describe, expect, it } from "vitest";
import type { ProviderUsage, ProviderUsageReport, UsageLimit } from "@shared/types";
import { entryGlance, hasLimits, hasUsageEntry, usageEntryDisabled } from "./usageLimits";

/**
 * 入口侧（输入卡底部统计条上的「供应商用量」）纯逻辑测试。
 *
 * 口径（2026-10-14 定、2026-10-16 随统计条搬到卡底）：看**我配置的供应商**，与当前会话的模型无关
 * ——条上是「图标 + 最紧窗口读数（`tightest`）」，配色档同样由最紧的窗口定，浮层列全部。
 * 「配了但拿不到用量」的基础判定覆盖在 `providerUsage.test.ts`。
 */

/** 造一个窗口（只写关心的字段，其余给中性值）。 */
const limit = (windowId: string, usedFraction: number, status = "ok"): UsageLimit => ({
 id: windowId === "5h" ? "rolling-5h" : windowId,
 label: windowId,
 windowId,
 windowLabel: windowId,
 usedFraction,
 percent: usedFraction * 100,
 status,
 resetsAt: null,
 durationMs: null,
 notes: [],
 used: null,
 limit: null,
 remaining: null,
 unit: "percent",
});

const report = (provider: string, limits: UsageLimit[]): ProviderUsageReport => ({
 provider,
 planType: null,
 accountLabel: null,
 fetchedAt: 0,
 limits,
});

/** 造一份用量快照（只写关心的字段）。 */
const usage = (partial: Partial<ProviderUsage>): ProviderUsage => ({
 generatedAt: 1,
 reports: [],
 accountsWithoutUsage: [],
 disabledCredentials: [],
 configuredProviders: [],
 extraFailures: [],
 ...partial,
});

describe("entryGlance（图标一眼摘要 + 配色档）", () => {
 const base = usage({
  reports: [
   report("aaa", [limit("5h", 0.4), limit("7d", 0.5)]),
   report("bbb", [limit("monthly", 0.1)]),
   report("ccc", []),
  ],
 });

 it("列全部供应商的全部窗口（上游顺序），空窗口的供应商不掺进来", () => {
  const { items } = entryGlance(base);
  expect(items.map((i) => [i.provider, i.limit.windowId])).toEqual([
   ["aaa", "5h"],
   ["aaa", "7d"],
   ["bbb", "monthly"],
  ]);
 });

 it("配色档取最紧的窗口：安静时 ok、≥80% 转 warn、用尽转 danger", () => {
  expect(entryGlance(base).level).toBe("ok");
  expect(entryGlance(usage({ reports: [report("aaa", [limit("7d", 0.85)])] })).level).toBe("warn");
  expect(entryGlance(usage({ reports: [report("aaa", [limit("7d", 1)]), report("bbb", [limit("5h", 0.1)])] })).level).toBe("danger");
 });

 it("没有任何窗口 / 没有数据 → 空摘要、ok 档、无读数", () => {
  expect(entryGlance(usage({ reports: [report("ccc", [])] }))).toEqual({ level: "ok", items: [], tightest: null });
  expect(entryGlance(null)).toEqual({ level: "ok", items: [], tightest: null });
 });

 it("读数取最紧的那个窗口（档位优先，同档比已用比例），并给出其余窗口数", () => {
  // 5h 0.4 / 7d 0.5 / monthly 0.1：同档取比例最大的 7d
  const g = entryGlance(base);
  expect(g.tightest?.provider).toBe("aaa");
  expect(g.tightest?.limit.windowId).toBe("7d");
  expect(g.tightest?.extra).toBe(2);
  // 有窗口用尽时读数就是它（哪怕别的窗口比例更高）
  const danger = entryGlance(usage({ reports: [report("aaa", [limit("5h", 0.3)]), report("bbb", [limit("7d", 1)])] }));
  expect(danger.tightest?.provider).toBe("bbb");
  expect(danger.tightest?.extra).toBe(1);
  // 只有一个窗口时没有「+N」
  const single = entryGlance(usage({ reports: [report("aaa", [limit("5h", 0.2)])] }));
  expect(single.tightest?.extra).toBe(0);
 });
});

describe("hasLimits 与入口渲染", () => {
 it("一个窗口都没有时 hasLimits 为 false", () => {
  expect(hasLimits(null)).toBe(false);
  expect(hasLimits(usage({ reports: [] }))).toBe(false);
  expect(hasLimits(usage({ reports: [report("p", [])] }))).toBe(false);
  expect(hasLimits(usage({ reports: [report("p", [limit("5h", 0.1)])] }))).toBe(true);
 });

 it("入口：有窗口数据、配了供应商，或查询失败都要渲染", () => {
  expect(hasUsageEntry(null, null)).toBe(false);
  expect(hasUsageEntry(usage({ reports: [] }), null)).toBe(false);
  // 只配了 commandcode 这种没探针的供应商：入口仍在（点开能看到「无用量数据」的解释）
  expect(hasUsageEntry(usage({ configuredProviders: ["commandcode"] }), null)).toBe(true);
  expect(hasUsageEntry(usage({ reports: [report("p", [limit("5h", 0.1)])], configuredProviders: ["p"] }), null)).toBe(true);
  // 从未成功过且失败：也要渲染（一个置灰的按钮，比什么都没有更容易理解）
  expect(hasUsageEntry(null, "读取用量限额失败：omp 命令超时")).toBe(true);
 });
});

describe("usageEntryDisabled", () => {
 const opencode = usage({
  reports: [report("opencode-go", [limit("5h", 0.41)])],
  configuredProviders: ["commandcode", "opencode-go"],
 });

 it("有数据 → 可点（某一家没探针不影响别家）", () => {
  expect(usageEntryDisabled(opencode, null)).toBeNull();
  expect(usageEntryDisabled(opencode, "刷新失败")).toBeNull();
 });

 it("从未查到过 + 查询失败 → 置灰（failed）", () => {
  expect(usageEntryDisabled(null, "读取用量限额失败：omp 命令超时")).toBe("failed");
  expect(usageEntryDisabled(null, null)).toBeNull();
 });
});
