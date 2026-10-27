// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeSet, CommitTaskView, WorkspaceGitState } from "@shared/types";
import { useApp } from "../../stores/app";
import { TEXT } from "../../lib/locale";

/**
 * 卡顶行「提交」键：点开提交浮层（与右栏「变更」同链路）；状态图标随 `commitTasks[cwd]`
 * 的 phase 走——运行中转圈、失败红点、其余为对勾。
 *
 * 改动状态随 `workspaceGitStates[cwd]`（与提交面板同源、含未跟踪文件）：干净且无待推送
 * → 置灰禁用；有改动 → 键尾 warn 圆点；干净但有待推送 → 照旧可点；快照未知 → 不置灰。
 */
const { apiMock } = vi.hoisted(() => ({
 apiMock: {
  getChangeSet: vi.fn(
   async (): Promise<ChangeSet> => ({
    isRepo: true,
    branch: "main",
    head: null,
    upstream: null,
    upstreamGone: false,
    ahead: 0,
    behind: 0,
    files: [],
   }),
  ),
 },
}));
vi.mock("@shared/api", () => ({
 api: new Proxy(apiMock, { get: (t, k) => (k in t ? (t as Record<string, unknown>)[k as string] : async () => null) }),
}));

import { CommitButton } from "./CommitButton";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const zh = TEXT["zh-CN"];

function task(phase: CommitTaskView["phase"]): CommitTaskView {
 return {
  cwd: "/w/alpha",
  mode: "fast",
  phase,
  files: [],
  selected: [],
  message: "",
  generated: false,
  log: [],
  commits: [],
  error: null,
  hint: null,
  startedAt: 0,
 };
}

let container: HTMLDivElement;
let root: Root;

/** 工作区快照：默认「有改动、无待推送」——多数用例只改自己关心的那一项。 */
function ws(patch: Partial<WorkspaceGitState> = {}): WorkspaceGitState {
 return {
  path: "/w/alpha",
  isRepo: true,
  dirty: true,
  ahead: 0,
  behind: 0,
  upstream: null,
  upstreamGone: false,
  ...patch,
 };
}

beforeEach(() => {
 vi.clearAllMocks();
 useApp.setState({ locale: "zh-CN", commitTasks: {}, activeCommitCwd: null, workspaceGitStates: {} });
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
  root.render(<CommitButton cwd="/w/alpha" />);
 });
}

describe("CommitButton", () => {
 it("默认对勾 + 「提交」；点开提交浮层（落任务并聚焦该 cwd）", async () => {
  render();
  expect(container.textContent).toContain(zh.gitCommitTitle);
  expect(container.querySelector(".animate-spin")).toBeNull();
  expect(container.querySelector(".bg-danger")).toBeNull();
  await act(async () => {
   container.querySelector("button")?.click();
  });
  expect(useApp.getState().activeCommitCwd).toBe("/w/alpha");
  expect(useApp.getState().commitTasks["/w/alpha"]).toBeTruthy();
 });

 it("运行中显示转圈，失败显示红点", () => {
  useApp.setState({ commitTasks: { "/w/alpha": task("committing") } });
  render();
  expect(container.querySelector(".animate-spin")).toBeTruthy();
  act(() => root.unmount());
  root = createRoot(container);
  useApp.setState({ commitTasks: { "/w/alpha": task("failed") } });
  render();
  expect(container.querySelector(".bg-danger")).toBeTruthy();
  expect(container.querySelector(".animate-spin")).toBeNull();
 });

 it("工作区干净且无待推送：置灰不可点，提示「没有可提交或推送的改动」", async () => {
  useApp.setState({ workspaceGitStates: { "/w/alpha": ws({ dirty: false }) } });
  render();
  const btn = container.querySelector("button");
  expect(btn?.disabled).toBe(true);
  expect(container.querySelector(".bg-warn")).toBeNull();
  expect(container.querySelector("[title]")?.getAttribute("title")).toBe(zh.gitCommitDisabledTitle);
  await act(async () => {
   btn?.click();
  });
  expect(useApp.getState().activeCommitCwd).toBeNull();
  expect(useApp.getState().commitTasks["/w/alpha"]).toBeUndefined();
 });

 it("有改动：键尾 warn 圆点、可点开浮层", () => {
  useApp.setState({ workspaceGitStates: { "/w/alpha": ws() } });
  render();
  expect(container.querySelector(".bg-warn")).toBeTruthy();
  expect(container.querySelector("button")?.disabled).toBe(false);
  expect(container.querySelector("[title]")?.getAttribute("title")).toBe(zh.gitDirtyTitle);
 });

 it("干净但有待推送：照旧可点（浮层里能推送）", () => {
  useApp.setState({ workspaceGitStates: { "/w/alpha": ws({ dirty: false, ahead: 2 }) } });
  render();
  expect(container.querySelector("button")?.disabled).toBe(false);
  expect(container.querySelector(".bg-warn")).toBeNull();
 });

 it("快照未知（还没回来）不置灰：不把真实改动挡在门外", () => {
  render();
  expect(container.querySelector("button")?.disabled).toBe(false);
 });

 it("失败态即使在干净工作区也可点（红点要能点开看错误）", () => {
  useApp.setState({
   commitTasks: { "/w/alpha": task("failed") },
   workspaceGitStates: { "/w/alpha": ws({ dirty: false }) },
  });
  render();
  expect(container.querySelector("button")?.disabled).toBe(false);
  expect(container.querySelector(".bg-danger")).toBeTruthy();
 });
});
