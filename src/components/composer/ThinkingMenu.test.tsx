// @vitest-environment jsdom
import { setTimeout as delay } from "node:timers/promises";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@shared/api";
import type { ModelInfo } from "@shared/types";
import { useApp } from "../../stores/app";
import { ThinkingMenu } from "./ThinkingMenu";

/**
 * 思考档选择器（2026-10-14 与模型选择器拆分）：
 * - 档位只列当前模型**真正支持**的档（`off` 恒可用）；不支持思考 / 无会话时整个控件不出现；
 * - 浮层是纵向行钮列表（顶部小标题 + 当前档打勾），与模型 / 执行模式选择器同口径；
 * - 默认档读 omp 的 `defaultThinkingLevel`：真值合法显示真值，缺档 / 非法显示配置默认档
 *   （夹到支持集），配置没读到退最高档；
 * - 点选下发 `set_thinking_level` 并即时收起。
 */

const m = (provider: string, id: string, thinking: string[] | null = null): ModelInfo => ({
 provider,
 id,
 selector: `${provider}/${id}`,
 name: id,
 contextWindow: 128000,
 maxTokens: null,
 reasoning: null,
 thinking,
 input: ["text"],
});

const CATALOG = [m("demo", "reason", ["low", "medium", "high"]), m("demo", "plain")];

vi.mock("@shared/api", () => ({
 api: {
  setThinking: vi.fn(async () => { }),
  getDefaultThinkingLevel: vi.fn(async () => "medium"),
 },
}));

/** React 19 的 `act` 要求显式声明测试环境，否则每次调用都打警告。 */
const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
 vi.clearAllMocks();
 useApp.setState({
  models: { models: CATALOG, fetchedAt: 0 },
  composerMenu: "thinking", // 直接开浮层，省掉点击触发按钮这一步
  activeSessionId: "s1",
  currentModel: "demo/reason",
  currentThinking: null,
  currentEfforts: ["low", "medium", "high"],
  ompDefaultThinking: "medium",
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

const trigger = () => container.querySelector<HTMLButtonElement>('button[aria-label="选择思考等级"]');
const rows = () => [...container.querySelectorAll<HTMLButtonElement>('button[aria-label^="思考等级 "]')];

describe("思考档选择器", () => {
 it("只列当前模型支持的档位（off 恒在），点选下发 set_thinking_level 并收起", async () => {
  act(() => {
   root.render(<ThinkingMenu />);
  });
  expect(rows().map((b) => b.textContent)).toEqual(["off", "low", "medium", "high"]);
  // 纵向行钮（每行占满浮层宽度、当前档行尾打勾），不再是并排的一排芯片
  expect(rows().every((b) => b.className.includes("w-full"))).toBe(true);
  expect(rows()[2].querySelector("svg")).not.toBeNull();
  expect(rows()[0].querySelector("svg")).toBeNull();
  // 缺档时显示的是 omp 配置的默认档（medium），不是最高档
  expect(trigger()?.textContent).toContain("medium");
  expect(rows()[2].getAttribute("aria-pressed")).toBe("true");
  expect(container.textContent).toContain("omp 默认：medium");

  act(() => rows()[3].click());
  await act(async () => { await delay(0); });
  expect(vi.mocked(api.setThinking)).toHaveBeenCalledWith("s1", "high");
  expect(useApp.getState().currentThinking).toBe("high");
  expect(useApp.getState().composerMenu).toBeNull();
 });

 it("omp 真值合法时优先于配置默认档", () => {
  useApp.setState({ currentThinking: "high" });
  act(() => {
   root.render(<ThinkingMenu />);
  });
  expect(trigger()?.textContent).toContain("high");
  expect(rows()[3].getAttribute("aria-pressed")).toBe("true");
 });

 it("配置默认档不被该模型支持 / 没读到 → 最高档兜底（不编造档位）", () => {
  useApp.setState({ ompDefaultThinking: "max" });
  act(() => {
   root.render(<ThinkingMenu />);
  });
  expect(trigger()?.textContent).toContain("high");
  // 提示行给的是**对该模型生效**的默认档（max 夹到 high），不是配置原文
  expect(container.textContent).toContain("omp 默认：high");

  act(() => root.unmount());
  act(() => useApp.setState({ ompDefaultThinking: null }));
  root = createRoot(container);
  act(() => {
   root.render(<ThinkingMenu />);
  });
  expect(trigger()?.textContent).toContain("high");
  expect(container.textContent).not.toContain("omp 默认");
 });

 it("模型不支持思考 / 没有会话时整个控件不出现", () => {
  useApp.setState({ currentEfforts: null, currentModel: "demo/plain" }); // 目录里就是无思考模型
  act(() => {
   root.render(<ThinkingMenu />);
  });
  expect(container.textContent).toBe("");

  act(() => root.unmount());
  useApp.setState({ currentEfforts: ["low", "high"], activeSessionId: null });
  root = createRoot(container);
  act(() => {
   root.render(<ThinkingMenu />);
  });
  expect(container.textContent).toBe("");
 });

 it("打开浮层会补读一次默认档（读取失败过 / 配置在别处改过都能收敛）", async () => {
  useApp.setState({ ompDefaultThinking: null }); // 还没读到 → 打开浮层时补读
  act(() => {
   root.render(<ThinkingMenu />);
  });
  await act(async () => { await delay(0); });
  expect(vi.mocked(api.getDefaultThinkingLevel)).toHaveBeenCalled();
  expect(useApp.getState().ompDefaultThinking).toBe("medium");
 });
});
