// @vitest-environment jsdom
import { setTimeout as delay } from "node:timers/promises";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderUsage, ProviderUsageReport, UsageLimit } from "@shared/types";
import { useApp } from "../../stores/app";
import type { ProviderUsageSnapshot } from "../../lib/providerUsage";
import { ProviderUsageDialog } from "./ProviderUsageDialog";

/**
 * 「供应商用量」弹窗的口径：
 * - 每个供应商一张卡（套餐名 + provider id），窗口行 = 窗口名 + 进度条 + 百分比 + 重置倒计时；
 * - 上游 `exhausted` / `warning` 也要反映成状态（sr-only 文本，颜色不是唯一信号）；
 * - 「配了但无用量数据」与「已停用的凭据」显式列出；空报告给空态；
 * - **用户主动登出 / 删除 / 被替换的凭据墓碑不进警示块**（那是用户自己的动作，
 *   见 `disabledCredentialsToWarn`）；
 * - 失败时若有旧数据继续显示（错误行 + 旧卡片），不闪空。
 *
 * 数据层的取数行为在 `lib/providerUsage.test.ts` 里单测；这里用 mock 快照只验证 UI 映射。
 */

const h = vi.hoisted(() => ({
 snapshot: { data: null, error: null, loading: false, fetchedAt: 0 } as unknown,
}));

vi.mock("../../lib/providerUsage", async (importOriginal) => {
 const actual = await importOriginal<Record<string, unknown>>();
 return { ...actual, useProviderUsage: () => h.snapshot, loadProviderUsage: () => Promise.resolve() };
});

/** React 19 的 `act` 要求显式声明测试环境，否则每次调用都打警告。 */
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
 useApp.setState({ locale: "zh-CN" });
 setSnapshot({});
 container = document.createElement("div");
 document.body.appendChild(container);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
});

/** 渲染弹窗并让「现在」校准的 setTimeout(0) 跑掉（重置倒计时/更新于 N 前才会出现）。 */
async function renderDialog(): Promise<string> {
 await act(async () => {
  root.render(<ProviderUsageDialog />);
 });
 await act(async () => {
  await delay(5);
 });
 return container.textContent ?? "";
}

describe("供应商用量弹窗", () => {
 it("渲染供应商卡片与窗口行（套餐名 / provider id / 百分比 / 状态文本）", async () => {
  setSnapshot({
   data: usage({
    reports: [
     report("opencode-go", {
      planType: "OpenCode Go",
      limits: [
       { ...limit(), resetsAt: Date.now() + 90 * 60_000 },
       limit({ id: "weekly", windowId: "7d", windowLabel: "Weekly", usedFraction: 0.91, percent: 91, status: "warning" }),
       limit({ id: "monthly", windowId: "monthly", windowLabel: "Monthly", usedFraction: 0.46, percent: 46 }),
      ],
     }),
    ],
   }),
  });
  const text = await renderDialog();
  expect(text).toContain("OpenCode Go");
  expect(text).toContain("opencode-go");
  expect(text).toContain("5 小时");
  expect(text).toContain("50%");
  expect(text).toContain("91%");
  expect(text).toContain("每周");
  expect(text).toContain("每月");
  expect(text).toContain("接近限额"); // 91% + status=warning 的 sr-only 状态
  expect(text).toContain("后重置");
  expect(text).toMatch(/更新于 .*前/);
 });

 it("同一供应商多账号：显示账号数与账号标识", async () => {
  setSnapshot({
   data: usage({
    reports: [
     report("anthropic", { planType: "Claude Pro", accountLabel: "a@example.com", limits: [limit()] }),
     report("anthropic", { planType: "Claude Pro", accountLabel: "b@example.com", limits: [limit()] }),
    ],
   }),
  });
  const text = await renderDialog();
  expect(text).toContain("2 个账号");
  expect(text).toContain("a@example.com");
  expect(text).toContain("b@example.com");
 });

 it("空报告给空态；配了但上游没探针的供应商显式列出", async () => {
  setSnapshot({ data: usage({ configuredProviders: ["commandcode"] }) });
  const text = await renderDialog();
  expect(text).toContain("还没有可显示的用量");
  expect(text).toContain("以下供应商没有用量数据");
  expect(text).toContain("commandcode");
 });

 it("已停用的凭据给警示块（用户主动登出的墓碑不提示）；有账号没有用量数据给一行说明", async () => {
  setSnapshot({
   data: usage({
    reports: [report("opencode-go", { planType: "OpenCode Go", limits: [limit()] })],
    disabledCredentials: [
     { provider: "anthropic", kind: "oauth", email: "me@example.com", accountId: null, cause: "refresh failed", disabledAtMs: 1 },
     { provider: "cursor", kind: "oauth", email: null, accountId: "acc-9", cause: "logged out by user", disabledAtMs: 2 },
    ],
    accountsWithoutUsage: [{ provider: "windsurf", kind: "oauth", email: null, accountId: "acc-1" }],
   }),
  });
  const text = await renderDialog();
  expect(text).toContain("已停用的凭据");
  expect(text).toContain("me@example.com");
  expect(text).toContain("refresh failed");
  expect(text).not.toContain("cursor");
  expect(text).not.toContain("logged out by user");
  expect(text).toContain("1 个已登录账号本次没有拿到用量数据");
 });

 it("只剩用户主动登出的墓碑时，整块警示不渲染", async () => {
  setSnapshot({
   data: usage({
    reports: [report("cursor", { planType: "Cursor Pro", limits: [limit()] })],
    disabledCredentials: [
     { provider: "cursor", kind: "oauth", email: null, accountId: "acc-9", cause: "logged out by user", disabledAtMs: 2 },
    ],
   }),
  });
  const text = await renderDialog();
  expect(text).toContain("Cursor Pro");
  expect(text).not.toContain("已停用的凭据");
  expect(text).not.toContain("重新登录该供应商即可恢复");
 });

 it("失败时保留旧数据（错误行 + 旧卡片都在），无数据时只给错误行", async () => {
  setSnapshot({
   data: usage({ reports: [report("opencode-go", { planType: "OpenCode Go", limits: [limit()] })] }),
   error: "读取供应商用量失败：omp 命令超时",
  });
  let text = await renderDialog();
  expect(text).toContain("读取供应商用量失败：omp 命令超时");
  expect(text).toContain("OpenCode Go");

  setSnapshot({ error: "读取供应商用量失败：omp 命令超时" });
  text = await renderDialog();
  expect(text).toContain("读取供应商用量失败：omp 命令超时");
  expect(text).not.toContain("OpenCode Go");
 });

 it("金额窗口按官方口径显示百分比（金额进悬停提示），余额显示「N 剩余」", async () => {
  setSnapshot({
   data: usage({
    reports: [
     report("commandcode", {
      limits: [
       limit({ usedFraction: 0.0219, percent: 2.19, used: 0.306, limit: 14, remaining: 13.69, unit: "usd" }),
       limit({ id: "monthly", windowId: "monthly", windowLabel: "Monthly", usedFraction: 0.2176, percent: 21.76, used: 15.23, limit: 70, remaining: 54.77, unit: "usd" }),
      ],
     }),
     report("deepseek", {
      limits: [limit({ id: "balance-cny", windowId: "balance", windowLabel: "Balance", used: null, limit: null, remaining: 110, unit: "cny" })],
     }),
    ],
   }),
  });
  await renderDialog();
  const text = container.textContent ?? "";
  expect(text).toContain("2.2%");
  expect(text).toContain("22%");
  expect(text).toContain("每月");
  expect(text).toContain("余额");
  expect(text).toContain("¥110.00 剩余");
  expect(text).not.toContain("$0.31 / $14.00");
  // 金额细节进 title（悬停可见）
  const titles = [...container.querySelectorAll("span[title]")].map((s) => s.getAttribute("title") ?? "");
  expect(titles.some((t) => t.includes("$0.31 / $14.00"))).toBe(true);
  expect(titles.some((t) => t.includes("$15.23 / $70.00"))).toBe(true);
 });

 it("补充探针失败显示「查询失败」块，且不混进「无用量数据」", async () => {
  setSnapshot({
   data: usage({
    configuredProviders: ["commandcode"],
    extraFailures: [{ provider: "commandcode", message: "HTTP 401：Invalid API key" }],
   }),
  });
  const text = await renderDialog();
  expect(text).toContain("以下供应商查询失败");
  expect(text).toContain("commandcode");
  expect(text).toContain("HTTP 401：Invalid API key");
  expect(text).not.toContain("以下供应商没有用量数据");
 });

 it("同一 windowId 下多个池子用上游 label 区分（cursor）；计数型窗口显示数量而不是 0.0%", async () => {
  setSnapshot({
   data: usage({
    reports: [
     report("cursor", {
      planType: "Pro",
      limits: [
       limit({
        id: "cursor:requests:gpt-4",
        label: "gpt-4 requests",
        windowId: "monthly",
        windowLabel: "Monthly",
        usedFraction: 0,
        percent: 0,
        used: 0,
        limit: null,
        remaining: null,
        unit: "requests",
       }),
       limit({
        id: "cursor:usd:individual-auto",
        label: "Cursor Models",
        windowId: "monthly",
        windowLabel: "Monthly",
        usedFraction: 0.1317,
        percent: 13.168,
       }),
       limit({
        id: "cursor:usd:individual-api",
        label: "Other Models",
        windowId: "monthly",
        windowLabel: "Monthly",
        usedFraction: 0.0109,
        percent: 1.088,
        used: 0.2178,
        limit: 20,
        remaining: 19.78,
        unit: "usd",
       }),
      ],
     }),
    ],
   }),
  });
  const text = await renderDialog();
  expect(text).toContain("0 requests"); // 计数型窗口：不拿缺省的 usedFraction 显示 0.0%
  expect(text).toContain("13%");
  expect(text).toContain("1.1%");
  // 三行名字精确匹配（名字列 = w-28 的 span）：不再出现三行「每月」
  const names = [...container.querySelectorAll("span.w-28")].map((s) => s.textContent);
  expect(names).toEqual(["gpt-4 requests", "Cursor Models", "Other Models"]);
 });
});
