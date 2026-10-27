// @vitest-environment jsdom
import { setTimeout as delay } from "node:timers/promises";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderUsage, ProviderUsageReport, UsageLimit } from "@shared/types";
import type { ProviderUsageSnapshot } from "../../lib/providerUsage";
import { useApp } from "../../stores/app";
import { UsageLimits } from "./UsageLimits";

/**
 * 输入卡「供应商用量」浮层的形态口径（2026-10-21 重做）：
 * - 每个供应商一张卡，窗口行在卡内；
 * - 有比例的窗口**两行**：名称 + 重置倒计时 / 进度条 + 百分比（条占满整行，不再被夹在
 *   固定宽度的名称与倒计时之间）；纯余额窗口一行放完；
 * - commandcode 的月度窗口要画条（「每月 92%」），不能只剩一行 credits 余额；
 * - 余额窗口不编造 0.0%、不画空条；「无用量数据」与「补充探针失败」分开列。
 */

const h = vi.hoisted(() => ({
 snapshot: { data: null, error: null, loading: false, fetchedAt: 0 } as unknown,
}));

vi.mock("../../lib/providerUsage", async (importOriginal) => {
 const actual = await importOriginal<Record<string, unknown>>();
 return { ...actual, useProviderUsage: () => h.snapshot, loadProviderUsage: () => Promise.resolve() };
});

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

const limit = (over: Partial<UsageLimit> = {}): UsageLimit => ({
 id: "rolling-5h",
 label: "5 Hour limit",
 windowId: "5h",
 windowLabel: "5 Hour",
 usedFraction: 0.5,
 percent: 50,
 status: "ok",
 resetsAt: null,
 durationMs: 18_000_000,
 notes: [],
 used: null,
 limit: null,
 remaining: null,
 unit: "percent",
 ...over,
});

const report = (provider: string, over: Partial<ProviderUsageReport> = {}): ProviderUsageReport => ({
 provider,
 planType: null,
 accountLabel: null,
 fetchedAt: Date.now(),
 limits: [],
 ...over,
});

const usage = (over: Partial<ProviderUsage> = {}): ProviderUsage => ({
 generatedAt: Date.now(),
 reports: [],
 accountsWithoutUsage: [],
 disabledCredentials: [],
 configuredProviders: [],
 extraFailures: [],
 ...over,
});

function setSnapshot(over: Partial<ProviderUsageSnapshot>): void {
 h.snapshot = { data: null, error: null, loading: false, fetchedAt: 0, ...over };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
 useApp.setState({ locale: "zh-CN", composerMenu: "usage" });
 setSnapshot({});
 container = document.createElement("div");
 document.body.appendChild(container);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
});

async function renderPopover(): Promise<HTMLDivElement> {
 await act(async () => {
  root.render(<UsageLimits />);
 });
 await act(async () => {
  await delay(5);
 });
 const panel = container.querySelector<HTMLDivElement>("div.shadow-pop");
 expect(panel).not.toBeNull();
 return panel!;
}

describe("供应商用量浮层", () => {
 it("供应商卡片 + 两行窗口：commandcode 的月度额度画进度条，余额窗口不画空条", async () => {
  setSnapshot({
   data: usage({
    reports: [
     report("commandcode", {
      limits: [
       limit({ id: "commandcode:5h", usedFraction: 0.0001, percent: 0.01 }),
       limit({ id: "commandcode:7d", windowId: "7d", windowLabel: "Weekly", usedFraction: 0.8455, percent: 84.55 }),
       limit({
        id: "monthly",
        windowId: "monthly",
        windowLabel: "Monthly",
        usedFraction: 0.9234,
        percent: 92.34,
        used: 64.64,
        limit: 70,
        remaining: 5.36,
        unit: "credits",
        status: "warning",
       }),
       limit({
        id: "commandcode:balance",
        windowId: "balance",
        windowLabel: "Credit balance",
        usedFraction: 0,
        percent: 0,
        remaining: 5.36,
        unit: "credits",
       }),
      ],
     }),
     report("deepseek", {
      limits: [
       limit({
        id: "balance-cny",
        windowId: "balance",
        windowLabel: "Balance",
        usedFraction: 0,
        percent: 0,
        remaining: 63.35,
        unit: "cny",
       }),
      ],
     }),
    ],
   }),
  });
  const panel = await renderPopover();
  const text = panel.textContent ?? "";
  expect(text).toContain("用量限额");
  expect(text).toContain("commandcode");
  expect(text).toContain("deepseek");
  // 三档窗口 + 两行余额都在（月额度不再退化成一行 credits 余额）
  for (const name of ["5 小时", "每周", "每月", "余额"]) expect(text).toContain(name);
  expect(text).toContain("85%");
  expect(text).toContain("92%");
  expect(text).toContain("5.36 credits 剩余");
  expect(text).toContain("¥63.35 剩余");
  // 余额窗口不编造 0.0%、不画空条
  const balanceRow = panel.querySelector<HTMLElement>('[data-window="balance"][data-bar="false"]');
  expect(balanceRow).not.toBeNull();
  expect(balanceRow!.textContent).not.toContain("0.0%");

  // 有比例的窗口 = data-bar=true，并真的有一根按比例设宽度的条
  const monthly = panel.querySelector<HTMLElement>('[data-window="monthly"][data-bar="true"]');
  expect(monthly).not.toBeNull();
  const bar = monthly!.querySelector<HTMLElement>('span[style*="width"]');
  expect(bar).not.toBeNull();
  expect(bar!.style.width).toBe("92.34%");
  // 两行结构：名称与倒计时一行、进度条与百分比一行（百分比是 12px mono）
  const monthlyText = monthly!.textContent ?? "";
  expect(monthlyText).toContain("每月");
  expect(monthlyText).toContain("92%");
  // 金额细节在悬停提示里（同单位只写一次）
  const title = monthly!.querySelector<HTMLElement>('[title*="64.64 / 70 credits"]');
  expect(title).not.toBeNull();
 });

 it("配了但没探针的供应商与补充探针失败分开列（不混成「无用量数据」）", async () => {
  setSnapshot({
   data: usage({
    configuredProviders: ["commandcode", "ghost"],
    extraFailures: [{ provider: "commandcode", message: "月度额度：HTTP 401：Invalid API key" }],
   }),
  });
  const panel = await renderPopover();
  const text = panel.textContent ?? "";
  expect(text).toContain("ghost");
  expect(text).toContain("无用量数据");
  expect(text).toContain("查询失败");
  expect(text).toContain("HTTP 401");
  // 失败供应商不出现在「无用量数据」块里
  const noDataBlock = panel.querySelector<HTMLElement>('[data-block="missing"]');
  expect(noDataBlock).not.toBeNull();
  expect(noDataBlock!.textContent).toContain("ghost");
  expect(noDataBlock!.textContent).not.toContain("commandcode");
 });
});
