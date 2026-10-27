// @vitest-environment jsdom
/**
 * 「活干完就刷 git 快照」的接线（2026-10-17）：
 * 会话一轮收敛到 `idle` 时，**本会话目录**的工作区快照要跟着重读一次——
 * 提交键的改动状态（`workspaceGitStates[cwd]`）与左栏徽章都靠它，别等 30s 兜底轮询。
 *
 * 只刷本会话目录（这一轮不会改到别的目录，多项目下全量刷新是白跑），且经 2s 防抖合并。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "@shared/types";

const { apiMock, listeners } = vi.hoisted(() => ({
 apiMock: {
  getSessionRuntime: vi.fn(async () => null),
  getSubagents: vi.fn(async () => ({ subagents: [] })),
  getWorkspaceGitState: vi.fn(async () => []),
 },
 listeners: new Map<string, (e: { payload: unknown }) => void>(),
}));

vi.mock("@shared/api", () => ({ api: apiMock }));
vi.mock("@tauri-apps/api/event", () => ({
 listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
  listeners.set(event, handler);
  return () => listeners.delete(event);
 }),
}));

import { api } from "@shared/api";
import { IPC } from "@shared/ipc";
import { useApp } from "../stores/app";
import { useSessionEvents } from "./useSessionEvents";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const session = {
 id: "s1",
 projectId: null,
 title: "会话",
 cwd: "/w/alpha",
 timestamp: 0,
 archived: false,
 corrupt: false,
 note: null,
 running: false,
} as SessionView;

function Probe() {
 useSessionEvents();
 return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
 vi.clearAllMocks();
 listeners.clear();
 // 只假定时器：会话事件的流式缓冲用 rAF，真实现留着更贴近运行时
 vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
 useApp.setState({ activeSessionId: "s1", sessions: [session], eventsBySession: {}, statusBySession: {} });
 container = document.createElement("div");
 document.body.append(container);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
 vi.useRealTimers();
});

/** 挂载 hook 并等异步 `listen` 注册落地。 */
async function mount() {
 await act(async () => {
  root.render(createElement(Probe));
 });
}

/** 推一帧会话状态。 */
async function pushStatus(state: string) {
 await act(async () => {
  listeners.get(IPC.chatStatus("s1"))?.({ payload: { state } });
 });
}

describe("会话收敛到 idle：刷新本会话目录的 git 快照", () => {
 it("idle 帧防抖 2s 后按本会话 cwd 刷新", async () => {
  await mount();
  vi.mocked(api.getWorkspaceGitState).mockClear();
  await pushStatus("idle");
  expect(api.getWorkspaceGitState).not.toHaveBeenCalled();
  await act(async () => {
   vi.advanceTimersByTime(2000);
  });
  expect(api.getWorkspaceGitState).toHaveBeenCalledWith(["/w/alpha"]);
 });

 it("只认翻转：重复 idle 帧不再排队，两轮翻转也被防抖合并", async () => {
  await mount();
  vi.mocked(api.getWorkspaceGitState).mockClear();
  await pushStatus("idle");
  await pushStatus("idle");
  await pushStatus("idle");
  expect(api.getWorkspaceGitState).not.toHaveBeenCalled();
  await act(async () => {
   vi.advanceTimersByTime(2000);
  });
  expect(vi.mocked(api.getWorkspaceGitState).mock.calls.length).toBe(1);
  // 再跑一轮（running → idle）：2s 窗口内仍合并成一次
  vi.mocked(api.getWorkspaceGitState).mockClear();
  await pushStatus("running");
  await pushStatus("idle");
  await act(async () => {
   vi.advanceTimersByTime(2000);
  });
  expect(vi.mocked(api.getWorkspaceGitState).mock.calls.length).toBe(1);
 });

 it("运行中（running）不刷——活还没干完", async () => {
  await mount();
  vi.mocked(api.getWorkspaceGitState).mockClear();
  await pushStatus("running");
  await act(async () => {
   vi.advanceTimersByTime(2000);
  });
  expect(api.getWorkspaceGitState).not.toHaveBeenCalled();
 });
});
