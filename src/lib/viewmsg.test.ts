import { describe, expect, it } from "vitest";
import { TEXT } from "./locale";
import { diffStatOf, summarizeArgs, viewMsgFromJsonlLine, viewMsgsFromJsonlLines } from "./viewmsg";

/** 归一 / 导出 / 实时管线的文案取字典；测试只锁中文口径。 */
const zh = TEXT["zh-CN"];

describe("summarizeArgs", () => {
 it("read 显示 path+行号", () => {
  expect(summarizeArgs("read", { path: "a/b.rs", startLine: 1, endLine: 120 })).toBe("a/b.rs:1-120");
 });
 it("bash 显示 command", () => {
  expect(summarizeArgs("bash", { command: "echo hi" })).toBe("echo hi");
 });
});

describe("diffStatOf（工具行的 +N −M）", () => {
 it("write 按 content 行数记新增", () => {
  expect(diffStatOf("write", { path: "a.ts", content: "l1\nl2\nl3" })).toEqual({ added: 3, removed: 0 });
 });
 it("edit 记 new_string 增 / old_string 删", () => {
  expect(diffStatOf("edit", { old_string: "a\nb", new_string: "a\nb\nc\nd" })).toEqual({
   added: 4,
   removed: 2,
  });
 });
 it("参数缺失 / 非写改类工具 → null（界面上不画这两个数）", () => {
  expect(diffStatOf("write", {})).toBeNull();
  expect(diffStatOf("edit", {})).toBeNull();
  expect(diffStatOf("bash", { command: "ls" })).toBeNull();
  expect(diffStatOf("read", { path: "a.ts" })).toBeNull();
 });
});

describe("viewMsgFromJsonlLine", () => {
 it("user 文本归一", () => {
  const msgs = viewMsgFromJsonlLine({
   type: "message",
   message: { role: "user", content: [{ type: "text", text: "hi" }] },
  }, zh);
  expect(msgs[0]).toMatchObject({ kind: "user", text: "hi" });
 });
 it("toolResult 错误态", () => {
  const msgs = viewMsgFromJsonlLine({
   type: "message",
   message: {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "bash",
    isError: true,
    content: [{ type: "text", text: "denied" }],
   },
  }, zh);
  expect(msgs[0]).toMatchObject({ kind: "tool", state: "error" });
 });
 it("model_change 走分隔线", () => {
  const msgs = viewMsgFromJsonlLine({ type: "model_change" }, zh);
  expect(msgs[0]).toMatchObject({ kind: "divider", divider: "model" });
 });
 it("未知 type 不崩", () => {
  expect(viewMsgFromJsonlLine({ type: "something_new" }, zh)).toEqual([]);
 });
 it("developer（omp 规则提醒）→ 提醒分隔行，不落正文", () => {
  const msgs = viewMsgFromJsonlLine(
   {
    type: "message",
    message: {
     role: "developer",
     content: [
      {
       type: "text",
       text: '<system-reminder reason="rule_violation" rule="ts-no-tiny-functions" path="builtin-defaults:ts-no-tiny-functions.md">\n规则全文……\n</system-reminder>',
      },
     ],
    },
   },
   zh,
  );
  expect(msgs).toHaveLength(1);
  expect(msgs[0]).toMatchObject({
   kind: "divider",
   divider: "reminder",
   text: expect.stringContaining("ts-no-tiny-functions"),
  });
 });
 it("未知 role 的消息不按正文渲染（注入内容不泄漏）", () => {
  expect(
   viewMsgFromJsonlLine(
    { type: "message", message: { role: "system", content: [{ type: "text", text: "不该出现在正文" }] } },
    zh,
   ),
  ).toEqual([]);
 });

 // V2 M6：带图片的用户消息，图片并进同一条 user 气泡（不是新增一条空消息）
 it("用户消息里的图片块并入同一条 user 消息", () => {
  const msgs = viewMsgFromJsonlLine({
   type: "message",
   message: {
    role: "user",
    content: [
     { type: "text", text: "看看这张图" },
     { type: "image", data: "AAA", mimeType: "image/png" },
    ],
   },
  }, zh);
  expect(msgs).toHaveLength(1);
  expect(msgs[0]).toMatchObject({ kind: "user", text: "看看这张图", images: [{ mimeType: "image/png", data: "AAA" }] });
 });

 it("只有图片没有文字时也出一条 user 消息", () => {
  const msgs = viewMsgFromJsonlLine({
   type: "message",
   message: { role: "user", content: [{ type: "image", data: "BBB", mimeType: "image/jpeg" }] },
  }, zh);
  expect(msgs).toHaveLength(1);
  expect(msgs[0]).toMatchObject({ kind: "user", text: "", images: [{ mimeType: "image/jpeg", data: "BBB" }] });
 });

 // V2 M6b：@文件 提及被 omp 读进上下文 → fileMention 消息 → 一排文件芯片
 it("fileMention 消息归一成 files 芯片排（含跳过项与行数）", () => {
  const msgs = viewMsgFromJsonlLine({
   type: "message",
   message: {
    role: "fileMention",
    files: [
     { path: "docs/rpc-memo.md", content: "全文…", lineCount: 69 },
     { path: "a.bin", content: "(skipped)", byteSize: 12582912, skippedReason: "tooLarge" },
    ],
   },
  }, zh);
  expect(msgs).toHaveLength(1);
  expect(msgs[0]).toMatchObject({
   kind: "files",
   files: [
    { path: "docs/rpc-memo.md", lineCount: 69 },
    { path: "a.bin", byteSize: 12582912, skippedReason: "tooLarge" },
   ],
  });
  // 文件全文不许进前端 ViewMsg（jsonl 里已经有了）
  expect(JSON.stringify(msgs[0])).not.toContain("全文");
 });

 it("fileMention 没有 files 时不出空芯片排", () => {
  expect(viewMsgFromJsonlLine({ type: "message", message: { role: "fileMention", files: [] } }, zh)).toEqual([]);
  expect(viewMsgFromJsonlLine({ type: "message", message: { role: "fileMention" } }, zh)).toEqual([]);
 });
});

describe("viewMsgsFromJsonlLines（历史批量归一）", () => {
 const callLine = {
  type: "message",
  id: "assistant-1",
  message: {
   role: "assistant",
   content: [
    {
     type: "toolCall",
     id: "call_1",
     name: "bash",
     arguments: { command: "echo hi" },
     streamIndex: 0,
     intent: "执行 echo 测试",
    },
   ],
  },
 };
 const startLine = {
  type: "custom",
  id: "start-1",
  customType: "tool_execution_start",
  data: { toolCallId: "call_1", toolName: "bash", args: {}, intent: "执行 echo 测试" },
 };
 const resultLine = {
  type: "message",
  id: "result-1",
  message: {
   role: "toolResult",
   toolCallId: "call_1",
   toolName: "bash",
   isError: false,
   content: [{ type: "text", text: "hi\n" }],
  },
 };

 it("已完成工具只出一卡且终态 ok（含意图与参数）", () => {
  const msgs = viewMsgsFromJsonlLines([callLine, startLine, resultLine], zh);
  const tools = msgs.filter((m) => m.kind === "tool");
  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({
   id: "tool:call_1",
   toolCallId: "call_1",
   name: "bash",
   intent: "执行 echo 测试",
   argsSummary: "echo hi",
   state: "ok",
   output: "hi\n",
  });
 });

 it("未完成工具才 running（无结果行）", () => {
  const msgs = viewMsgsFromJsonlLines([callLine, startLine], zh);
  const tools = msgs.filter((m) => m.kind === "tool");
  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({ state: "running", output: "" });
 });

 it("失败结果归一为 error", () => {
  const msgs = viewMsgsFromJsonlLines([
   callLine,
   startLine,
   {
    type: "message",
    id: "result-err",
    message: {
     role: "toolResult",
     toolCallId: "call_1",
     toolName: "bash",
     isError: true,
     content: [{ type: "text", text: "Tool call denied by user: bash" }],
    },
   },
  ], zh);
  const tools = msgs.filter((m) => m.kind === "tool");
  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({ state: "error" });
 });

 it("同行多 toolCall 各出一卡", () => {
  const msgs = viewMsgsFromJsonlLines([
   {
    type: "message",
    id: "assistant-multi",
    message: {
     role: "assistant",
     content: [
      { type: "toolCall", id: "c-a", name: "read", arguments: { path: "a.ts" }, streamIndex: 0 },
      { type: "toolCall", id: "c-b", name: "bash", arguments: { command: "ls" }, streamIndex: 1 },
     ],
    },
   },
   {
    type: "message",
    id: "r-a",
    message: { role: "toolResult", toolCallId: "c-a", toolName: "read", isError: false, content: [{ type: "text", text: "ok" }] },
   },
   {
    type: "message",
    id: "r-b",
    message: { role: "toolResult", toolCallId: "c-b", toolName: "bash", isError: false, content: [{ type: "text", text: "ok" }] },
   },
  ], zh);
  const tools = msgs.filter((m) => m.kind === "tool");
  expect(tools.map((t) => (t.kind === "tool" ? t.toolCallId : ""))).toEqual(["c-a", "c-b"]);
  expect(tools.every((t) => t.kind === "tool" && t.state === "ok")).toBe(true);
 });

 it("id 稳定：重复归一可去重", () => {
  const a = viewMsgsFromJsonlLines([callLine, startLine, resultLine], zh);
  const b = viewMsgsFromJsonlLines([callLine, startLine, resultLine], zh);
  expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id));
 });

 it("developer（omp 规则提醒）→ 提醒分隔行；未知 role 不落正文", () => {
  const msgs = viewMsgsFromJsonlLines([
   { type: "message", id: "u-x", message: { role: "user", content: [{ type: "text", text: "改一下" }] } },
   {
    type: "message",
    id: "dev-1",
    message: {
     role: "developer",
     content: [
      {
       type: "text",
       text: '<system-reminder reason="rule_violation" rule="ts-no-tiny-functions">规则全文…</system-reminder>',
      },
     ],
    },
   },
   { type: "message", id: "sys-1", message: { role: "system", content: [{ type: "text", text: "不该出现" }] } },
   { type: "message", id: "a-1", message: { role: "assistant", content: [{ type: "text", text: "好的" }] } },
  ], zh);
  expect(msgs.map((m) => m.kind)).toEqual(["user", "divider", "text"]);
  expect(msgs[1]).toMatchObject({
   kind: "divider",
   divider: "reminder",
   text: expect.stringContaining("ts-no-tiny-functions"),
  });
  // 注入正文 / 未知 role 的内容都不入流
  expect(JSON.stringify(msgs)).not.toContain("规则全文");
  expect(JSON.stringify(msgs)).not.toContain("不该出现");
 });
});

/**
 * 回归：新建会话顶部那行「思考等级已设为 max」。omp 在会话创建时就把初始模型 / 思考档
 * 落盘（`--model` / `--thinking`，见本机真实 jsonl 的第 2~3 行），它们不是会话中切换，
 * 首条用户消息之前的一律不渲染。
 */
describe("viewMsgsFromJsonlLines：会话初始配置不渲染分隔线", () => {
 const head = [
  { type: "session", id: "s1", cwd: "/tmp/x" },
  { type: "thinking_level_change", id: "cfg-1", parentId: null, thinkingLevel: "max", configured: "max" },
  { type: "model_change", id: "cfg-2", model: "commandcode/claude-opus-5" },
 ];
 const userLine = {
  type: "message",
  id: "u-1",
  message: { role: "user", content: [{ type: "text", text: "hi" }] },
 };

 it("首条用户消息之前的初始档位 / 模型不出分隔线", () => {
  expect(viewMsgsFromJsonlLines([...head, userLine], zh).map((m) => m.kind)).toEqual(["user"]);
 });

 it("用户消息之后的切换照旧渲染（会话中切换仍有回执）", () => {
  const msgs = viewMsgsFromJsonlLines([
   ...head,
   userLine,
   { type: "thinking_level_change", id: "sw-1", thinkingLevel: "high" },
   { type: "model_change", id: "sw-2", model: "commandcode/claude-haiku-4-5" },
  ], zh);
  const dividers = msgs
   .filter((m) => m.kind === "divider")
   .map((m) => (m.kind === "divider" ? m.text : ""));
  expect(dividers).toEqual(["思考等级已设为 high", "已切换模型"]);
 });
});

/**
 * 回归：消息列流尾凭空多出的「标题：…」分隔行。`title_change` 是会话元数据
 * （真实 jsonl 形状：壳侧自动补标题注入的 `/rename` 落的一行带 `source: "user"`），
 * 标题更新走顶栏 / 左栏，历史回放不许把它渲染成正文。
 */
describe("标题变更不落正文（title_change 只更新标题）", () => {
 const userLine = { type: "message", id: "u-1", message: { role: "user", content: [{ type: "text", text: "hi" }] } };
 const titleLine = {
  type: "title_change",
  id: "t-1",
  parentId: "u-1",
  timestamp: "2026-10-23T01:43:15.409Z",
  title: "󰈙 DOC: 更新项目文档",
  source: "user",
 };

 it("批量归一：只出用户行，不出「标题：…」分隔线", () => {
  expect(viewMsgsFromJsonlLines([userLine, titleLine], zh).map((m) => m.kind)).toEqual(["user"]);
 });

 it("单行归一：同口径", () => {
  expect(viewMsgFromJsonlLine(titleLine, zh)).toEqual([]);
 });
});

/**
 * 无内容文本块不落正文行：omp 的模型偶尔在思考与工具调用之间吐一个孤立标点
 * （本机 12 个会话里 `{"type":"text","text":"."}` 出现 375 次，其中 247 次正是这个形状）。
 * 落成正文行就是「一整行空白 + 一个点」，纯噪声。
 */
describe("无内容文本块（孤立标点）不落行", () => {
 const dotLine = (id: string) => ({
  type: "message",
  id,
  message: {
   role: "assistant",
   content: [
    { type: "thinking", thinking: "先看一眼现状" },
    { type: "text", text: "." },
    { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" }, streamIndex: 2 },
   ],
  },
 });

 it("批量归一：`[思考, text(\".\"), 工具]` 只出思考与工具两行", () => {
  const msgs = viewMsgsFromJsonlLines([dotLine("a1")], zh);
  expect(msgs.map((m) => m.kind)).toEqual(["thinking", "tool"]);
 });

 it("单行归一：同上（打开实时流过的那条消息不翻出正文行）", () => {
  const msgs = viewMsgFromJsonlLine(dotLine("a1"), zh);
  expect(msgs.map((m) => m.kind)).toEqual(["thinking", "tool"]);
 });

 it("空白块同样不落行；有实义字符的块照旧", () => {
  const onlySpace = {
   type: "message",
   id: "a2",
   message: { role: "assistant", content: [{ type: "text", text: "   \n" }, { type: "text", text: "好" }] },
  };
  expect(viewMsgFromJsonlLine(onlySpace, zh).map((m) => m.kind)).toEqual(["text"]);
  const punct = {
   type: "message",
   id: "a3",
   message: { role: "assistant", content: [{ type: "text", text: "？" }] },
  };
  expect(viewMsgFromJsonlLine(punct, zh)).toEqual([]);
 });
});
