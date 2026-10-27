// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitInfo } from "@shared/types";
import { useApp } from "../../stores/app";
import { TEXT } from "../../lib/locale";

/**
 * 输入卡顶行分支指示器：点分支即切（`api.switchBranch`）——成功收起浮层，并走
 * `refreshWorkspaceGitState([cwd])`（git 状态的统一刷新入口：它自增 `gitInfoSeq`
 * 让输入卡与右栏的查询一起重读，并刷新 ahead / behind 快照）；失败把 git 原文
 * 就地显示、浮层保持打开、不触发全局刷新；点当前分支只收浮层，不发写命令。
 */
const { apiMock } = vi.hoisted(() => ({
 apiMock: { switchBranch: vi.fn(async () => undefined) },
}));
vi.mock("@shared/api", () => ({
 api: new Proxy(apiMock, { get: (t, k) => (k in t ? (t as Record<string, unknown>)[k as string] : async () => null) }),
}));

import { BranchPicker } from "./BranchPicker";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const zh = TEXT["zh-CN"];
const git: GitInfo = {
 isRepo: true,
 branch: "main",
 detached: false,
 branches: ["main", "feature/x"],
 dirty: false,
 added: 0,
 removed: 0,
 error: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
 vi.clearAllMocks();
 useApp.setState({ locale: "zh-CN", composerMenu: null, gitInfoSeq: 0 });
 container = document.createElement("div");
 document.body.append(container);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
});

function render() {
 act(() => {
  root.render(<BranchPicker git={git} cwd="/w/alpha" loading={false} onReload={() => undefined} />);
 });
}

/** 点开浮层（收起态那个按钮）。 */
function openMenu() {
 const trigger = container.querySelector("button");
 act(() => {
  trigger?.click();
 });
}

/** 浮层里的分支行钮（按 aria-label 找非当前项；当前项没有 label，用文本找）。 */
function branchRow(branch: string): HTMLButtonElement | undefined {
 return (
  (container.querySelector(`[aria-label="${zh.switchToBranchAria.replace("{0}", branch)}"]`) as HTMLButtonElement | null) ??
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === branch)
 );
}

describe("BranchPicker", () => {
 it("点非当前分支：调 switch_branch，成功后收起浮层并自增 gitInfoSeq", async () => {
  render();
  openMenu();
  expect(container.textContent).toContain(zh.localBranches);
  await act(async () => {
   branchRow("feature/x")?.click();
  });
  expect(apiMock.switchBranch).toHaveBeenCalledWith("/w/alpha", "feature/x");
  expect(useApp.getState().composerMenu).toBeNull();
  expect(useApp.getState().gitInfoSeq).toBe(1);
 });

 it("切换失败：git 原文就地显示（role=alert），浮层保持打开、不触发全局刷新", async () => {
  apiMock.switchBranch.mockRejectedValueOnce(
   new Error("error: Your local changes to the following files would be overwritten by checkout:\n\tfoo.txt\nAborting"),
  );
  render();
  openMenu();
  await act(async () => {
   branchRow("feature/x")?.click();
  });
  const alert = container.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("Your local changes");
  expect(alert?.textContent).toContain("Aborting");
  expect(useApp.getState().composerMenu).toBe("branch");
  expect(useApp.getState().gitInfoSeq).toBe(0);
 });

 it("点当前分支：只收起浮层，不发写命令", async () => {
  render();
  openMenu();
  act(() => {
   branchRow("main")?.click();
  });
  expect(apiMock.switchBranch).not.toHaveBeenCalled();
  expect(useApp.getState().composerMenu).toBeNull();
 });
});
