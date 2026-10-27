// @vitest-environment jsdom
/**
 * git 只读查询 hook：cwd 变化重查；store 的 `gitInfoSeq` 自增（`commitTasks` 的
 * `refreshWorkspaceGitState`——git 状态的统一刷新入口）让已挂载的实例一起重读——
 * 这条链断了，切完分支输入卡 / 右栏会一直显示旧分支、提交完了脏点也一直亮着。
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitInfo } from "@shared/types";
import { useApp } from "../stores/app";

const { apiMock } = vi.hoisted(() => ({ apiMock: { getGitInfo: vi.fn(), getWorkspaceGitState: vi.fn() } }));
vi.mock("@shared/api", () => ({
 api: new Proxy(apiMock, { get: (t, k) => (k in t ? (t as Record<string, unknown>)[k as string] : async () => null) }),
}));

import { useGitInfo } from "./useGitInfo";
import { refreshWorkspaceGitState } from "./commitTasks";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const info = (branch: string): GitInfo => ({
 isRepo: true,
 branch,
 detached: false,
 branches: [branch],
 dirty: false,
 added: 0,
 removed: 0,
 error: null,
});

function Probe({ cwd }: { cwd: string }) {
 const { info } = useGitInfo(cwd);
 return createElement("div", null, info?.branch ?? "…");
}

/** 只关心脏点（输入卡顶行的分支圆点与右栏「变更」的脏点同源，都读 `get_git_info`）。 */
function DirtyProbe({ cwd }: { cwd: string }) {
 const { info } = useGitInfo(cwd);
 return createElement("div", null, info?.dirty ? "有未提交改动" : "干净");
}

describe("useGitInfo", () => {
 beforeEach(() => {
  vi.clearAllMocks();
  useApp.setState({ gitInfoSeq: 0 });
 });

 it("按 cwd 查询；gitInfoSeq 自增后重读并收敛到新值", async () => {
  apiMock.getGitInfo.mockResolvedValue(info("main"));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
   root.render(createElement(Probe, { cwd: "/w/alpha" }));
  });
  expect(apiMock.getGitInfo).toHaveBeenCalledWith("/w/alpha");
  expect(container.textContent).toBe("main");

  // 分支在壳外被切走：自增信号一到，已挂载实例必须重读
  apiMock.getGitInfo.mockResolvedValue(info("feature/x"));
  await act(async () => {
   useApp.setState((s) => ({ gitInfoSeq: s.gitInfoSeq + 1 }));
  });
  expect(apiMock.getGitInfo).toHaveBeenCalledTimes(2);
  expect(container.textContent).toBe("feature/x");

  // 空 cwd：不发起查询
  await act(async () => {
   root.render(createElement(Probe, { cwd: "" }));
  });
  expect(apiMock.getGitInfo).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
  container.remove();
 });

 it("工作区快照刷新（提交结束 / 轮询 / 焦点 / π 就绪）把 git 查询一起失效：提交后脏点灭", async () => {
  // 提交前：工作区有改动
  apiMock.getGitInfo.mockResolvedValue({ ...info("main"), dirty: true, added: 12, removed: 3 });
  apiMock.getWorkspaceGitState.mockResolvedValue([
   { path: "/w/alpha", isRepo: true, dirty: false, ahead: 0, behind: 0, upstream: "origin/main", upstreamGone: false },
  ]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
   root.render(createElement(DirtyProbe, { cwd: "/w/alpha" }));
  });
  expect(container.textContent).toBe("有未提交改动");

  // 提交 / 推送完成（本应用、终端、agent 任意一侧干的活）：行徽章那套快照的刷新
  // 必须把 `get_git_info` 一起失效——少了这一步，脏点与 `+X −Y` 会一直停在旧值
  apiMock.getGitInfo.mockResolvedValue(info("main"));
  await act(async () => {
   await refreshWorkspaceGitState(["/w/alpha"]);
  });
  expect(apiMock.getWorkspaceGitState).toHaveBeenCalledWith(["/w/alpha"]);
  expect(apiMock.getGitInfo).toHaveBeenCalledTimes(2);
  expect(container.textContent).toBe("干净");

  await act(async () => root.unmount());
  container.remove();
 });
});
