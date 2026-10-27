/**
 * 打开会话的**全链路回归**（mock IPC，不依赖 Tauri）：
 * `openSessionWithHistory` 把 get_history 的行落库为消息流、重复打开不叠、
 * 回放超限时在流尾落一条注记（且不重复落）。
 *
 * 这条链路此前没有测试覆盖——排查「打开已有会话不显示」问题时它是最先被怀疑的对象。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRuntime, SessionView } from "@shared/types";

const SID = "sess-open-1";

/** get_history 的形状（后端已过滤到 message/custom/title 系，包一层 {lines, truncated}）。 */
const HISTORY_LINES = [
 { type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "你好" }] } },
 {
  type: "message",
  id: "m2",
  message: {
   role: "assistant",
   content: [
    { type: "text", text: "我来跑一下" },
    { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" }, intent: "列出目录" },
   ],
  },
 },
 { type: "message", id: "m3", message: { role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text: "a.txt" }] } },
 { type: "title_change", id: "t1", title: "会话标题" },
];

vi.mock("@shared/api", () => ({
 api: {
  createSession: vi.fn(async (cwd: string) => ({
   id: "sess-new-1",
   projectId: "p1",
   title: "未命名会话",
   cwd,
   timestamp: 5,
   archived: false,
   corrupt: false,
   note: null,
   running: false,
  })),
  openSession: vi.fn(async (id: string) => ({
   id,
   projectId: "p1",
   title: "t",
   cwd: "/a",
   timestamp: 1,
   archived: false,
   corrupt: false,
   note: null,
   running: true,
  })),
  getSessionRuntime: vi.fn(async () => null),
  getHistory: vi.fn(async () => ({ lines: structuredClone(HISTORY_LINES), truncated: false })),
 },
}));

// node 环境没有 rAF：读底调用不需要真跑
(globalThis as Record<string, unknown>).requestAnimationFrame = () => 0;

import { api } from "@shared/api";
import { useApp } from "../stores/app";
import { TEXT } from "./locale";
import { createChatIn, fallbackTitleFromText, openSessionWithHistory, refreshTitleAfterFirstSend } from "./sessionOpen";

describe("打开会话：历史落库与去重", () => {
 beforeEach(() => {
  useApp.setState({ eventsBySession: {}, sessions: [], activeSessionId: null });
  vi.mocked(api.getHistory).mockResolvedValue({ lines: structuredClone(HISTORY_LINES), truncated: false });
 });

 it("历史落库（消息与工具痕迹都进流）", async () => {
  await openSessionWithHistory(SID);
  const kinds = (useApp.getState().eventsBySession[SID] ?? []).map((m) => m.kind);
  expect(kinds).toContain("user");
  expect(kinds).toContain("text");
  expect(kinds).toContain("tool");
 });

 it("重复打开同一会话不叠历史", async () => {
  await openSessionWithHistory(SID);
  const n1 = (useApp.getState().eventsBySession[SID] ?? []).length;
  await openSessionWithHistory(SID);
  expect(useApp.getState().eventsBySession[SID] ?? []).toHaveLength(n1);
 });

 it("truncated 时在流尾落一条注记，且重复打开不叠第二条", async () => {
  vi.mocked(api.getHistory).mockResolvedValue({ lines: structuredClone(HISTORY_LINES), truncated: true });
  await openSessionWithHistory(SID);
  expect((useApp.getState().eventsBySession[SID] ?? []).filter((m) => m.id === "hist-truncated")).toHaveLength(1);
  await openSessionWithHistory(SID);
  expect((useApp.getState().eventsBySession[SID] ?? []).filter((m) => m.id === "hist-truncated")).toHaveLength(1);
 });

 it("历史被内存治理清掉后，重新打开会从 jsonl 全量拉回（V34 历史 LRU）", async () => {
  await openSessionWithHistory(SID);
  const n1 = (useApp.getState().eventsBySession[SID] ?? []).length;
  expect(n1).toBeGreaterThan(0);
  // 模拟 `trimSessionHistories` 对这个会话的清理（非活跃会话超出 LRU 窗口）
  useApp.setState({ eventsBySession: {} });
  await openSessionWithHistory(SID);
  // 空基底重新全量落地——清掉只是省内存，不是丢数据
  expect(useApp.getState().eventsBySession[SID] ?? []).toHaveLength(n1);
 });

 it("实时流过的会话重新打开：正文 / 思考按同文本配对，不叠成两份", async () => {
  // 第一开：jsonl 里还没有这批内容（模拟流式开始之前）
  vi.mocked(api.getHistory).mockResolvedValueOnce({
   lines: [HISTORY_LINES[0]],
   truncated: false,
  });
  await openSessionWithHistory(SID);
  // 实时流：助手正文与思考行（id = 会话 + 消息序号 + contentIndex 的口径，见 useSessionEvents）
  useApp.getState().appendEvents(SID, [
   { kind: "text", id: `${SID}:1:0`, seq: 0, text: "实时流出来的正文", complete: true },
   { kind: "thinking", id: `${SID}:1:1`, text: "实时流出来的思考", seconds: 3, complete: true },
  ]);
  // 重开：jsonl 已有这批内容（实时行与历史行的 id 对不上，只靠配对兜）
  vi.mocked(api.getHistory).mockResolvedValue({
   lines: [
    HISTORY_LINES[0],
    { type: "message", id: "m9", message: { role: "assistant", content: [{ type: "text", text: "实时流出来的正文" }, { type: "thinking", thinking: "实时流出来的思考" }] } },
   ],
   truncated: false,
  });
  await openSessionWithHistory(SID);
  const rows = useApp.getState().eventsBySession[SID] ?? [];
  expect(rows.filter((m) => m.kind === "text")).toHaveLength(1);
  expect(rows.filter((m) => m.kind === "thinking")).toHaveLength(1);
  // 配对 = 用历史版替换实时版（id 换成 jsonl 行 id，稳定）
  expect(rows.filter((m) => m.kind === "text").map((m) => m.id)).toEqual(["t:m9:0"]);
  expect(rows.filter((m) => m.kind === "thinking").map((m) => m.id)).toEqual(["th:m9:1"]);
 });

 /**
  * 打开会话时的活动态：状态事件是推送，切走期间收不到——切回一个正在跑的会话，
  * 打开流程不许把状态压成 idle（那会让输入框把下一句当新 prompt 发出去 = 打断进行中的
  * 轮次，流式「思考中」指示也不会出现），并在 open 之后用运行时回读（`rt.status`）收敛真值。
  */
 describe("打开会话时的活动态真值", () => {
  const runtime = (status: SessionRuntime["status"]): SessionRuntime => ({
   model: null,
   efforts: null,
   thinkingLevel: null,
   status,
  });

  it("已有状态记录的会话不被压成 idle（running 保持）", async () => {
   useApp.setState({ statusBySession: { [SID]: { state: "running" } } });
   vi.mocked(api.getSessionRuntime).mockResolvedValue(null);
   await openSessionWithHistory(SID);
   expect(useApp.getState().statusBySession[SID]?.state).toBe("running");
  });

  it("没有记录的会话起手 idle，随后被运行时回读的 status 覆盖", async () => {
   useApp.setState({ statusBySession: {} });
   vi.mocked(api.getSessionRuntime).mockResolvedValue(runtime("running"));
   await openSessionWithHistory(SID);
   expect(useApp.getState().statusBySession[SID]?.state).toBe("running");
  });

  it("回读说 idle 时状态收敛回 idle（切走期间跑完的轮次不被当成仍在跑）", async () => {
   useApp.setState({ statusBySession: { [SID]: { state: "running" } } });
   vi.mocked(api.getSessionRuntime).mockResolvedValue(runtime("idle"));
   await openSessionWithHistory(SID);
   expect(useApp.getState().statusBySession[SID]?.state).toBe("idle");
  });
 });

 describe("已知视图（hint）：先落地再等 open", () => {
  /** 列表行：左栏 / 归档页点在手上的那一行。 */
  const ROW: SessionView = {
   id: SID,
   projectId: "p9",
   title: "列表里的标题",
   cwd: "/w/p9",
   timestamp: 7,
   archived: false,
   corrupt: false,
   note: null,
   running: false,
  };

  it("open 未返回时项目 / 目录 / 标题就已在（上下文条不再先显示「未归属」），返回后按真值收敛", async () => {
   // 项目目标为 ES2021，没有 Promise.withResolvers（同 ModelsPanel.test.tsx 的口径）
   let finish!: (value: SessionView) => void;
   vi.mocked(api.openSession).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
   const pending = openSessionWithHistory(SID, ROW);
   // 慢 open 期间（真实后端要 spawn + 握手 1–3s）：这一行已经在 store 里，项目名立刻可用
   expect(useApp.getState().sessions.find((s) => s.id === SID)).toMatchObject({
    projectId: "p9",
    cwd: "/w/p9",
    title: "列表里的标题",
   });
   finish({ ...ROW, projectId: "p1", cwd: "/a", running: true });
   await pending;
   const after = useApp.getState().sessions.find((s) => s.id === SID);
   // 后端说了算的字段（项目 / 目录 / running）收敛；标题留给 open / title_change / 首条回退那条线
   expect(after).toMatchObject({ projectId: "p1", cwd: "/a", running: true });
   expect(after?.title).toBe("列表里的标题");
  });

  it("慢 open 期间用户已切走：行照落，但不把选中抢回来、不抹掉那个会话的状态", async () => {
   // 项目目标为 ES2021，没有 Promise.withResolvers（同 ModelsPanel.test.tsx 的口径）
   let finish!: (value: SessionView) => void;
   vi.mocked(api.openSession).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
   const pending = openSessionWithHistory(SID, ROW);
   useApp.setState({ activeSessionId: "other", statusBySession: { [SID]: { state: "running" } } });
   finish({ ...ROW, running: true });
   await pending;
   const st = useApp.getState();
   expect(st.activeSessionId).toBe("other");
   expect(st.statusBySession[SID]?.state).toBe("running");
   expect(st.sessions.some((s) => s.id === SID)).toBe(true);
  });
 });

 describe("首条标题回退（rpc-ui 不产标题时的本地显示）", () => {
  it("取首条前 12 字（空白折叠，超长截断加省略号）", () => {
   expect(fallbackTitleFromText("  你好\n世界  ")).toBe("你好 世界");
   expect(fallbackTitleFromText("这是一个很长的需求描述要截断")).toBe("这是一个很长的需求描述要…");
   expect(fallbackTitleFromText("帮我把登录页重构一下")).toBe("帮我把登录页重构一下");
   expect(fallbackTitleFromText("   ")).toBeNull();
  });

  it("未命名会话：回退先顶上，回读无真值时保留回退", async () => {
   useApp.setState({
    sessions: [{ id: SID, projectId: "p1", title: "未命名会话 10-09", cwd: "/a", timestamp: 1, archived: false, corrupt: false, note: null, running: true }],
   });
   vi.mocked(api.openSession).mockResolvedValue({ id: SID, projectId: "p1", title: "未命名会话 10-09", archived: false } as never);
   await refreshTitleAfterFirstSend(SID, "帮我把登录页重构一下登录页重构一下");
   expect(useApp.getState().sessions.find((s) => s.id === SID)?.title).toBe("帮我把登录页重构一下登录…");
  });

  it("回读到真值时用真值覆盖回退", async () => {
   useApp.setState({
    sessions: [{ id: SID, projectId: "p1", title: "未命名会话 10-09", cwd: "/a", timestamp: 1, archived: false, corrupt: false, note: null, running: true }],
   });
   vi.mocked(api.openSession).mockResolvedValue({ id: SID, projectId: "p1", title: "登录页重构", archived: false } as never);
   await refreshTitleAfterFirstSend(SID, "帮我把登录页重构一下");
   expect(useApp.getState().sessions.find((s) => s.id === SID)?.title).toBe("登录页重构");
  });

  it("有备注 / 已有真标题的不碰", async () => {
   useApp.setState({
    sessions: [{ id: SID, projectId: "p1", title: "我的备注", cwd: "/a", timestamp: 1, archived: false, corrupt: false, note: "我的备注", running: true }],
   });
   vi.mocked(api.openSession).mockClear();
   await refreshTitleAfterFirstSend(SID, "新消息不该改标题");
   expect(useApp.getState().sessions.find((s) => s.id === SID)?.title).toBe("我的备注");
   expect(vi.mocked(api.openSession)).not.toHaveBeenCalled();
  });
 });
});

/**
 * 身份漂移（open-elsewhere 保护性 fork）：请求打开的会话已被其他进程持有，
 * omp 会把这次打开分到新副本（新 id）——壳全程以 opened.id 为准：
 * 激活切到真实身份、历史读真实身份、流尾追加一条说明行。
 */
describe("打开被别处持有的会话（身份漂移）", () => {
 const FORKED_ID = "sess-open-1-forked";

 const forkView = (id: string): SessionView => ({
  id,
  projectId: "p1",
  title: "PANEL: 修复上下文面板",
  cwd: "/a",
  timestamp: 2,
  archived: false,
  corrupt: false,
  note: null,
  running: false,
 });

 beforeEach(() => {
  useApp.setState({ eventsBySession: {}, sessions: [], activeSessionId: null, statusBySession: {} });
 });

 it("open 返回新身份：激活 / 历史 / 说明行都跟真实会话走", async () => {
  vi.mocked(api.openSession).mockResolvedValueOnce(forkView(FORKED_ID));
  await openSessionWithHistory(SID);
  const st = useApp.getState();
  // 激活切到真实身份（请求 id 只用于发起）
  expect(st.activeSessionId).toBe(FORKED_ID);
  // 历史按真实身份读
  expect(vi.mocked(api.getHistory)).toHaveBeenCalledWith(FORKED_ID);
  // 说明行落在真实会话的流尾（固定 id，重复打开不叠第二条）
  expect(st.eventsBySession[FORKED_ID]?.some((m) => m.id === "fork-note")).toBe(true);
  // 历史也落在真实身份下
  expect((st.eventsBySession[FORKED_ID] ?? []).some((m) => m.kind === "user")).toBe(true);
 });
});

/**
 * 新建会话的降级说明（用户实测的现场）：项目里留着 omp 已改名 / 删除的模型，
 * 后端清掉失效偏好、用默认档把会话建起来，并在回包里带回 `notice`。
 * 这里验的是前端那一半：**说明必须落到会话流里**（否则用户只看到「模型自己变了」）。
 */
describe("新建会话：参数被 omp 拒绝后的降级说明", () => {
 beforeEach(() => {
  useApp.setState({ eventsBySession: {}, sessions: [], activeSessionId: null, statusBySession: {}, locale: "zh-CN" });
  vi.mocked(api.getHistory).mockResolvedValue({ lines: [], truncated: false });
 });

 it("带回 notice 时在会话流尾追加一条本地说明", async () => {
  vi.mocked(api.createSession).mockResolvedValueOnce({
   id: "sess-new-1",
   projectId: "p1",
   title: "未命名会话",
   cwd: "/a",
   timestamp: 5,
   archived: false,
   corrupt: false,
   note: null,
   running: false,
   notice: { model: "ccproxy/deepseek/deepseek-v4.1-flash-fast", thinking: "max", fallbackModel: true, detail: "Model \"x\" not found" },
  });
  const res = await createChatIn("/a", { projectName: "omp-inn" });
  expect(res.ok).toBe(true);

  const notes = (useApp.getState().eventsBySession["sess-new-1"] ?? []).filter((m) => m.kind === "command");
  expect(notes).toHaveLength(1);
  const text = notes[0].kind === "command" ? notes[0].output : "";
  // 失效的模型与思考档都要点名（用户才知道是哪一项不成立）
  expect(text).toContain("ccproxy/deepseek/deepseek-v4.1-flash-fast");
  expect(text).toContain("max");
  expect(text).toContain("默认档");
 });

 it("没有 notice（正常新建）就不落说明行", async () => {
  await createChatIn("/a");
  expect((useApp.getState().eventsBySession["sess-new-1"] ?? []).filter((m) => m.kind === "command")).toHaveLength(0);
 });

 it("omp 连默认档都没起起来（fallbackModel=false）时如实带上 omp 原话，不甩锅给项目偏好", async () => {
  vi.mocked(api.createSession).mockResolvedValueOnce({
   id: "sess-new-1",
   projectId: "p1",
   title: "未命名会话",
   cwd: "/a",
   timestamp: 5,
   archived: false,
   corrupt: false,
   note: null,
   running: false,
   notice: { model: null, thinking: null, fallbackModel: false, detail: "No models available" },
  });
  await createChatIn("/a");
  const rows = (useApp.getState().eventsBySession["sess-new-1"] ?? []).filter((m) => m.kind === "command");
  const text = rows[0]?.kind === "command" ? rows[0].output : "";
  expect(text).toContain("No models available");
  expect(text).not.toContain("默认模型"); // 不是「模型被删」那一档
 });

 it("两次都失败：错误文案带出 omp 的真实原因（不再只说「进程意外退出」）", async () => {
  vi.mocked(api.createSession).mockRejectedValueOnce(new Error('omp 在就绪前退出（omp 输出：Model "x" not found）'));
  const res = await createChatIn("/a", { projectName: "omp-inn" });
  expect(res.ok).toBe(false);
  if (!res.ok) {
   expect(res.message).toContain("omp-inn");
   expect(res.message).toContain('Model "x" not found');
  }
 });

 it("失败文案的空原因分支兜底（后端没给 message 时用短文案）", async () => {
  vi.mocked(api.createSession).mockRejectedValueOnce("boom");
  const res = await createChatIn("/a", { projectName: "omp-inn" });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.message).toBe(TEXT["zh-CN"].createChatFailedInShort.replace("{0}", "omp-inn"));
 });
});
