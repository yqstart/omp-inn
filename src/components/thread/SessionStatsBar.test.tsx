// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderUsage, SessionLiveStats } from "@shared/types";
import { __resetSessionLiveStats } from "../../lib/sessionLiveStats";
import { useApp } from "../../stores/app";
import { SessionStatsBar } from "./SessionStatsBar";

/**
 * 卡底统计条（对齐 DeepSeek Harness 的 composer dock）：
 * 四项 —— 会话统计（轮 / 步 · tok/s）、Token 用量（总量 · 缓存命中）、上下文占用、供应商用量。
 *
 * 断言的是**读数与浮层内容**（数字口径见后端 `live_stats.rs`）+ 门槛（没数据整条不渲染）。
 */
const mock = vi.hoisted(() => ({
 getSessionLiveStats: vi.fn(async () => null as SessionLiveStats | null),
}));
vi.mock("@shared/api", () => ({ api: { getSessionLiveStats: mock.getSessionLiveStats } }));

/** 供应商用量的模块级快照（`providerUsage.ts`）在用例间是共享的，这里整块替换成受控值。 */
const h = vi.hoisted(() => ({
 snapshot: { data: null, error: null, loading: false, fetchedAt: 0 } as {
  data: ProviderUsage | null;
  error: string | null;
  loading: boolean;
  fetchedAt: number;
 },
}));
vi.mock("../../lib/providerUsage", async (importOriginal) => ({
 ...(await importOriginal<typeof import("../../lib/providerUsage")>()),
 useProviderUsage: () => h.snapshot,
 loadProviderUsage: () => Promise.resolve(),
}));

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

/** 一份「有内容」的统计（数字与图片里的示例同量纲：7 轮 / 259 步 / 230 tok/s / 63.56M tok）。 */
const STATS: SessionLiveStats = {
 turns: 7,
 steps: 259,
 toolCalls: 312,
 modelMs: 162_000, // 2 分 42 秒
 toolMs: 702_000, // 11 分 42 秒
 ttftMs: 2400,
 decodeMs: 159_600,
 tps: 230,
 tokens: { input: 525_990, output: 230_698, reasoning: 0, cacheRead: 62_804_864, cacheWrite: 0, total: 63_561_552, calls: 259 },
 cacheHitRate: 62_804_864 / 63_330_854,
 cost: 1.5,
 startedAt: 1,
 lastAt: 2,
 truncated: false,
};

const usage = (): ProviderUsage => ({
 generatedAt: 1,
 reports: [
  {
   provider: "opencode-go",
   planType: "OpenCode Go",
   accountLabel: null,
   fetchedAt: 1,
   limits: [
    {
     id: "rolling-5h",
     label: "5 Hour",
     windowId: "5h",
     windowLabel: "5 Hour",
     usedFraction: 0.41,
     percent: 41,
     status: "ok",
     resetsAt: null,
     durationMs: null,
     notes: [],
     used: null,
     limit: null,
     remaining: null,
     unit: "percent",
    },
   ],
  },
 ],
 accountsWithoutUsage: [],
 disabledCredentials: [],
 configuredProviders: ["opencode-go"],
 extraFailures: [],
});

beforeEach(() => {
 __resetSessionLiveStats();
 mock.getSessionLiveStats.mockResolvedValue(STATS);
 h.snapshot = { data: usage(), error: null, loading: false, fetchedAt: Date.now() };
 useApp.setState({
  activeSessionId: "s1",
  locale: "zh-CN",
  composerMenu: null,
  currentRuntime: { contextUsage: { tokens: 46_000, contextWindow: 100_000, percent: 46 } } as never,
  statusBySession: {},
 });
 container = document.createElement("div");
 document.body.append(container);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
});

async function render() {
 await act(async () => {
  root.render(<SessionStatsBar />);
 });
}

describe("SessionStatsBar", () => {
 it("渲染四项读数：轮·步 + 吞吐 / 总量 + 缓存命中 / 上下文 / 供应商（条上只有图标）", async () => {
  await render();
  const text = container.textContent ?? "";
  expect(mock.getSessionLiveStats).toHaveBeenCalledWith("s1");
  // 会话统计：轮 / 步 · 吞吐（同一算式，状态条与浮层一致）
  expect(text).toContain("7 轮 259 步");
  expect(text).toContain("230 tok/s");
  // Token 用量：紧凑总量 + 缓存命中率
  expect(text).toContain("63.56M tok");
  expect(text).toContain("缓存命中 99%");
  // 上下文占用（容量环）
  expect(text).toContain("46%");
  // 供应商用量：2026-10-16 修订口径——条上**只有图标**（按钮里没有任何文字），
  // 读数与窗口名下沉到悬停提示（读屏同源）与浮层里
  const usageBtn = container.querySelector<HTMLButtonElement>('button[aria-label^="用量限额"]');
  expect(usageBtn).not.toBeNull();
  expect(usageBtn!.textContent?.trim()).toBe("");
  expect(usageBtn!.getAttribute("title")).toContain("41%");
  expect(usageBtn!.getAttribute("title")).toContain("5 小时");
 });

 it("会话统计浮层：模型用时 / 工具调用用时 / TTFT 平均 / 输出速度（时长按 DH 口径格式化）", async () => {
  await render();
  const btn = container.querySelector<HTMLButtonElement>('button[aria-label^="会话统计"]');
  expect(btn).not.toBeNull();
  await act(async () => {
   btn!.click();
  });
  expect(useApp.getState().composerMenu).toBe("liveStats");
  const pop = btn!.parentElement?.querySelector('div[class*="shadow-pop"]');
  expect(pop).not.toBeNull();
  const text = pop!.textContent ?? "";
  expect(text).toContain("模型用时");
  expect(text).toContain("2 分 42 秒");
  expect(text).toContain("工具调用用时");
  expect(text).toContain("11 分 42 秒");
  expect(text).toContain("首 token 平均（TTFT）");
  expect(text).toContain("2.4 秒");
  expect(text).toContain("输出速度（TPS）");
  expect(text).toContain("230 tok/s");
  // 头部给「N 轮 · M 步 · K 次工具调用」（DH 的标题行读数）
  expect(text).toContain("7 轮 · 259 步 · 312 次工具调用");
 });

 it("Token 用量浮层：千分位总计 + 缓存命中 / 未缓存输入 / 缓存读取 / 输出", async () => {
  await render();
  const btn = container.querySelector<HTMLButtonElement>('button[aria-label^="Token 用量"]');
  expect(btn).not.toBeNull();
  await act(async () => {
   btn!.click();
  });
  expect(useApp.getState().composerMenu).toBe("liveTokens");
  const pop = btn!.parentElement?.querySelector('div[class*="shadow-pop"]');
  const text = pop!.textContent ?? "";
  expect(text).toContain("63,561,552");
  expect(text).toContain("未缓存输入");
  expect(text).toContain("525,990");
  expect(text).toContain("缓存读取");
  expect(text).toContain("62,804,864");
  expect(text).toContain("输出");
  expect(text).toContain("230,698");
  // 缓存写为 0 时不铺那一行（与 DH 同门槛：只看有没有行值）
  expect(text).not.toContain("缓存写入0");
  expect(text).toContain("$1.50");
 });

 it("浮层包含块 = 统计条根：包装器不许定位、浮层限宽不溢出（窄窗口下不被中列裁切）", async () => {
  await render();
  const btn = container.querySelector<HTMLButtonElement>('button[aria-label^="Token 用量"]');
  expect(btn).not.toBeNull();
  await act(async () => {
   btn!.click();
  });
  const wrap = btn!.parentElement as HTMLElement;
  const pop = wrap.querySelector<HTMLElement>('div[class*="shadow-pop"]');
  expect(pop).not.toBeNull();
  // 贴整条右缘向左展开 + 宽度不超过包含块（相对按钮定位的旧口径会让它向左溢出输入卡）
  expect(pop!.className).toContain("right-0");
  expect(pop!.className).toContain("max-w-full");
  expect(pop!.className).not.toContain("left-0");
  expect(wrap.className).not.toContain("relative");
  // 浮层到统计条根之间不许再有 positioned 祖先（否则包含块又缩回按钮）
  const bar = container.firstElementChild as HTMLElement;
  expect(bar.className).toContain("relative");
  for (let node: HTMLElement | null = pop!.parentElement; node && node !== bar; node = node.parentElement) {
   expect(node.className).not.toContain("relative");
  }
 });

 it("没有读数时整条不渲染（不占版面）", async () => {
  mock.getSessionLiveStats.mockResolvedValue(null);
  h.snapshot = { data: null, error: null, loading: false, fetchedAt: 0 };
  useApp.setState({ currentRuntime: null });
  await render();
  expect(container.firstChild).toBeNull();
 });

 it("文件读不全（truncated）时按没有读数处理", async () => {
  mock.getSessionLiveStats.mockResolvedValue({ ...STATS, truncated: true });
  h.snapshot = { data: null, error: null, loading: false, fetchedAt: 0 };
  useApp.setState({ currentRuntime: null });
  await render();
  expect(container.firstChild).toBeNull();
 });

 it("运行中每 3 秒回读一次，空闲时不轮询", async () => {
  vi.useFakeTimers();
  try {
   useApp.setState({ statusBySession: { s1: { state: "running" } as never } });
   await act(async () => {
    root.render(<SessionStatsBar />);
   });
   const first = mock.getSessionLiveStats.mock.calls.length;
   await act(async () => {
    vi.advanceTimersByTime(3100);
   });
   expect(mock.getSessionLiveStats.mock.calls.length).toBeGreaterThan(first);
   // 停表（轮结束）后不再定时回读
   await act(async () => {
    useApp.setState({ statusBySession: {} });
   });
   const afterIdle = mock.getSessionLiveStats.mock.calls.length;
   await act(async () => {
    vi.advanceTimersByTime(10_000);
   });
   expect(mock.getSessionLiveStats.mock.calls.length).toBe(afterIdle);
  } finally {
   vi.useRealTimers();
  }
 });
});
