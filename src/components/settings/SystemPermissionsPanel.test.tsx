// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@shared/api";
import type { SystemPermissions } from "@shared/types";
import { useApp } from "../../stores/app";
import { SystemPermissionsPanel } from "./SystemPermissionsPanel";

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@shared/api", () => ({
 api: {
  getSystemPermissions: vi.fn(),
  openSystemPermission: vi.fn(),
 },
}));

const perms = (over: Partial<SystemPermissions> = {}): SystemPermissions => ({
 supported: true,
 diskAccess: false,
 accessibility: false,
 screenCapture: false,
 automation: false,
 ...over,
});

/** 冲掉 mock promise 链（首读挂在 setTimeout(0) 之后）。 */
const flush = async () => {
 await act(async () => {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  await Promise.resolve();
  await Promise.resolve();
 });
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
 useApp.setState({ locale: "zh-CN" });
 container = document.createElement("div");
 document.body.append(container);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
 vi.mocked(api.getSystemPermissions).mockReset();
 vi.mocked(api.openSystemPermission).mockReset();
});

describe("设置 › 系统授权", () => {
 it("未授权显示「去授权」，点击跳到对应系统设置面板", async () => {
  vi.mocked(api.getSystemPermissions).mockResolvedValue(perms());
  vi.mocked(api.openSystemPermission).mockResolvedValue(undefined);

  act(() => root.render(<SystemPermissionsPanel />));
  await flush();

  for (const label of ["完全磁盘访问权限", "辅助功能", "屏幕录制", "自动化"]) {
   expect(container.textContent).toContain(label);
  }
  const grant = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("去授权"));
  expect(grant).toBeTruthy();

  // 屏幕录制未授权时挂着「需重启」提示
  expect(container.textContent).toContain("屏幕录制授权后需要退出并重新打开本应用才会生效。");

  const button = container.querySelector<HTMLButtonElement>('[data-kind="screenCapture"] button');
  expect(button).toBeTruthy();
  act(() => button?.click());
  await flush();
  expect(api.openSystemPermission).toHaveBeenCalledWith("screenCapture");
 });

 it("全部授权时四行都是「已授权」，没有跳转按钮与重启提示", async () => {
  vi.mocked(api.getSystemPermissions).mockResolvedValue(
   perms({ diskAccess: true, accessibility: true, screenCapture: true, automation: true }),
  );

  act(() => root.render(<SystemPermissionsPanel />));
  await flush();

  expect(container.textContent?.match(/已授权/g)?.length).toBe(4);
  expect(container.textContent).not.toContain("去授权");
  expect(container.textContent).not.toContain("屏幕录制授权后需要退出并重新打开本应用才会生效。");
 });

 it("非 macOS 只显示一句「仅 macOS 可用」，不摆四条假读数", async () => {
  vi.mocked(api.getSystemPermissions).mockResolvedValue(perms({ supported: false }));

  act(() => root.render(<SystemPermissionsPanel />));
  await flush();

  expect(container.textContent).toContain("仅在 macOS 上可用");
  expect(container.textContent).not.toContain("完全磁盘访问权限");
 });
});
