// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApp } from "../../stores/app";
import { TEXT } from "../../lib/locale";
import { PullConflictDialog } from "./PullConflictDialog";

/**
 * 拉取冲突清单：冲突文件逐个打开（系统默认编辑器）、继续合并、放弃合并。
 * 壳里不解决冲突——这里只验证「把用户送到编辑器 + 合并态收尾」这两件事。
 */

const mock = vi.hoisted(() => ({
 continueMerge: vi.fn(async () => undefined),
 abortMerge: vi.fn(async () => undefined),
 getWorkspaceGitState: vi.fn(async () => []),
 openPath: vi.fn(async () => undefined),
}));
vi.mock("@shared/api", () => ({
 api: {
  continueMerge: mock.continueMerge,
  abortMerge: mock.abortMerge,
  getWorkspaceGitState: mock.getWorkspaceGitState,
 },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: mock.openPath }));

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

const CWD = "/w/alpha";
const CONFLICTS = ["/w/alpha/src/a.ts", "/w/alpha/src/b.ts"];

let container: HTMLDivElement;
let root: Root;

function render(): void {
 act(() => {
  root.render(<PullConflictDialog />);
 });
}

function buttonByText(text: string): HTMLButtonElement {
 const hit = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").trim() === text);
 if (!hit) throw new Error(`按钮不存在：${text}`);
 return hit;
}

beforeEach(() => {
 mock.continueMerge.mockReset();
 mock.continueMerge.mockResolvedValue(undefined);
 mock.abortMerge.mockReset();
 mock.abortMerge.mockResolvedValue(undefined);
 mock.getWorkspaceGitState.mockReset();
 mock.getWorkspaceGitState.mockResolvedValue([]);
 mock.openPath.mockReset();
 mock.openPath.mockResolvedValue(undefined);
 useApp.setState({
  locale: "zh-CN",
  pullConflictCwd: CWD,
  pullStates: { [CWD]: { phase: "conflict", conflicts: CONFLICTS, error: null } },
 });
 container = document.createElement("div");
 document.body.append(container);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
 useApp.setState({ pullConflictCwd: null, pullStates: {} });
});

describe("拉取冲突清单", () => {
 it("列出冲突文件（项目内显示相对路径）", () => {
  render();
  expect(container.textContent).toContain(TEXT["zh-CN"].gitPullConflictTitle);
  expect(container.textContent).toContain("src/a.ts");
  expect(container.textContent).toContain("src/b.ts");
 });

 it("点「打开」用系统默认程序打开绝对路径", async () => {
  render();
  const open = buttonByText(TEXT["zh-CN"].gitPullOpen);
  await act(async () => {
   open.click();
  });
  expect(mock.openPath).toHaveBeenCalledWith("/w/alpha/src/a.ts");
 });

 it("点「继续合并」→ 调 continue_merge 并收起浮层", async () => {
  render();
  await act(async () => {
   buttonByText(TEXT["zh-CN"].gitPullContinue).click();
  });
  expect(mock.continueMerge).toHaveBeenCalledWith(CWD);
  expect(useApp.getState().pullConflictCwd).toBeNull();
  expect(useApp.getState().pullStates[CWD]).toBeUndefined();
 });

 it("点「放弃合并」→ 调 abort_merge 并收起浮层", async () => {
  render();
  await act(async () => {
   buttonByText(TEXT["zh-CN"].gitPullAbort).click();
  });
  expect(mock.abortMerge).toHaveBeenCalledWith(CWD);
  expect(useApp.getState().pullConflictCwd).toBeNull();
 });

 it("继续合并失败：错误显示在浮层里，不关闭", async () => {
  mock.continueMerge.mockRejectedValueOnce(new Error("仍有未解决的冲突"));
  render();
  await act(async () => {
   buttonByText(TEXT["zh-CN"].gitPullContinue).click();
  });
  expect(container.textContent).toContain("仍有未解决的冲突");
  expect(useApp.getState().pullConflictCwd).toBe(CWD);
 });
});
