// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStats } from "@shared/types";
import { useApp } from "../../stores/app";
import { SessionStatsDialog } from "./SessionStatsDialog";

/**
 * `/status` 统计弹窗：`getSessionStats` mock 返回固定值，
 * 断言关键数字（千分位 / 成本 / 上下文占用 / 模型 / 思考档 / 执行模式）落到 DOM。
 */
const mock = vi.hoisted(() => ({
 getSessionStats: vi.fn(async () => null as SessionStats | null),
}));
vi.mock("@shared/api", () => ({ api: { getSessionStats: mock.getSessionStats } }));

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const STATS: SessionStats = {
 sessionId: "s1",
 sessionFile: "/tmp/s1.jsonl",
 userMessages: 12,
 assistantMessages: 34,
 toolCalls: 56,
 toolResults: 56,
 totalMessages: 46,
 tokens: { input: 3456, output: 789, reasoning: 120, cacheRead: 100000, cacheWrite: 2000, total: 106365 },
 cost: 1.5,
 premiumRequests: 3,
 contextUsage: { tokens: 12345, contextWindow: 200000, percent: 6.2 },
};

beforeEach(() => {
 mock.getSessionStats.mockResolvedValue(STATS);
 useApp.setState({
  statsOpen: true,
  activeSessionId: "s1",
  currentModel: "anthropic/claude",
  currentRuntime: { thinkingLevel: "high" } as never,
  sessionApprovals: { s1: "full" },
  globalApproval: "write",
  locale: "zh-CN",
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
  root.render(<SessionStatsDialog />);
 });
}

describe("SessionStatsDialog", () => {
 it("渲染消息计数 / token 千分位 / 成本 / 上下文 / 模型三元组", async () => {
  await render();
  const text = container.textContent ?? "";
  expect(mock.getSessionStats).toHaveBeenCalledWith("s1");
  expect(text).toContain("用户 12");
  expect(text).toContain("助手 34");
  expect(text).toContain("工具调用 56");
  expect(text).toContain("3,456");
  expect(text).toContain("100,000");
  expect(text).toContain("106,365");
  expect(text).toContain("$1.50");
  expect(text).toContain("高级请求 3");
  expect(text).toContain("12,345 / 200,000");
  expect(text).toContain("6.2%");
  expect(container.textContent).toContain("anthropic/claude");
  expect(container.textContent).toContain("high");
  expect(container.textContent).toContain("full");
 });

 it("读失败时内联提示，不崩", async () => {
  mock.getSessionStats.mockRejectedValueOnce(new Error("boom"));
  await render();
  expect(container.textContent).toContain("统计读取失败");
 });
});
