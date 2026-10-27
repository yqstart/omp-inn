// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { CheckoutView, SessionView, ViewMsg } from "@shared/types";
import { api } from "@shared/api";
import { loadCheckouts, newChatInDefaultCheckout, resolveNewChatCheckout } from "./checkouts";
import { TEXT } from "./locale";
import { useApp } from "../stores/app";

vi.mock("@shared/api", () => ({
 api: {
  listCheckouts: vi.fn(async () => []),
  listWorkspaces: vi.fn(async () => []),
  createSession: vi.fn(async () => ({
   id: "new-1",
   projectId: "a",
   title: "未命名会话",
   cwd: "/a/main",
   timestamp: 1,
   archived: false,
   corrupt: false,
   note: null,
   running: false,
  })),
  openSession: vi.fn(async () => ({
   id: "new-1",
   projectId: "a",
   title: "未命名会话",
   cwd: "/a/main",
   timestamp: 1,
   archived: false,
   corrupt: false,
   note: null,
   running: false,
  })),
  getHistory: vi.fn(async () => ({ lines: [], truncated: false })),
 },
}));

const base: CheckoutView[] = [
 { projectId: "a", projectName: "Alpha", path: "/a/main", branch: "main", head: null, isMain: true, missing: false },
 { projectId: "a", projectName: "Alpha", path: "/a/login", branch: "login", head: null, isMain: false, missing: false },
 { projectId: "b", projectName: "Beta", path: "/b/main", branch: "main", head: null, isMain: true, missing: false },
 { projectId: "c", projectName: "Gamma", path: "/c/main", branch: "main", head: null, isMain: true, missing: true },
];

describe("新建聊天的目标选择（⌘T）", () => {
 it("第一个可用主目录；没有主目录退回第一个可用目录；全失效 / 空清单 → null", () => {
  expect(resolveNewChatCheckout(base)?.path).toBe("/a/main");
  // 只有 worktree（主目录缺失）→ 退回第一个可用目录
  expect(resolveNewChatCheckout([base[1]])?.path).toBe("/a/login");
  // 全部目录缺失 → 没有可开的目标
  expect(resolveNewChatCheckout(base.map((w) => ({ ...w, missing: true })))).toBeNull();
  expect(resolveNewChatCheckout([])).toBeNull();
 });
});

describe("新建会话（左栏主命令 / ⌘T）", () => {
 const session = (over: Partial<SessionView> = {}): SessionView => ({
  id: "s1",
  projectId: "a",
  title: "聊过的会话",
  cwd: "/a/main",
  timestamp: 1,
  archived: false,
  corrupt: false,
  note: null,
  running: false,
  ...over,
 });

 const USER_MSG: ViewMsg = { kind: "user", id: "u1", text: "你好", mentions: [] };

 /** 基线状态（各用例按需覆盖）：一个项目 + 一个已经聊过内容的当前会话。 */
 const baseState = {
  checkouts: base,
  locale: "zh-CN" as const,
  projects: [{ id: "a", path: "/a/main", name: "Alpha", missing: false, sessionCount: 1, workspaceId: null }],
  activeSessionId: "s1",
  sessions: [session()],
  eventsBySession: { s1: [USER_MSG] },
  drafts: {},
 };

 it("当前会话所在目录里已有对话 → 仍然新建（旧实现这里静默不做事）", async () => {
  useApp.setState(baseState);
  vi.mocked(api.createSession).mockClear();
  const res = await newChatInDefaultCheckout();
  expect(api.createSession).toHaveBeenCalledWith("/a/main");
  expect(res).toEqual({ ok: true, id: "new-1" });
 });

 it("目标 = 当前会话的目录（不是第一个项目）；没有当前会话时才退回第一个可用主目录", async () => {
  useApp.setState({ ...baseState, sessions: [session({ cwd: "/b/main" })], eventsBySession: { s1: [USER_MSG] } });
  vi.mocked(api.createSession).mockClear();
  await newChatInDefaultCheckout();
  expect(api.createSession).toHaveBeenCalledWith("/b/main");
  // 没有当前会话：退回第一个可用主目录（空态语义）
  useApp.setState({ ...baseState, activeSessionId: null, sessions: [], eventsBySession: {} });
  vi.mocked(api.createSession).mockClear();
  await newChatInDefaultCheckout();
  expect(api.createSession).toHaveBeenCalledWith("/a/main");
 });

 it("当前会话就是该目录里的空会话 → 复用，不叠第二个空的", async () => {
  useApp.setState({ ...baseState, sessions: [session({ title: "未命名会话" })], eventsBySession: {} });
  vi.mocked(api.createSession).mockClear();
  const res = await newChatInDefaultCheckout();
  expect(api.createSession).not.toHaveBeenCalled();
  expect(res).toEqual({ ok: true, id: "s1" });
 });

 it("空会话里已敲了草稿 → 不再当成空会话，照常新建", async () => {
  useApp.setState({
   ...baseState,
   sessions: [session({ title: "未命名会话" })],
   eventsBySession: {},
   drafts: { s1: "半句话" },
  });
  vi.mocked(api.createSession).mockClear();
  await newChatInDefaultCheckout();
  expect(api.createSession).toHaveBeenCalledWith("/a/main");
 });

 it("没有可用目录 → 带回文案（不静默、也不留一个点不动的按钮）", async () => {
  useApp.setState({
   ...baseState,
   checkouts: base.map((w) => ({ ...w, missing: true })),
   activeSessionId: null,
   sessions: [],
   eventsBySession: {},
  });
  vi.mocked(api.createSession).mockClear();
  const res = await newChatInDefaultCheckout();
  expect(res.ok).toBe(false);
  expect(res.ok === false && res.message).toBe(TEXT["zh-CN"].newChatNoProject);
  expect(api.createSession).not.toHaveBeenCalled();
 });
});

describe("清单刷新", () => {
 it("loadCheckouts：目录行与工作区清单一次落库", async () => {
  vi.mocked(api.listCheckouts).mockResolvedValue(base);
  vi.mocked(api.listWorkspaces).mockResolvedValue([{ id: "w1", name: "全栈", createdAt: 1, projectIds: ["a", "b"] }]);
  useApp.setState({ checkouts: [], workspaceGroups: [] });
  const list = await loadCheckouts();
  expect(list).toEqual(base);
  const s = useApp.getState();
  expect(s.checkouts).toEqual(base);
  expect(s.workspaceGroups.map((g) => g.id)).toEqual(["w1"]);
 });

 it("目录行失败：工作区清单照样落库（不塌成平铺），错误照旧抛给调用方", async () => {
  vi.mocked(api.listCheckouts).mockRejectedValue(new Error("git worktree 挂了"));
  vi.mocked(api.listWorkspaces).mockResolvedValue([{ id: "w1", name: "全栈", createdAt: 1, projectIds: ["a", "b"] }]);
  useApp.setState({ checkouts: [], workspaceGroups: [] });
  await expect(loadCheckouts()).rejects.toThrow("git worktree 挂了");
  expect(useApp.getState().workspaceGroups.map((g) => g.id)).toEqual(["w1"]);
 });

 it("工作区清单失败：目录行照样落库，旧的工作区清单不被清空", async () => {
  vi.mocked(api.listCheckouts).mockResolvedValue(base);
  vi.mocked(api.listWorkspaces).mockRejectedValue(new Error("overlay 忙"));
  useApp.setState({ checkouts: [], workspaceGroups: [{ id: "w9", name: "旧的", createdAt: 0, projectIds: [] }] });
  const list = await loadCheckouts();
  expect(list).toEqual(base);
  const s = useApp.getState();
  expect(s.checkouts).toEqual(base);
  expect(s.workspaceGroups.map((g) => g.id)).toEqual(["w9"]);
 });
});
