// @vitest-environment jsdom
import { setTimeout as delay } from "node:timers/promises";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageHeatRow, UsageStats } from "@shared/types";
import { useApp } from "../../stores/app";
import { UsagePanel } from "./UsagePanel";

/**
 * 使用统计页的口径：
 * - 默认按「今日」拉取（days = 1），切范围才换窗口；
 * - 总览只有三张指标卡（tokens 用量 / Cache 命中率 / 活跃天数）；
 * - 「Token 活动」热力图独立于范围，右上「每日 / 每周 / 累计」只换格子取值、不再发请求；
 *   悬停有量的格子出浮层（总数 + 该档位下的按模型拆分，0 用量不出浮层），底部是「少 ▢▢▢▢▢ 多」对照条。
 */

/** 368 天（2025-09-14 周日 → 2026-09-16）；最后一天给两个模型，其余只有 sonnet。 */
function makeHeat(): UsageHeatRow[] {
 const base = Date.UTC(2025, 8, 14);
 return Array.from({ length: 368 }, (_, i) => {
  const date = new Date(base + i * 86_400_000).toISOString().slice(0, 10);
  if (i === 367) {
   return {
    date,
    total: 1_234_567,
    models: [
     { model: "sonnet", total: 1_000_000 },
     { model: "gpt-5", total: 234_567 },
    ],
   };
  }
  const total = i % 5 === 0 ? 0 : 1000 * (i + 1);
  return { date, total, models: total > 0 ? [{ model: "sonnet", total }] : [] };
 });
}

const heat = makeHeat();

const usage: UsageStats = {
 totals: {
  input: 1000,
  output: 200,
  cacheRead: 300,
  cacheWrite: 40,
  total: 1540,
  calls: 12,
  activeDays: 5,
  currentStreak: 2,
  longestStreak: 3,
  cacheHitRate: 0.5,
 },
 heat,
 scannedFiles: 2,
 extras: 0,
 truncated: false,
};

/** `vi.mock` 的工厂会被提升到文件顶部：用 `vi.hoisted` 拿一个能在用例里改行为的 mock。 */
const mock = vi.hoisted(() => ({ getUsageStats: vi.fn() }));
vi.mock("@shared/api", () => ({ api: { getUsageStats: mock.getUsageStats } }));

/** React 19 的 `act` 要求显式声明测试环境，否则每次调用都打警告。 */
const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
 mock.getUsageStats.mockReset();
 mock.getUsageStats.mockImplementation(async () => usage);
 useApp.setState({ locale: "zh-CN" });
 container = document.createElement("div");
 document.body.append(container);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
});

const flush = async () => {
 await act(async () => {
  await delay(0);
  await delay(0);
 });
};

const render = async () => {
 act(() => {
  root.render(<UsagePanel />);
 });
 await flush();
};

/** 按文案找一枚分段控件按钮（范围与热力图口径共用同一个 radiogroup 样式）。 */
const radio = (label: string): HTMLButtonElement => {
 const found = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
  (b) => b.textContent === label,
 );
 if (!found) throw new Error(`找不到选项：${label}`);
 return found;
};

const heatGrid = (): Element => {
 const grid = container.querySelector('[role="img"][aria-label^="Token 活动热力图"]');
 if (!grid) throw new Error("找不到热力图");
 return grid;
};

/** 悬停第 `i` 格（React 用 mouseover 合成 onMouseEnter），返回浮层文本。 */
const hoverCell = (i: number): string => {
 const cell = heatGrid().children[i] as HTMLElement;
 act(() => {
  cell.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
 });
 return container.querySelector('[class*="pointer-events-none"]')?.textContent ?? "";
};

describe("使用统计 › 范围", () => {
 it("默认按「今日」拉取", async () => {
  await render();
  expect(mock.getUsageStats).toHaveBeenCalledWith(1);
  expect(radio("今日").getAttribute("aria-checked")).toBe("true");
 });

 it("切换范围按对应天数重拉", async () => {
  await render();
  const week = radio("近 7 日");
  act(() => week.click());
  await flush();
  expect(mock.getUsageStats).toHaveBeenLastCalledWith(7);
  expect(week.getAttribute("aria-checked")).toBe("true");
 });

 it("「全部」传 null（不裁剪时间窗口）", async () => {
  await render();
  act(() => radio("全部").click());
  await flush();
  expect(mock.getUsageStats).toHaveBeenLastCalledWith(null);
 });
});

describe("使用统计 › 三张指标卡", () => {
 it("只渲染 tokens 用量 / Cache 命中率 / 活跃天数，其余指标都不在", async () => {
  await render();
  expect(container.textContent).toContain("tokens 用量");
  expect(container.textContent).toContain("1,540");
  expect(container.textContent).toContain("未缓存输入 1,000");
  expect(container.textContent).toContain("Cache 命中率");
  expect(container.textContent).toContain("50%");
  expect(container.textContent).toContain("活跃天数");
  expect(container.textContent).toContain("连续 2 天 · 最长 3 天");
  for (const gone of ["预估费用", "请求数", "工具调用", "最常用模型", "峰值时段", "日均 tokens", "每日 Token 趋势", "按模型"]) {
   expect(container.textContent, gone).not.toContain(gone);
  }
 });

 it("没有缓存分母时命中率显示 —", async () => {
  mock.getUsageStats.mockImplementation(async () => ({
   ...usage,
   totals: { ...usage.totals, cacheRead: 0, cacheHitRate: null },
  }));
  await render();
  expect(container.textContent).toContain("—");
  expect(container.textContent).not.toContain("%");
 });

 it("账本补记（extras）不再上界面：读数照常，来源说明行不出现", async () => {
  mock.getUsageStats.mockImplementation(async () => ({ ...usage, extras: 7 }));
  await render();
  expect(container.textContent).toContain("tokens 用量");
  expect(container.textContent).toContain("1,540");
  expect(container.textContent).not.toContain("本地记账");
  expect(container.textContent).not.toContain("来自本地");
 });
});

describe("使用统计 › Token 活动热力图", () => {
 it("按后端给的日历逐日摆格子，标注月份刻度，底部有对照条", async () => {
  await render();
  expect(container.textContent).toContain("Token 活动");
  expect(heatGrid().children.length).toBe(heat.length);
  // 窗口起点在 9 月中（那一列不标），10 月起的 12 个月份刻度都在
  expect(container.textContent).toContain("10月");
  expect(container.textContent).toContain("9月");
  // 底部对照条：少 ▢▢▢▢▢ 多
  expect(container.textContent).toContain("少");
  expect(container.textContent).toContain("多");
 });

 it("悬停格子出浮层：日期 + token 总数 + 该格的模型拆分（0 用量不出浮层）", async () => {
  await render();
  const tip = hoverCell(367);
  expect(tip).toContain("2026-09-16");
  expect(tip).toContain("1.23M tokens");
  expect(tip).toContain("sonnet");
  expect(tip).toContain("1.00M");
  expect(tip).toContain("gpt-5");
  expect(tip).toContain("234.6K");
  // 0 用量的格子（默认每日档）不出浮层；回到有量的格子还能出来
  expect(hoverCell(0)).toBe("");
  expect(hoverCell(367)).toContain("1.23M tokens");
 });

 it("默认「每日」；切「每周 / 累计」只换读数，不再发请求", async () => {
  await render();
  expect(radio("每日").getAttribute("aria-checked")).toBe("true");
  expect(mock.getUsageStats).toHaveBeenCalledTimes(1);

  act(() => radio("每周").click());
  // 浮层换成整周范围与整周合计；模型明细按周合并后降序（sonnet 365K+367K+1M，gpt-5 234.6K）
  const weekTip = hoverCell(367);
  expect(weekTip).toContain("2026-09-13 – 2026-09-16");
  expect(weekTip).toContain("1.97M tokens");
  expect(weekTip.indexOf("sonnet")).toBeLessThan(weekTip.indexOf("gpt-5"));

  act(() => radio("累计").click());
  expect(hoverCell(367)).toContain("截至 2026-09-16");
  expect(radio("累计").getAttribute("aria-checked")).toBe("true");
  expect(mock.getUsageStats).toHaveBeenCalledTimes(1);
 });
});
