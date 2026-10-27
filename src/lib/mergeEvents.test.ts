import { beforeEach, describe, expect, it } from "vitest";
import type { ViewMsg } from "@shared/types";
import { coalesceStream, createStreamBuffer, mergeViewMsgs, type IncomingViewMsg } from "./mergeEvents";
import { __resetFolds, frameToViewMsgs } from "./useSessionEvents";
import { useApp } from "../stores/app";
import { TEXT } from "./locale";

const zh = TEXT["zh-CN"];

/**
 * 回归测试：一次工具调用在 RPC 流里分多个阶段到达，必须始终合并成**一张**卡。
 * 这正是 review 发现的问题——旧实现按阶段无脑追加，导致「输入中」那张卡永远转圈，
 * 且 `toolcall_delta` 与 `toolcall_end` 复用同一 id 会触发 React 重复 key 警告。
 */

const SID = "sess-1";

/** 按真实线序回放一批帧，返回累积后的消息流。 */
function replay(frames: Record<string, unknown>[]): ViewMsg[] {
 let msgs: ViewMsg[] = [];
 for (const f of frames) {
  msgs = mergeViewMsgs(msgs, frameToViewMsgs(SID, f, zh) as IncomingViewMsg[]);
 }
 return msgs;
}

const toolFrames = (): Record<string, unknown>[] => [
 // 1) 参数流式拼片（只有 contentIndex，没有 toolCallId）
 { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 } },
 {
  type: "message_update",
  assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"command":"echo hi"}' },
 },
 // 2) 调用结束：参数与意图齐了，toolCallId 出现
 {
  type: "message_update",
  assistantMessageEvent: {
   type: "toolcall_end",
   contentIndex: 1,
   toolCall: {
    id: "call_abc",
    name: "bash",
    arguments: { command: "echo hi" },
    streamIndex: 1,
    intent: "打印 hi",
   },
  },
 },
 // 3) 开始执行
 { type: "tool_execution_start", toolCallId: "call_abc", toolName: "bash", args: { command: "echo hi" }, intent: "打印 hi" },
 // 4) 执行结束
 { type: "tool_execution_end", toolCallId: "call_abc", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "hi" }] } },
 // 5) 落盘态的 toolResult 回放（同一次调用）
 { type: "message_end", message: { role: "toolResult", toolCallId: "call_abc", toolName: "bash", content: [{ type: "text", text: "hi" }] } },
];

describe("实时流合并：工具卡", () => {
 beforeEach(() => __resetFolds());

 it("一次工具调用从输入中到成功只出一张卡", () => {
  const msgs = replay(toolFrames());
  const tools = msgs.filter((m) => m.kind === "tool");
  expect(tools).toHaveLength(1);
  const [card] = tools as Extract<ViewMsg, { kind: "tool" }>[];
  expect(card.state).toBe("ok");
  expect(card.toolCallId).toBe("call_abc");
  expect(card.name).toBe("bash");
 });

 it("终态卡保留早期事件里的参数摘要与意图（不许被空字段覆盖）", () => {
  const msgs = replay(toolFrames());
  const card = msgs.find((m) => m.kind === "tool") as Extract<ViewMsg, { kind: "tool" }>;
  expect(card.argsSummary).toBe("echo hi");
  expect(card.intent).toBe("打印 hi");
  expect(card.output).toBe("hi");
 });

 it("行数增量从调用帧继承到终态（结果帧没有参数，不许把 +N −M 抹掉）", () => {
  const msgs = replay([
   {
    type: "message_update",
    assistantMessageEvent: {
     type: "toolcall_end",
     contentIndex: 0,
     toolCall: {
      id: "call_edit",
      name: "edit",
      arguments: { path: "a.ts", old_string: "a\nb", new_string: "a\nb\nc" },
      streamIndex: 0,
     },
    },
   },
   {
    type: "tool_execution_start",
    toolCallId: "call_edit",
    toolName: "edit",
    args: { path: "a.ts", old_string: "a\nb", new_string: "a\nb\nc" },
   },
   {
    type: "tool_execution_end",
    toolCallId: "call_edit",
    toolName: "edit",
    isError: false,
    result: { content: [{ type: "text", text: "ok" }] },
   },
  ]);
  const card = msgs.find((m) => m.kind === "tool") as Extract<ViewMsg, { kind: "tool" }>;
  expect(card.state).toBe("ok");
  expect(card.diffStat).toEqual({ added: 3, removed: 2 });
 });

 it("中间阶段只有一张卡：toolcall_end 不会与 delta 占位卡并存", () => {
  const frames = toolFrames().slice(0, 3);
  const msgs = replay(frames);
  expect(msgs.filter((m) => m.kind === "tool")).toHaveLength(1);
  const card = msgs[0] as Extract<ViewMsg, { kind: "tool" }>;
  expect(card.state).toBe("running");
  expect(card.id).toBe("tool:call_abc");
 });

 it("内部标记不会漏进 store（ViewMsg 契约保持干净）", () => {
  const msgs = replay(toolFrames());
  for (const m of msgs) {
   expect("__append" in m).toBe(false);
   expect("__replaceId" in m).toBe(false);
  }
 });

 it("多工具并行各出一张卡，互不串卡", () => {
  const msgs = replay([
   ...toolFrames(),
   {
    type: "message_update",
    assistantMessageEvent: {
     type: "toolcall_end",
     contentIndex: 2,
     toolCall: { id: "call_def", name: "read", arguments: { path: "/tmp/a.ts" }, streamIndex: 2 },
    },
   },
   { type: "tool_execution_end", toolCallId: "call_def", isError: true, result: { content: [{ type: "text", text: "not found" }] } },
  ]);
  const tools = msgs.filter((m) => m.kind === "tool") as Extract<ViewMsg, { kind: "tool" }>[];
  expect(tools).toHaveLength(2);
  expect(tools.find((t) => t.toolCallId === "call_abc")?.state).toBe("ok");
  expect(tools.find((t) => t.toolCallId === "call_def")?.state).toBe("error");
  expect(tools.find((t) => t.toolCallId === "call_def")?.argsSummary).toBe("/tmp/a.ts");
 });

 it("被拒绝的工具显示「被用户拒绝」且为失败态", () => {
  const msgs = replay([
   ...toolFrames().slice(0, 4),
   {
    type: "message_end",
    message: {
     role: "toolResult",
     toolCallId: "call_abc",
     toolName: "bash",
     isError: true,
     content: [{ type: "text", text: "Tool call denied by user: bash" }],
    },
   },
  ]);
  const card = msgs.find((m) => m.kind === "tool") as Extract<ViewMsg, { kind: "tool" }>;
  expect(card.state).toBe("error");
  expect(card.output).toBe("被用户拒绝");
 });
});

describe("实时流合并：文本与审批", () => {
 beforeEach(() => __resetFolds());

 it("text 流式按同 id 覆盖，不新增消息行", () => {
  const frames = [
   { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
   { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你" } },
   { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "好" } },
  ];
  const msgs = replay(frames);
  expect(msgs).toHaveLength(1);
  expect(msgs[0].kind === "text" && msgs[0].text).toBe("你好");
 });

 it("完成态更新落在同一行上；迟到的增量帧不把写完的行重开（V46）", () => {
  const base = replay([
   { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
   { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "半句" } },
  ]);
  expect(base).toHaveLength(1);
  // text_end（complete 帧）原地更新
  const done = mergeViewMsgs(base, [
   { kind: "text", id: base[0].id, seq: 0, text: "半句完了", complete: true, __append: true } as never,
  ]);
  expect(done).toHaveLength(1);
  expect(done[0].kind === "text" && done[0].complete && done[0].text).toBe("半句完了");
  // 迟到的增量帧不许把已完成的行驶回未完成态
  const late = mergeViewMsgs(done, [
   { kind: "text", id: base[0].id, seq: 0, text: "半句完了（迟到）", complete: false, __append: true } as never,
  ]);
  expect(late).toHaveLength(1);
  expect(late[0].kind === "text" && late[0].complete && late[0].text).toBe("半句完了");
  // message_end 再推一遍完成态：仍是同一行（不追加第二份）
  const again = mergeViewMsgs(late, [
   { kind: "text", id: base[0].id, seq: 0, text: "半句完了", complete: true, __append: true } as never,
  ]);
  expect(again).toHaveLength(1);
 });

 it("同一审批请求重复推送只保留一张卡", () => {
  const frame = { type: "extension_ui_request", method: "select", id: "ui-1", title: "Allow tool: bash" };
  const msgs = replay([frame, frame]);
  expect(msgs).toHaveLength(1);
  expect(msgs[0].kind).toBe("approval");
 });
});

describe("mergeViewMsgs 基础语义", () => {
 it("空追加不改变已有消息", () => {
  const cur: ViewMsg[] = [{ kind: "text", id: "t:1", seq: 0, text: "x", complete: true }];
  expect(mergeViewMsgs(cur, [])).toEqual(cur);
 });

 // V2 M8：行级 memo（ThreadRow）成立的前提——没变化的消息必须保持同一对象引用，
 // 否则流式每个 delta 都会让整列重渲染（上千条时每次 token 重算全部 Markdown）。
 it("未变化的消息保持同一对象引用", () => {
  const first = mergeViewMsgs([], [
   { kind: "text", id: "t:1", seq: 0, text: "已有内容", complete: true } as ViewMsg,
  ]);
  const second = mergeViewMsgs(first, [
   { kind: "text", id: "t:2", seq: 0, text: "新来的一条", complete: true } as ViewMsg,
  ]);
  expect(second[0]).toBe(first[0]);
  expect(second[1]).not.toBe(first[0]);
 });

 it("流式覆盖只替换被覆盖的那一行", () => {
  const first = mergeViewMsgs([], [
   { kind: "text", id: "t:1", seq: 0, text: "旧", complete: true } as ViewMsg,
   { kind: "text", id: "t:2", seq: 0, text: "流式中", complete: false } as ViewMsg,
  ]);
  const second = mergeViewMsgs(first, [
   { kind: "text", id: "t:2", seq: 0, text: "流式中（新）", complete: false, __append: true } as IncomingViewMsg,
  ]);
  expect(second[0]).toBe(first[0]);
  expect(second[1]).not.toBe(first[1]);
  expect(second[1].kind === "text" && second[1].text).toBe("流式中（新）");
 });
});

/**
 * V2 M5：`extension_ui_request` 不再"除 select 外一律当审批"。
 * 审批只认 select（options 含 Approve，或 options 缺失时兜底），
 * confirm / input / editor / 非审批 select 走通用 UI 请求卡，回包语义由后端按方法组装。
 */
describe("实时流合并：通用 UI 请求", () => {
 beforeEach(() => __resetFolds());

 it("confirm / input / editor 各出一张通用 UI 卡，字段不丢", () => {
  const confirm = replay([
   { type: "extension_ui_request", id: "c1", method: "confirm", title: "清理？", message: "删 3 个文件" },
  ]);
  expect(confirm).toHaveLength(1);
  const c = confirm[0] as Extract<ViewMsg, { kind: "ui" }>;
  expect(c.kind).toBe("ui");
  expect(c.method).toBe("confirm");
  expect(c.uiId).toBe("c1");
  expect(c.message).toBe("删 3 个文件");

  const input = replay([
   { type: "extension_ui_request", id: "i1", method: "input", title: "分支名？", placeholder: "feature/…" },
  ]);
  expect((input[0] as Extract<ViewMsg, { kind: "ui" }>).placeholder).toBe("feature/…");

  const editor = replay([
   { type: "extension_ui_request", id: "e1", method: "editor", title: "提交信息", prefill: "chore: " },
  ]);
  const e = editor[0] as Extract<ViewMsg, { kind: "ui" }>;
  expect(e.method).toBe("editor");
  expect(e.prefill).toBe("chore: ");
 });

 it("审批只认 select：含 Approve 或 options 缺失都走审批卡", () => {
  const withApprove = replay([
   { type: "extension_ui_request", id: "a1", method: "select", title: "Allow tool: bash", options: ["Approve", "Deny"] },
  ]);
  expect(withApprove[0].kind).toBe("approval");
  const noOptions = replay([{ type: "extension_ui_request", id: "a2", method: "select", title: "Allow tool: bash" }]);
  expect(noOptions[0].kind).toBe("approval");
 });

 it("非审批 select 带选项清单，走通用 UI 卡", () => {
  const msgs = replay([
   { type: "extension_ui_request", id: "s1", method: "select", title: "选分支", options: ["main", "release/2.0"] },
  ]);
  const s = msgs[0] as Extract<ViewMsg, { kind: "ui" }>;
  expect(s.kind).toBe("ui");
  expect(s.options).toEqual(["main", "release/2.0"]);
 });

 it("同一条请求重复推送只留一张卡；服务端撤回后卡片消失", () => {
  const req = { type: "extension_ui_request", id: "d1", method: "input", title: "说点什么" };
  expect(replay([req, req])).toHaveLength(1);

  const cancelled = replay([req, { type: "extension_ui_request", method: "cancel", targetId: "d1" }]);
  expect(cancelled.filter((m) => m.kind === "ui")).toHaveLength(0);
 });

 it("单向方法不占交互位：notify 走分隔线，其余忽略", () => {
  const notify = replay([
   { type: "extension_ui_request", id: "n1", method: "notify", message: "构建完成", notifyType: "info" },
  ]);
  expect(notify).toHaveLength(1);
  expect(notify[0].kind).toBe("divider");

  const quiet = replay([
   { type: "extension_ui_request", id: "w1", method: "setWidget", widgetKey: "k", widgetLines: ["a"] },
   { type: "extension_ui_request", id: "t1", method: "setTitle", title: "x" },
   { type: "extension_ui_request", id: "st1", method: "setStatus", statusKey: "k", statusText: "跑着呢" },
   { type: "extension_ui_request", id: "et1", method: "set_editor_text", text: "abc" },
  ]);
  expect(quiet).toHaveLength(0);
 });
});

/** V2 M6：随消息发出的图片在实时帧里也要落到 user 气泡（不是被丢掉）。 */
describe("实时流：用户消息的图片块", () => {
 beforeEach(() => __resetFolds());

 it("message_start(user) 的图片块并入同一条 user 消息", () => {
  const msgs = replay([
   {
    type: "message_start",
    message: {
     role: "user",
     content: [
      { type: "text", text: "看图" },
      { type: "image", data: "AAA", mimeType: "image/png" },
     ],
    },
   },
  ]);
  expect(msgs).toHaveLength(1);
  expect(msgs[0]).toMatchObject({
   kind: "user",
   text: "看图",
   images: [{ mimeType: "image/png", data: "AAA" }],
  });
 });
});

/** V2 M6b：@文件 提及的 fileMention 只出一排芯片（start/end 各推一次也不许出两排）。 */
describe("实时流：@文件 提及", () => {
 beforeEach(() => __resetFolds());

 it("fileMention 的 start/end 各推一次，只出一排芯片", () => {
  const frame = {
   type: "message_start",
   message: {
    role: "fileMention",
    files: [
     { path: "docs/rpc-memo.md", content: "…", lineCount: 69 },
     { path: "a.bin", byteSize: 1024, skippedReason: "tooLarge" },
    ],
   },
  };
  const msgs = replay([frame, { ...frame, type: "message_end" }]);
  expect(msgs).toHaveLength(1);
  expect(msgs[0]).toMatchObject({ kind: "files" });
  expect((msgs[0] as Extract<ViewMsg, { kind: "files" }>).files).toHaveLength(2);
 });

 it("fileMention 不影响同一批次里的文本流", () => {
  const msgs = replay([
   {
    type: "message_start",
    message: { role: "fileMention", files: [{ path: "a.ts", lineCount: 3 }] },
   },
   { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "" }] } },
   { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
   { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "读完" } },
  ]);
  expect(msgs.map((m) => m.kind)).toEqual(["files", "text"]);
 });
});

/** 本轮新增：本地命令 / 计划 / 压缩重试 / 可用命令帧的归一。 */
describe("实时流：本地命令与计划事件", () => {
 it("command_output 落成 command 卡（灰字代码区）", () => {
  const msgs = replay([
   { type: "command_output", id: "c-1", output: "本地命令已执行：/compact" },
  ]);
  expect(msgs).toHaveLength(1);
  expect(msgs[0]).toMatchObject({ kind: "command", output: "本地命令已执行：/compact" });
 });

 it("prompt_result（本地收尾）不渲染消息、不告警", () => {
  const msgs = replay([{ type: "prompt_result", id: "p-1", agentInvoked: false }]);
  expect(msgs).toHaveLength(0);
 });

 it("todo_reminder / todo_auto_clear 不进消息流（任务清单走 store 的 plansBySession）", () => {
  // 上游（omp 18.10.4 实测）`todo_reminder` 的真实形状是「未完成项提醒」：
  // `{todos, attempt, maxAttempts}`——不带阶段清单。清单真值在 todo 工具帧的
  // `details.phases`（实时）与 `get_state.todoPhases`（回读），由浮卡 / 右栏展示。
  const msgs = replay([
   { type: "todo_reminder", todos: [{ content: "乙", status: "in_progress" }], attempt: 1, maxAttempts: 3 },
   { type: "todo_auto_clear" },
  ]);
  expect(msgs).toHaveLength(0);
 });

 it("压缩 / 重试帧落成分隔线（不进消息计数）", () => {
  const msgs = replay([{ type: "auto_compaction_start" }, { type: "auto_compaction_end" }]);
  expect(msgs).toHaveLength(2);
  expect(msgs[0]).toMatchObject({ kind: "divider", text: "正在压缩上下文…" });
  expect(msgs[1]).toMatchObject({ kind: "divider", text: "上下文已压缩" });
 });

 it("子代理 lifecycle 落成起止行，progress 高频帧不渲染", () => {
  const msgs = replay([
   { type: "subagent_lifecycle", payload: { id: "S1", agent: "scout", status: "started", description: "调研 A 模块", index: 0 } },
   { type: "subagent_progress", payload: { id: "S1", agent: "scout", index: 0, progress: { status: "running", toolCount: 3 } } },
   { type: "subagent_lifecycle", payload: { id: "S1", agent: "scout", status: "completed", index: 0 } },
   { type: "subagent_lifecycle", payload: { id: "S2", agent: "reviewer", status: "failed", index: 1 } },
   { type: "subagent_lifecycle", payload: { id: "S3", agent: "task", status: "started", index: 2 } },
  ]);
  expect(msgs.map((m) => (m.kind === "divider" ? m.text : m.kind))).toEqual([
   "子代理 scout 启动：调研 A 模块",
   "子代理 scout 完成",
   "子代理 reviewer 失败",
   "子代理 task 启动",
  ]);
 });

 it("command_output 渲染成 command 块（原文透传，不解析内容）", () => {
  const msgs = replay([
   { type: "command_output", text: "Advisor is enabled (openai/gpt-5.6). Context: 0 / 100 tokens (0%)." },
  ]);
  expect(msgs).toMatchObject([{ kind: "command", output: "Advisor is enabled (openai/gpt-5.6). Context: 0 / 100 tokens (0%)." }]);
 });
});

/**
 * 回归：会话还没有用户消息时，模型 / 思考档变更不算「会话中切换」——
 * 口径与历史回放（viewmsg.ts 的 `userSeen`）一致，新建对话顶部不许凭空多一行提示。
 */
describe("实时流：首条用户消息之前的模型 / 思考档变更", () => {
 beforeEach(() => __resetFolds());

 it("空会话（无用户消息）不渲染分隔线", () => {
  useApp.setState({ eventsBySession: {} });
  const msgs = replay([{ type: "model_changed" }, { type: "thinking_level_changed", thinkingLevel: "max" }]);
  expect(msgs).toHaveLength(0);
 });

 it("用户消息之后照旧渲染", () => {
  useApp.setState({
   eventsBySession: { [SID]: [{ kind: "user", id: "u-1", text: "hi", mentions: [] }] },
  });
  const msgs = replay([
   { type: "model_changed" },
   { type: "thinking_level_changed", thinkingLevel: "high" },
  ]);
  expect(msgs).toMatchObject([
   { kind: "divider", divider: "model", text: "已切换模型" },
   { kind: "divider", divider: "thinking", text: "思考等级已设为 high" },
  ]);
 });
});

/**
 * V37：流式帧的 rAF 合并缓冲。
 *
 * 为什么需要：每个 delta 一帧、每帧一次 store 写入 + 全量 Markdown 重渲染——
 * 实测 3000 字符的回复出现单次 86ms 的长任务，长回复越写越顿。
 * 缓冲把同一渲染帧窗口内的帧折叠成一次写入；`dispose` 丢弃未 flush 的帧
 * （会话切走时内容真相在 jsonl，切回全量重拉）。
 */
describe("流式帧合并缓冲（V37）", () => {
 beforeEach(() => __resetFolds());

 it("coalesceStream：同 id 文本只留最后一份，__append 保住", () => {
  const a: IncomingViewMsg[] = [{ kind: "text", id: "s:0", seq: 0, text: "半", complete: false, __append: true }];
  const b: IncomingViewMsg[] = [{ kind: "text", id: "s:0", seq: 0, text: "半句话", complete: false, __append: true }];
  const out = coalesceStream(a, b);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ kind: "text", text: "半句话" });
  expect(out[0].__append).toBe(true);
 });

 it("coalesceStream：同窗口的工具阶段帧合成一张，元数据与 __replaceId 不丢", () => {
  // toolcall_end：带元数据 + 占位卡（contentIndex）替换标记
  const end: IncomingViewMsg = {
   kind: "tool",
   id: "tool:call_1",
   toolCallId: "call_1",
   name: "bash",
   intent: "跑命令",
   argsSummary: "echo hi",
   state: "running",
   output: "",
   streamIndex: 1,
   __replaceId: "sess-1:1",
  };
  // 执行结束：状态与输出新，元数据不带
  const exec: IncomingViewMsg = {
   kind: "tool",
   id: "tool:call_1",
   toolCallId: "call_1",
   name: "bash",
   intent: "",
   argsSummary: "",
   state: "ok",
   output: "hi",
   streamIndex: 0,
  };
  const out = coalesceStream([end], [exec]);
  expect(out).toHaveLength(1);
  // 状态 / 输出取新帧，早期帧才有的元数据必须继承（与 mergeToolCard 同源）
  expect(out[0]).toMatchObject({ kind: "tool", state: "ok", output: "hi", argsSummary: "echo hi" });
  // 占位卡替换语义不许因为被后续帧覆盖而丢（丢了占位卡永远转圈）
  expect(out[0].__replaceId).toBe("sess-1:1");
 });

 it("coalesceStream：同 id 覆盖保持原位，不同 id 的新帧按序追加", () => {
  const a: IncomingViewMsg[] = [{ kind: "text", id: "s:0", seq: 0, text: "A", complete: false, __append: true }];
  const b: IncomingViewMsg[] = [
   { kind: "divider", id: "d1", divider: "turn", text: "分隔" },
   { kind: "text", id: "s:0", seq: 0, text: "AB", complete: false, __append: true },
   { kind: "thinking", id: "s:1", text: "想一下", seconds: 0, complete: false },
  ];
  const out = coalesceStream(a, b);
  expect(out).toHaveLength(3);
  // 同 id 的 text 原位覆盖成最新版；新帧（divider / thinking）按到达顺序跟在后面
  expect(out[0]).toMatchObject({ kind: "text", text: "AB" });
  expect(out[1].kind).toBe("divider");
  expect(out[2].kind).toBe("thinking");
 });

 it("createStreamBuffer：窗口内多批折叠成一次 flush，新批重新调度", () => {
  const rafQueue: FrameRequestCallback[] = [];
  const original = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
   rafQueue.push(cb);
   return rafQueue.length;
  }) as typeof requestAnimationFrame;
  try {
   const flushed: IncomingViewMsg[][] = [];
   const buf = createStreamBuffer((batch) => flushed.push(batch));
   buf.push([{ kind: "text", id: "x:0", seq: 0, text: "半", complete: false, __append: true }]);
   buf.push([{ kind: "text", id: "x:0", seq: 0, text: "半句", complete: false, __append: true }]);
   buf.push([{ kind: "text", id: "x:0", seq: 0, text: "半句话", complete: false, __append: true }]);
   // 三批只调度一次；flush 前 store 不受影响
   expect(rafQueue).toHaveLength(1);
   expect(flushed).toHaveLength(0);
   rafQueue[0](0);
   expect(flushed).toHaveLength(1);
   expect(flushed[0]).toHaveLength(1);
   expect(flushed[0][0]).toMatchObject({ kind: "text", text: "半句话" });
   // flush 完成后的新批重新调度
   buf.push([{ kind: "divider", id: "d2", divider: "turn", text: "后" }]);
   expect(rafQueue).toHaveLength(2);
  } finally {
   globalThis.requestAnimationFrame = original;
  }
 });

 it("createStreamBuffer：dispose 丢弃未 flush 的帧", () => {
  const rafQueue: FrameRequestCallback[] = [];
  const original = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
   rafQueue.push(cb);
   return rafQueue.length;
  }) as typeof requestAnimationFrame;
  try {
   const flushed: IncomingViewMsg[][] = [];
   const buf = createStreamBuffer((batch) => flushed.push(batch));
   buf.push([{ kind: "text", id: "x:0", seq: 0, text: "半", complete: false, __append: true }]);
   buf.dispose();
   rafQueue[0](0);
   expect(flushed).toHaveLength(0);
  } finally {
   globalThis.requestAnimationFrame = original;
  }
 });
});

/**
 * 无内容文本块（孤立标点）不落正文行：omp 的模型偶尔在思考与工具调用之间吐一个
 * `{"type":"text","text":"."}`（本机 12 个会话里 375 次，其中 247 次正是这个形状）。
 * 流式增量会先把这一行建出来，`text_end` 一到必须整行撤掉——否则消息列里留一格空白加一个「.」。
 */
describe("无内容文本块（孤立标点）不落行", () => {
 const frames = (text: string): Record<string, unknown>[] => [
  { type: "message_start", message: { role: "assistant", content: [] } },
  { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } },
  { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text } },
 ];

 it("`text_delta('.')` + `text_end('.')` → 消息流里没有正文行", () => {
  expect(replay(frames(".")).filter((m) => m.kind === "text")).toEqual([]);
 });

 it("增量先建了行、收尾是空白 → 这一行也撤掉", () => {
  expect(replay(frames(" \n")).filter((m) => m.kind === "text")).toEqual([]);
 });

 it("有实义字符的块照旧保留（收尾内容为准）", () => {
  expect(replay(frames("改好了：")).filter((m) => m.kind === "text")).toMatchObject([
   { text: "改好了：", complete: true },
  ]);
 });
});
