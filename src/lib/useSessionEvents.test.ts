import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BtwRecord, SessionRuntime, SessionStatus, SessionView, ViewMsg } from "@shared/types";

vi.mock("@shared/api", () => ({
 api: {
  getSessionRuntime: vi.fn(async () => null),
  setThinking: vi.fn(async () => undefined),
 },
}));

import { api } from "@shared/api";
import { useApp } from "../stores/app";
import { TEXT } from "./locale";
import { mergeViewMsgs, type IncomingViewMsg } from "./mergeEvents";
import { viewMsgsFromJsonlLines } from "./viewmsg";
import {
 __resetFolds,
 __resetHistoryLru,
 forgetSession,
 frameToViewMsgs,
 latestBtwTurn,
 syncSessionRuntime,
 todoPhasesOf,
 trimSessionHistories,
} from "./useSessionEvents";

/**
 * V34 内存治理的回归测试：非活跃会话的历史会被清掉（切回时重新 get_history 拉回），
 * 归档 / 删除时整个会话的前端缓存被清掉。防的是「浏览过的会话数据永远挂着」——
 * 每个长会话的全量消息（含工具全量输出）常驻内存，攒起来就是几百 MB 到 GB 级。
 *
 * 时序照真实路径走：打开一个会话（seed 历史）时 trim 一次——所以 seed 与 trim 交错。
 */

const msg = (id: string): ViewMsg => ({ kind: "text", id, seq: 0, text: id, complete: true });

/** 给会话塞一条历史（可选状态）。 */
function seed(sid: string, state?: SessionStatus["state"]) {
 useApp.setState((s) => ({
  eventsBySession: { ...s.eventsBySession, [sid]: [msg(sid)] },
  ...(state ? { statusBySession: { ...s.statusBySession, [sid]: { state } as SessionStatus } } : {}),
 }));
}

/** 模拟「打开一个会话」：先有历史，随后触发一次清理（useSessionEvents 订阅 effect 里的调用）。 */
function open(sid: string, state?: SessionStatus["state"]) {
 seed(sid, state);
 trimSessionHistories(sid);
}

beforeEach(() => {
 __resetHistoryLru();
 __resetFolds();
 useApp.setState({ eventsBySession: {}, statusBySession: {}, plansBySession: {}, planCardBySession: {}, planDismissedBySession: {}, attachmentsBySession: {}, queuedBySession: {} });
});

describe("trimSessionHistories：非活跃会话的历史只留最近 3 个", () => {
 it("第 4 个会话打开后，最早的历史被清掉", () => {
  open("s1");
  open("s2");
  open("s3");
  expect(Object.keys(useApp.getState().eventsBySession).sort()).toEqual(["s1", "s2", "s3"]);
  open("s4");
  // s1 超出保留窗口 → 被清；其余保留
  expect(Object.keys(useApp.getState().eventsBySession).sort()).toEqual(["s2", "s3", "s4"]);
 });

 it("同一会话反复激活不会重复占位（LRU 去重）", () => {
  open("s1");
  open("s2");
  open("s1");
  open("s3");
  // 最近三次激活 = s3 / s1 / s2 → 都在；没有第 4 个会话可清
  expect(Object.keys(useApp.getState().eventsBySession).sort()).toEqual(["s1", "s2", "s3"]);
 });

 it("正在跑 / 等审批的会话不清（流还在写，用户随时可能切回来看中间态）", () => {
  seed("run", "running");
  seed("wait", "awaiting-approval");
  for (const sid of ["a", "b", "c", "d"]) open(sid);
  const keys = Object.keys(useApp.getState().eventsBySession).sort();
  expect(keys).toEqual(["b", "c", "d", "run", "wait"]);
 });

 it("keepCount=1（切去终端形态）时只留当前会话", () => {
  open("s1");
  open("s2");
  open("s3");
  trimSessionHistories("s1", 1);
  expect(Object.keys(useApp.getState().eventsBySession)).toEqual(["s1"]);
 });
});

describe("forgetSession：归档 / 删除后清掉会话的前端缓存", () => {
 it("事件流 / 状态 / 计划 / 附件四类键一起清", () => {
  open("s1", "idle");
  useApp.setState({
   plansBySession: { s1: [] },
   attachmentsBySession: { s1: [] },
  });
  forgetSession("s1");
  const st = useApp.getState();
  expect("s1" in st.eventsBySession).toBe(false);
  expect("s1" in st.statusBySession).toBe(false);
  expect("s1" in st.plansBySession).toBe(false);
  expect("s1" in st.attachmentsBySession).toBe(false);
 });

 it("不存在的会话是 no-op（不炸、不影响其它会话）", () => {
  open("s2", "idle");
  expect(() => forgetSession("nope")).not.toThrow();
  expect(Object.keys(useApp.getState().eventsBySession)).toEqual(["s2"]);
 });
});

/**
 * 活动态真值回读（`SessionMeta.status`，只在 `get_session_runtime` 里带）：
 * 状态事件是推送，切走期间收不到——切回一个正在跑的会话要靠这次回读把「运行中」补回，
 * 否则胶囊显示成就绪、流式「思考中」指示不出现，输入框还会把下一句当新 prompt 发出去
 * （运行中应当走排队 / 转向，普通 prompt 会打断进行中的轮次）。
 */
describe("运行时回读：活动态真值补回状态表", () => {
 const runtime = (status: SessionRuntime["status"]): SessionRuntime => ({
  model: null,
  efforts: null,
  thinkingLevel: null,
  status,
 });

 it("status 落到 statusBySession（切走期间错过的状态帧靠它补）", async () => {
  useApp.setState({ activeSessionId: "s1", statusBySession: {} });
  vi.mocked(api.getSessionRuntime).mockResolvedValue(runtime("running"));
  await syncSessionRuntime("s1");
  expect(useApp.getState().statusBySession["s1"]?.state).toBe("running");
 });

 it("不在当前会话时回读结果不落（避免切走后被旧会话真值覆盖）", async () => {
  useApp.setState({ activeSessionId: "other", statusBySession: {} });
  vi.mocked(api.getSessionRuntime).mockResolvedValue(runtime("running"));
  await syncSessionRuntime("s1");
  expect("s1" in useApp.getState().statusBySession).toBe(false);
 });

 it("载荷没带 status 时不动状态表（事件推送不背这个字段）", async () => {
  useApp.setState({ activeSessionId: "s1", statusBySession: { s1: { state: "idle" } } });
  vi.mocked(api.getSessionRuntime).mockResolvedValue(runtime(null));
  await syncSessionRuntime("s1");
  expect(useApp.getState().statusBySession["s1"]?.state).toBe("idle");
 });
});

/**
 * 队列真值回读（V40）：`get_state.queuedMessages` 落在 store——
 * `queue_update` 帧是实时权威，回读负责把「切走期间错过的变化」补回。
 */
describe("队列真值回读（V40）", () => {
 const rt = (over: Partial<SessionRuntime> = {}): SessionRuntime => ({
  model: null,
  efforts: null,
  thinkingLevel: null,
  ...over,
 });

 it("queuedMessages 落 queuedBySession（缺省字段不动）", async () => {
  useApp.setState({ activeSessionId: "s1", queuedBySession: {} });
  vi.mocked(api.getSessionRuntime).mockResolvedValue(
   rt({ queuedMessages: { steering: ["插话一"], followUp: ["排队二", "排队三"] } }),
  );
  await syncSessionRuntime("s1");
  expect(useApp.getState().queuedOf("s1")).toEqual({ steering: ["插话一"], followUp: ["排队二", "排队三"] });
  // 不带 queuedMessages 的回读不动已落库的快照
  vi.mocked(api.getSessionRuntime).mockResolvedValue(rt({}));
  await syncSessionRuntime("s1");
  expect(useApp.getState().queuedOf("s1").followUp).toHaveLength(2);
 });

 it("forgetSession 一并清掉队列与任务清单状态（含完成清单的收起签名）", () => {
  open("s1", "idle");
  useApp.setState({
   queuedBySession: { s1: { steering: ["a"], followUp: [] } },
   plansBySession: { s1: [{ name: "阶段", tasks: [{ content: "甲", status: "completed" }] }] },
   planCardBySession: { s1: "collapsed" },
   planDismissedBySession: { s1: "[]" },
  });
  forgetSession("s1");
  const st = useApp.getState();
  expect("s1" in st.queuedBySession).toBe(false);
  expect("s1" in st.plansBySession).toBe(false);
  expect("s1" in st.planCardBySession).toBe(false);
  expect("s1" in st.planDismissedBySession).toBe(false);
 });

 it("latestBtwTurn：有 followUps 取最后一项，否则话题本身", () => {
  const rec: BtwRecord = { id: "b1", question: "q", answer: "a", status: "complete", createdAt: 0, updatedAt: 0, leafId: null };
  expect(latestBtwTurn(rec).answer).toBe("a");
  expect(
   latestBtwTurn({
    ...rec,
    followUps: [
     { question: "q2", answer: "a2", status: "complete", createdAt: 0, updatedAt: 0 },
     { question: "q3", answer: "a3", status: "running", createdAt: 0, updatedAt: 0 },
    ],
   }).status,
  ).toBe("running");
 });
});

/**
 * 标题帧（V44）：omp 原生命令改标题后 rpc-ui 推 `session_info_update`（壳侧自动补标题走
 * 无参数 `/rename`，实测 18.10.3 就发这个帧）；`title_change` 是 jsonl 侧的老形状，一并消费。
 * 备注（note）非空的会话不许被实时标题顶掉显示（与后端 display_title 同口径）。
 */
describe("标题帧落 store（session_info_update / title_change）", () => {
 const row = (id: string, over: Partial<SessionView> = {}): SessionView => ({
  id,
  projectId: "p1",
  title: "未命名会话 10-13",
  cwd: "/a",
  timestamp: 1,
  archived: false,
  corrupt: false,
  note: null,
  running: true,
  ...over,
 });

 it("session_info_update 把标题写进该会话行、不动别行", () => {
  useApp.setState({ sessions: [row("s1"), row("s2")] });
  frameToViewMsgs("s1", { type: "session_info_update", title: "修复会话标题未命名", sessionId: "s1" }, TEXT["zh-CN"]);
  const st = useApp.getState();
  expect(st.sessions.find((s) => s.id === "s1")?.title).toBe("修复会话标题未命名");
  expect(st.sessions.find((s) => s.id === "s2")?.title).toBe("未命名会话 10-13");
 });

 it("备注非空时不覆盖显示；空标题帧忽略", () => {
  useApp.setState({ sessions: [row("s1", { note: "我的备注" })] });
  frameToViewMsgs("s1", { type: "session_info_update", title: "omp 标题", sessionId: "s1" }, TEXT["zh-CN"]);
  expect(useApp.getState().sessions[0]?.title).toBe("未命名会话 10-13");
  frameToViewMsgs("s1", { type: "session_info_update", title: "   ", sessionId: "s1" }, TEXT["zh-CN"]);
  expect(useApp.getState().sessions[0]?.title).toBe("未命名会话 10-13");
 });

 it("title_change（历史形状）同口径消费", () => {
  useApp.setState({ sessions: [row("s1")] });
  frameToViewMsgs("s1", { type: "title_change", title: "TUI 侧改的名" }, TEXT["zh-CN"]);
  expect(useApp.getState().sessions[0]?.title).toBe("TUI 侧改的名");
 });
});

/**
 * omp 的规则提醒（`role=developer` 的 TTSR system-reminder）：
 * 实时帧只落一条提醒分隔行，绝不进正文（与历史回放同口径）。
 */
describe("规则提醒帧（developer）", () => {
 it("message_start(developer) → reminder 分隔行，无正文行", () => {
  const out = frameToViewMsgs(
   "s1",
   {
    type: "message_start",
    message: {
     role: "developer",
     content: [
      {
       type: "text",
       text: '<system-reminder reason="rule_violation" rule="ts-no-tiny-functions">…</system-reminder>',
      },
     ],
    },
   },
   TEXT["zh-CN"],
  );
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({
   kind: "divider",
   divider: "reminder",
   text: expect.stringContaining("ts-no-tiny-functions"),
  });
 });

 it("message_end(developer) 不落任何行", () => {
  const out = frameToViewMsgs(
   "s1",
   { type: "message_end", message: { role: "developer", content: [{ type: "text", text: "x" }] } },
   TEXT["zh-CN"],
  );
  expect(out).toEqual([]);
 });
});

/**
 * 流式帧的收敛与 id 口径（V46）：
 * - `text_end` 是 omp 每条文本块的完结信号（`content` = 全文，18.10.3 实测）——不消费它，
 *   这一行永远 `complete:false`：流式光标一直挂在已写完的段落上、「思考中…」指示行不再出现；
 * - 实时行 id = `${sid}:${msgSeq}:${contentIndex}`：contentIndex 在**每条新消息里从 0 重数**，
 *   只用 `contentIndex` 会让第二轮的文本块与第一轮撞同一个 id（React 重复 key、合并找错行）；
 * - 工具占位卡从第一帧起就带真名与参数预览（omp `toolcall_start` 的 `partial`）。
 * 走 `frameToViewMsgs → mergeViewMsgs` 的真实两步管线（与订阅回调一致）。
 */
describe("流式帧：text_end / 消息内 id / 工具占位卡（V46）", () => {
 const F = (assistantMessageEvent: Record<string, unknown>) => ({ type: "message_update", assistantMessageEvent });
 const startMsg = (role: string) => ({ type: "message_start", message: { role, content: [] } });
 /** 真实两步管线：帧 → ViewMsg → 合并进消息流。 */
 const feed = (events: ViewMsg[], frames: Record<string, unknown>[]): ViewMsg[] => {
  let out = events;
  for (const f of frames) out = mergeViewMsgs(out, frameToViewMsgs("s1", f, TEXT["zh-CN"]) as IncomingViewMsg[]);
  return out;
 };

 it("text_end 落定该文本行，message_end 不再追加第二行", () => {
  let events = feed([], [
   startMsg("assistant"),
   F({ type: "text_start", contentIndex: 0 }),
   F({ type: "text_delta", contentIndex: 0, delta: "半句" }),
   F({ type: "text_end", contentIndex: 0, content: "半句完了" }),
  ]);
  expect(events.filter((m) => m.kind === "text")).toMatchObject([{ text: "半句完了", complete: true }]);
  // message_end 携带全文再推一次：同 id 更新，不产生第二行
  events = feed(events, [
   { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "半句完了" }] } },
  ]);
  expect(events.filter((m) => m.kind === "text")).toHaveLength(1);
  expect(events.filter((m) => m.kind === "text")[0]).toMatchObject({ complete: true, text: "半句完了" });
 });
 it("迟到的增量帧不许把写完的文本行重开成流式态", () => {
  let events = feed([], [
   startMsg("assistant"),
   F({ type: "text_start", contentIndex: 0 }),
   F({ type: "text_delta", contentIndex: 0, delta: "完" }),
   F({ type: "text_end", contentIndex: 0, content: "完" }),
  ]);
  events = feed(events, [F({ type: "text_delta", contentIndex: 0, delta: "（迟到）" })]);
  expect(events.filter((m) => m.kind === "text")).toHaveLength(1);
  expect(events.filter((m) => m.kind === "text")[0]).toMatchObject({ complete: true, text: "完" });
 });

 it("两轮 assistant 消息的 contentIndex 都从 0 起：id 不撞车（否则 React 重复 key）", () => {
  const events = feed([], [
   startMsg("assistant"),
   F({ type: "text_start", contentIndex: 0 }),
   F({ type: "text_end", contentIndex: 0, content: "第一轮" }),
   { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "第一轮" }] } },
   startMsg("assistant"),
   F({ type: "text_start", contentIndex: 0 }),
   F({ type: "text_delta", contentIndex: 0, delta: "第二轮" }),
  ]);
  const texts = events.filter((m) => m.kind === "text");
  expect(texts.map((m) => m.text)).toEqual(["第一轮", "第二轮"]);
  expect(new Set(texts.map((m) => m.id)).size).toBe(2);
 });

 it("工具占位卡从第一帧起带真名与参数预览；toolcall_end 合成同一张卡", () => {
  const partial = { content: [{ type: "thinking" }, { type: "toolCall", name: "bash", id: "tc9", arguments: {}, partialArgs: '{"command": "ls -la /tmp/omp-probe/work3", "i' }] };
  let events = feed([], [
   startMsg("assistant"),
   F({ type: "toolcall_start", contentIndex: 1, partial }),
   F({ type: "toolcall_delta", contentIndex: 1, delta: "{" }),
  ]);
  const streaming = events.filter((m) => m.kind === "tool");
  expect(streaming).toHaveLength(1);
  expect(streaming[0]).toMatchObject({ id: "tool:tc9", toolCallId: "tc9", name: "bash", state: "streaming" });
  expect(streaming[0]).toMatchObject({ argsSummary: "ls -la /tmp/omp-probe/work3" });
  // 参数拼完：toolcall_end 带完整参数 → 同一张卡变 running、摘要换完整版
  events = feed(events, [
   F({ type: "toolcall_end", contentIndex: 1, partial: { content: [null, { type: "toolCall", name: "bash", id: "tc9", arguments: { command: "ls -la /tmp/omp-probe/work3" } }] }, toolCall: { id: "tc9", name: "bash", arguments: { command: "ls -la /tmp/omp-probe/work3" }, streamIndex: 1 } }),
  ]);
  const cards = events.filter((m) => m.kind === "tool");
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ id: "tool:tc9", state: "running", argsSummary: "ls -la /tmp/omp-probe/work3" });
 });

 it("思考块只流过空白也要落定（不许永远停在「思考中…」）", () => {
  const events = feed([], [
   startMsg("assistant"),
   F({ type: "thinking_start", contentIndex: 0 }),
   F({ type: "thinking_delta", contentIndex: 0, delta: "\n" }),
   F({ type: "thinking_end", contentIndex: 0, content: "\n" }),
  ]);
  expect(events.filter((m) => m.kind === "thinking")).toMatchObject([{ complete: true }]);
 });
});

/**
 * 任务清单（V50）：todo 工具帧的 `details.phases` 是全量真值
 * （`tool_execution_end` 与 `message_end{toolResult}` 两路同形，omp 18.10.4 实测）；
 * `syncSessionRuntime` 的回读数组即覆盖——空数组 = 已清空（浮卡退场）。
 */
describe("任务清单：todo 帧解析与回读收敛", () => {
 const PHASES = [{ name: "默认阶段", tasks: [{ content: "甲", status: "in_progress" }] }];

 it("todoPhasesOf：两路帧同解，非 todo / 漂移形状返回 null", () => {
  expect(todoPhasesOf({ type: "tool_execution_end", toolName: "todo", result: { details: { phases: PHASES } } })).toEqual(PHASES);
  expect(
   todoPhasesOf({ type: "message_end", message: { role: "toolResult", toolName: "todo", details: { phases: PHASES } } }),
  ).toEqual(PHASES);
  expect(todoPhasesOf({ type: "tool_execution_end", toolName: "bash", result: { details: { phases: PHASES } } })).toBeNull();
  expect(todoPhasesOf({ type: "tool_execution_end", toolName: "todo", result: { details: { phases: "x" } } })).toBeNull();
  // 提醒帧（未完成项）不是清单源：真实形状 `{todos, attempt, maxAttempts}` 没有 phases
  expect(todoPhasesOf({ type: "todo_reminder", todos: [{ content: "甲" }], attempt: 1 })).toBeNull();
 });

 it("回读：数组即覆盖；空数组清空（数据与浮卡状态一起删）", async () => {
  useApp.setState({ activeSessionId: "s1", plansBySession: {}, planCardBySession: {} });
  vi.mocked(api.getSessionRuntime).mockResolvedValueOnce({ todoPhases: PHASES } as never);
  await syncSessionRuntime("s1");
  expect(useApp.getState().plansBySession["s1"]).toEqual(PHASES);
  // 首次出现默认收起（2026-10-21 用户口径）
  expect(useApp.getState().planCardBySession["s1"]).toBe("collapsed");
  vi.mocked(api.getSessionRuntime).mockResolvedValueOnce({ todoPhases: [] } as never);
  await syncSessionRuntime("s1");
  expect("s1" in useApp.getState().plansBySession).toBe(false);
  expect("s1" in useApp.getState().planCardBySession).toBe(false);
 });
});

/**
 * 发送时补的「附件顺序」注记只给模型看（2026-10-21 方案 A）：实时回显与历史回放都要剥掉，
 * 否则用户消息气泡里会多一行内部注记、乐观回显还会因为文本不同而渲染成两条。
 */
describe("附件顺序注记：展示层剥离", () => {
 const annotated = "如图#1，参考#2\n\n[omp image order: #1=image 1, #2=image 2]";

 it("历史回放：用户消息气泡显示原文", () => {
  const out = viewMsgsFromJsonlLines(
   [{ type: "message", message: { role: "user", content: [{ type: "text", text: annotated }] } }],
   TEXT["zh-CN"],
  );
  const user = out.find((m) => m.kind === "user");
  expect(user?.kind === "user" ? user.text : "").toBe("如图#1，参考#2");
 });

 it("实时回显：剥掉注记后与乐观回显同文本，合并成一条", () => {
  const out = mergeViewMsgs(
   [{ kind: "user", id: "u-local-1", text: "如图#1，参考#2", mentions: [] }] as IncomingViewMsg[],
   frameToViewMsgs(
    "s1",
    { type: "message_start", message: { role: "user", content: [{ type: "text", text: annotated }] } },
    TEXT["zh-CN"],
   ) as IncomingViewMsg[],
  );
  expect(out).toHaveLength(1);
  expect(out[0].kind === "user" ? out[0].text : "").toBe("如图#1，参考#2");
 });
});
