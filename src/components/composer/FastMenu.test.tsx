// @vitest-environment jsdom
import { setTimeout as delay } from "node:timers/promises";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@shared/api";
import { useApp } from "../../stores/app";
import { FastMenu } from "./FastMenu";

/**
 * Fast（omp `/fast`）的会话级开关（2026-10-20 用户口径）：
 * - 界面只有一个闪电图标（没有 Fast 文案、没有菜单、没有 Ultra 提示）；
 * - 点击开 / 关 priority，开启时图标变黄；
 * - 模型拒绝时 omp 原文在图标上方就地显示；下一次点击先清掉错误；
 * - Ultra（`/fast ultra`）只有终端 / TUI，rpc-ui 没有通道，界面不展示。
 */

vi.mock("@shared/api", () => ({
 api: {
  setFastMode: vi.fn(async (_id: string, enabled: boolean) => ({ enabled, active: enabled })),
 },
}));

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
 vi.clearAllMocks();
 useApp.setState({
  activeSessionId: "s1",
  currentModel: "demo/model",
  currentRuntime: {
   model: { provider: "demo", id: "model", name: "Model" },
   efforts: null,
   thinkingLevel: null,
   fastModeEnabled: false,
   fastModeActive: false,
   fastModeSupported: true,
  },
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

/** 组件里只有这一个 toggle 按钮（`aria-pressed` 是它的状态口）。 */
const trigger = () => container.querySelector<HTMLButtonElement>("button[aria-pressed]");

const render = () => {
 act(() => {
  root.render(<FastMenu />);
 });
};

describe("Fast 闪电开关", () => {
 it("只渲染闪电图标：没有 Fast 文案、菜单或 Ultra 提示", () => {
  render();
  const button = trigger()!;
  expect(button.textContent?.trim()).toBe("");
  expect(container.textContent).toBe("");
  expect(container.textContent).not.toContain("Ultra");
  expect(container.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')).toBeNull();
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(button.className).not.toContain("text-warn");
 });

 it("点击开启 priority：下发 set_fast_mode，回填状态，图标变黄；再点关闭", async () => {
  render();
  await act(async () => {
   trigger()!.click();
   await delay(0);
  });

  expect(vi.mocked(api.setFastMode)).toHaveBeenLastCalledWith("s1", true);
  expect(useApp.getState().currentRuntime?.fastModeEnabled).toBe(true);
  expect(useApp.getState().currentRuntime?.fastModeActive).toBe(true);
  expect(trigger()!.getAttribute("aria-pressed")).toBe("true");
  expect(trigger()!.className).toContain("text-warn");

  await act(async () => {
   trigger()!.click();
   await delay(0);
  });

  expect(vi.mocked(api.setFastMode)).toHaveBeenLastCalledWith("s1", false);
  expect(useApp.getState().currentRuntime?.fastModeEnabled).toBe(false);
  expect(useApp.getState().currentRuntime?.fastModeActive).toBe(false);
  expect(trigger()!.getAttribute("aria-pressed")).toBe("false");
  expect(trigger()!.className).not.toContain("text-warn");
 });

 it("模型拒绝时显示 omp 原文；下一次点击先清掉错误", async () => {
  vi.mocked(api.setFastMode).mockRejectedValueOnce(
   new Error("Fast mode is unavailable for the current model."),
  );
  render();
  await act(async () => {
   trigger()!.click();
   await delay(0);
  });

  expect(container.textContent).toContain("Fast mode is unavailable for the current model.");
  expect(trigger()!.getAttribute("aria-pressed")).toBe("false");
  // 不是「一次失败就永久禁用」：允许用户再点一次重试
  expect(trigger()!.disabled).toBe(false);

  await act(async () => {
   trigger()!.click();
   await delay(0);
  });
  expect(container.textContent).not.toContain("Fast mode is unavailable");
  expect(vi.mocked(api.setFastMode)).toHaveBeenLastCalledWith("s1", true);
 });

 it("enabled 但 active=false：仍显示黄色，并在提示里说明未实际启用", () => {
  useApp.setState((s) => ({
   currentRuntime: s.currentRuntime
    ? { ...s.currentRuntime, fastModeEnabled: true, fastModeActive: false }
    : s.currentRuntime,
  }));
  render();
  expect(trigger()!.className).toContain("text-warn");
  expect(trigger()!.getAttribute("title")).toContain("未实际启用");
 });

 it("选择模型时先隐藏旧支持态，等 runtime 跟上再按新模型判定", () => {
  render();
  expect(trigger()).not.toBeNull();
  // 模型菜单乐观更新 currentModel，但旧 runtime 还没回来 → 先不显示
  act(() => useApp.setState({ currentModel: "demo/other" }));
  expect(trigger()).toBeNull();
  // 切回（或 set_model 失败回滚）→ 与 runtime.model 重新同源，恢复显示
  act(() => useApp.setState({ currentModel: "demo/model" }));
  expect(trigger()).not.toBeNull();
 });

 it("模型不支持时不显示闪电；切到支持模型才出现", () => {
  useApp.setState((s) => ({
   currentRuntime: s.currentRuntime
    ? { ...s.currentRuntime, fastModeSupported: false }
    : s.currentRuntime,
  }));
  render();
  expect(trigger()).toBeNull();
  expect(container.textContent).toBe("");

  act(() => {
   useApp.setState((s) => ({
    currentRuntime: s.currentRuntime
     ? { ...s.currentRuntime, fastModeSupported: true }
     : s.currentRuntime,
   }));
  });
  expect(trigger()).not.toBeNull();
 });
});
