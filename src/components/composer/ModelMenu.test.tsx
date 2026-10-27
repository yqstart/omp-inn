// @vitest-environment jsdom
import { setTimeout as delay } from "node:timers/promises";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@shared/api";
import type { ModelInfo } from "@shared/types";
import { useApp } from "../../stores/app";
import { ModelMenu } from "./ModelMenu";

/**
 * 模型选择器（2026-10-14 与思考档拆分）：
 * - 分区 = **我的模型**置顶成组 + 其余按供应商（与设置页模型弹窗同一份口径，`splitStarredModels`）；
 * - **每行带供应商标识**：同名模型来自多家（ark.cn / ccproxy…）时只给名字分不出来；
 * - 点选走 `set_model`；思考档只在后端兜底，这里断言乐观镜像后同一口径（有效档保留、
 *   缺档 / 非法才落 omp 配置的默认档）。
 */

const m = (
 provider: string,
 id: string,
 name = id,
 thinking: string[] | null = null,
): ModelInfo => ({
 provider,
 id,
 selector: `${provider}/${id}`,
 name,
 contextWindow: 128000,
 maxTokens: null,
 reasoning: null,
 thinking,
 input: ["text"],
});

/** 同名不同家：命令批里最常见的歧义源（每行必须自带供应商）。 */
const CATALOG = [
 m("demo", "plain"),
 m("demo", "reason", "Reason", ["low", "high"]),
 m("other", "flash"),
 m("ark.cn", "deepseek-v4.1-flash", "DeepSeek-V4.1-Flash"),
 m("ccproxy", "deepseek/deepseek-v4.1-flash-fast", "DeepSeek-V4.1-Flash"),
];

vi.mock("@shared/api", () => ({
 api: {
  getModels: vi.fn(async () => ({ models: CATALOG, fetchedAt: 0 })),
  refreshModels: vi.fn(async () => ({ models: CATALOG, fetchedAt: 0 })),
  setModel: vi.fn(async () => { }),
 },
}));

/** React 19 的 `act` 要求显式声明测试环境，否则每次调用都打警告。 */
const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
 useApp.setState({
  models: { models: CATALOG, fetchedAt: 0 },
  composerMenu: "model", // 直接开下拉，省掉点击触发按钮这一步
  currentModel: null,
  currentThinking: null,
  currentEfforts: null,
  ompDefaultThinking: null,
  activeSessionId: null,
  myModels: [],
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

/** 下拉里的分区标题（我的模型 + 各供应商）与行顺序。 */
const headers = () => [...container.querySelectorAll("div.px-1.pt-2")].map((el) => el.textContent);
const rows = () => [...container.querySelectorAll('button[aria-label^="使用模型"]')].map((el) => el.getAttribute("aria-label"));

describe("模型选择器", () => {
 it("我的模型置顶成组、星标项不在供应商组里重复出现；行首星标即时加 / 摘", () => {
  useApp.setState({ myModels: ["other/flash"] });
  act(() => {
   root.render(<ModelMenu />);
  });
  expect(headers()).toEqual(["我的模型", "demo", "ark.cn", "ccproxy"]);
  expect(rows()).toEqual([
   "使用模型 flash",
   "使用模型 plain",
   "使用模型 Reason",
   "使用模型 DeepSeek-V4.1-Flash",
   "使用模型 DeepSeek-V4.1-Flash",
  ]);

  // 行首星标 = 加入 / 移出「我的模型」（同一份 localStorage 偏好），分区即时跟着变
  act(() => (container.querySelector('[aria-label="加入我的模型 plain"]') as HTMLButtonElement).click());
  expect(useApp.getState().myModels).toEqual(["other/flash", "demo/plain"]);
  act(() => (container.querySelector('[aria-label="移出我的模型 flash"]') as HTMLButtonElement).click());
  expect(useApp.getState().myModels).toEqual(["demo/plain"]);
  expect(headers()).toEqual(["我的模型", "demo", "other", "ark.cn", "ccproxy"]);
 });

 it("每一行都带供应商标识（同名模型来自多家时分得清）", () => {
  useApp.setState({ myModels: ["ark.cn/deepseek-v4.1-flash", "ccproxy/deepseek/deepseek-v4.1-flash-fast"] });
  act(() => {
   root.render(<ModelMenu />);
  });
  // 星标区（无分组标题托底）与供应商组里都自带 provider
  const texts = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label^="使用模型"]')].map(
   (el) => el.textContent,
  );
  expect(texts[0]).toContain("ark.cn");
  expect(texts[1]).toContain("ccproxy");
  expect(texts[2]).toContain("demo"); // 供应商组里的行同样带一份
 });

 it("搜索按 provider/id 命中（供应商也可搜），点选行按 provider/id 走 IPC 并收起", async () => {
  useApp.setState({ myModels: ["other/flash"], activeSessionId: "s1" });
  act(() => {
   root.render(<ModelMenu />);
  });
  const input = container.querySelector("#model-search") as HTMLInputElement;
  // React 受控输入的 value 要走原型 setter，再派发 input 事件才会进 onChange
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  const search = (q: string) =>
   act(() => {
    setter.call(input, q);
    input.dispatchEvent(new Event("input", { bubbles: true }));
   });

  search("ccproxy"); // 供应商名也是搜索词：命中 ccproxy 那一条，其余全滤掉
  expect(rows()).toEqual(["使用模型 DeepSeek-V4.1-Flash"]);
  expect(headers()).toEqual(["ccproxy"]);

  search("plain");
  expect(rows()).toEqual(["使用模型 plain"]);
  act(() => (container.querySelector('[aria-label="使用模型 plain"]') as HTMLButtonElement).click());
  await act(async () => { await delay(0); });
  expect(vi.mocked(api.setModel)).toHaveBeenCalledWith("s1", "demo", "plain");
  expect(useApp.getState().composerMenu).toBeNull();
 });

 it("选模型镜像兜底口径：仍然合法的档位留着（omp 不丢档）", async () => {
  useApp.setState({ activeSessionId: "s1", currentModel: "demo/plain", currentThinking: "low", ompDefaultThinking: "max" });
  act(() => {
   root.render(<ModelMenu />);
  });
  act(() => (container.querySelector('[aria-label="使用模型 Reason"]') as HTMLButtonElement).click());
  await act(async () => { await delay(0); });
  // low 对新模型（low/high）仍然合法 → 保留用户选择，不落默认档
  expect(useApp.getState().currentThinking).toBe("low");
  expect(useApp.getState().currentEfforts).toEqual(["low", "high"]);
 });

 it("选模型镜像兜底口径：档位缺失 / 对新模型非法 → 落 omp 配置的默认档（夹到支持集）", async () => {
  useApp.setState({ activeSessionId: "s1", currentModel: "demo/plain", currentThinking: null, ompDefaultThinking: "low" });
  act(() => {
   root.render(<ModelMenu />);
  });
  act(() => (container.querySelector('[aria-label="使用模型 Reason"]') as HTMLButtonElement).click());
  await act(async () => { await delay(0); });
  expect(useApp.getState().currentThinking).toBe("low");

  // 当前档对新模型非法（max 不在 low/high 里）、配置默认档也不被支持 → 退回该模型最高档
  act(() => useApp.setState({ composerMenu: "model", currentModel: "demo/plain", currentThinking: "max", ompDefaultThinking: "max" }));
  act(() => (container.querySelector('[aria-label="使用模型 Reason"]') as HTMLButtonElement).click());
  await act(async () => { await delay(0); });
  expect(useApp.getState().currentThinking).toBe("high");
 });
});
