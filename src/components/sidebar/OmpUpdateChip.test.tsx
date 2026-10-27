// @vitest-environment jsdom
/**
 * 左栏 omp 版本处（V24 chip）的两种形态：
 *
 * - **识别不到 omp**：同一位置换成「安装 omp」——点击打开安装弹窗（走 omp 官方安装脚本），
 *   安装中显示「安装中…」；这样「没装 omp」不再是死路；
 * - **识别到 omp**：显示版本 chip，点击打开更新弹窗。
 *
 * 识别口径 = 启动时的 `getHealth`（`health.omp.ompPath`），这里直接投喂 store 的 health。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthInfo } from "@shared/types";

const { openOmpUpdateDialog } = vi.hoisted(() => ({ openOmpUpdateDialog: vi.fn() }));
vi.mock("../../lib/ompUpdate", () => ({ openOmpUpdateDialog }));

import { useApp } from "../../stores/app";
import { TEXT } from "../../lib/locale";
import { OmpUpdateChip } from "./OmpUpdateChip";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const zh = TEXT["zh-CN"];

function health(ompPath: string | null, version: string | null = null): HealthInfo {
 return {
  omp: { ompPath, ompVersion: version, agentDir: "", errors: [] },
  modelsError: null,
  ok: Boolean(ompPath),
 };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
 container = document.createElement("div");
 document.body.appendChild(container);
 root = createRoot(container);
 useApp.setState({
  locale: "zh-CN",
  health: null,
  ompUpdate: { status: "idle", current: null, latest: null, channel: null, message: null, checkedAt: null },
  ompUpdateRun: null,
  ompInstallRun: null,
  ompInstallDialogOpen: false,
 });
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
 openOmpUpdateDialog.mockClear();
});

const render = () =>
 act(async () => {
  root.render(createElement(OmpUpdateChip));
 });

const click = async (el: Element | null) => {
 expect(el).not.toBeNull();
 await act(async () => {
  el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
 });
};

describe("左栏 omp 版本处", () => {
 it("识别不到 omp 时显示「安装 omp」，点击打开安装弹窗", async () => {
  useApp.setState({ health: health(null) });
  await render();
  const chip = container.querySelector("button");
  expect(chip?.textContent).toContain(zh.ompInstallChipLabel);
  await click(chip);
  expect(useApp.getState().ompInstallDialogOpen).toBe(true);
  // 不是更新入口：没有 omp 时不该打开「更新」弹窗
  expect(openOmpUpdateDialog).not.toHaveBeenCalled();
 });

 it("安装进行中显示「安装中…」", async () => {
  useApp.setState({
   health: health(null),
   ompInstallRun: { phase: "running", lines: [], from: null, to: null, error: null, startedAt: Date.now() },
  });
  await render();
  expect(container.querySelector("button")?.textContent).toContain(zh.ompInstallChipRunning);
 });

 it("识别到 omp 时显示版本，点击打开更新弹窗", async () => {
  useApp.setState({ health: health("/opt/homebrew/bin/omp", "18.12.2") });
  await render();
  const chip = container.querySelector("button");
  expect(chip?.textContent).toContain("18.12.2");
  expect(chip?.textContent).not.toContain(zh.ompInstallChipLabel);
  await click(chip);
  expect(openOmpUpdateDialog).toHaveBeenCalledTimes(1);
  expect(useApp.getState().ompInstallDialogOpen).toBe(false);
 });

 it("health 还没回来时不渲染（不闪「安装 omp」）", async () => {
  useApp.setState({ health: null });
  await render();
  expect(container.querySelector("button")).toBeNull();
 });
});
