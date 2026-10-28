import { useEffect } from "react";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { IPC } from "@shared/ipc";
import { api } from "@shared/api";
import { isRemoteClient, onRemoteConnection, onRemoteReconnected, remoteListen, remotePending } from "@shared/remote";
import { useApp } from "../stores/app";
import type { AskQuestion, BtwRecord, BtwTurn, SessionRuntime, SessionStatus, SubAgentInfo, TodoPhase, ViewMsg } from "@shared/types";
import { summarizeArgs, mentionFilesOf, diffStatOf, primaryPathOf, TOOL_OUTPUT_FULL_MAX } from "./viewmsg";
import { fmt, TEXT, type Text } from "./locale";
import { imagesFromContent } from "./attachments";
import { restoreImageOrder, stripImageOrderNote, withImageOrderNote } from "./imageRefs";
import { normalizeCommands } from "./slashCommands";
import { forgetSessionLiveStats } from "./sessionLiveStats";
import { scheduleWorkspaceGitRefresh } from "./commitTasks";
import { resolveThinking } from "./thinking";
import { createStreamBuffer, mergeViewMsgs, type FrameBuffer, type IncomingViewMsg } from "./mergeEvents";
import { transferEditorDraft } from "./draftTransfer";

/**
 * 把后端转发的 omp 事件归一为 ViewMsg。
 * 历史（get_history 原始块）与实时流共用 viewMsgFromJsonlLine 语义，
 * 此处只处理实时帧的增量形态（message_update 三类 delta 等）。
 */
type Fold = {
 textId: string | null;
 text: string;
 thinkingId: string | null;
 thinking: string;
 /** toolcall 占位卡的正式 id（`tool:<toolCallId>`；从 `partial` 拿到后记下，见 toolcall 分支）。 */
 toolIds: Record<string, string>;
 toolMeta: Record<string, { name: string; intent: string; streamIndex: number }>;
 startedAt: number;
 /**
  * 当前 assistant 消息的序号（每次 `message_start` +1）。实时行的 id 是
  * `${sid}:${msgSeq}:${contentIndex}`——**contentIndex 在每条新消息里都从 0 重新数**，
  * 只用它会让第二轮的文本块与第一轮撞同一个 id（React 重复 key + 合并时找错行）。
  */
 msgSeq: number;
};

/**
 * 工具卡 id：一次调用的所有阶段（toolcall_end / tool_execution_start / _end /
 * message{toolResult}）共用一个，配合 mergeViewMsgs 的原位覆盖，
 * 保证「输入中 → 运行中 → 成功/失败」始终是同一张卡。
 * 无 toolCallId 的异常帧才退回时间戳兜底 id（宁可多一张卡也不能串卡）。
 */
const toolCardId = (toolCallId: string): string =>
 toolCallId ? `tool:${toolCallId}` : `tool-anon-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** 已经告警过的未知帧类型（每类只提示一次，避免日志被同一帧刷屏）。 */
const unknownFrameTypes = new Set<string>();

/**
 * `ask` 帧的问题清单归一（V40，防御式）：omp `extension_ui_request{method:"ask"}.questions[]`
 * 每个问题至少要有 `id` 与 `question`，选项按 `label` 过滤——形状漂移时宁可少渲染一条，
 * 也不能让整张卡崩（回包按问题 id 对齐，缺 id 的项无法作答）。
 */
function askQuestionsOf(raw: unknown): AskQuestion[] | undefined {
 if (!Array.isArray(raw)) return undefined;
 const out: AskQuestion[] = [];
 for (const q of raw) {
  if (!q || typeof q !== "object") continue;
  const o = q as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : "";
  const question = typeof o.question === "string" ? o.question : "";
  if (!id || !question) continue;
  const options = Array.isArray(o.options)
   ? (o.options as unknown[]).flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    const oo = x as Record<string, unknown>;
    if (typeof oo.label !== "string") return [];
    return [
     {
      label: oo.label,
      ...(typeof oo.description === "string" ? { description: oo.description } : {}),
      ...(typeof oo.preview === "string" ? { preview: oo.preview } : {}),
     },
    ];
   })
   : [];
  out.push({
   id,
   question,
   ...(typeof o.header === "string" ? { header: o.header } : {}),
   options,
   ...(o.multi === true ? { multi: true } : {}),
   ...(typeof o.recommended === "number" ? { recommended: o.recommended } : {}),
  });
 }
 return out.length > 0 ? out : undefined;
}

/** `toolcall_*` 帧的 `partial`（当时那条完整 assistant 消息）里本次调用的那一块。
 *  omp 实测：`toolcall_start` 起就带 `{type:"toolCall", name, id, arguments, partialArgs}`。 */
function toolCallBlockOf(e: { contentIndex?: number; partial?: unknown }): Record<string, unknown> | null {
 const blocks = (e.partial as { content?: unknown[] } | undefined)?.content;
 const b = Array.isArray(blocks) ? (blocks[e.contentIndex ?? 0] as Record<string, unknown> | undefined) : undefined;
 return b && b.type === "toolCall" ? b : null;
}

/**
 * 参数还在流里（`partialArgs` 是半截 JSON）时的可读预览：取第一个字符串值的内容
 * （`{"command": "ls -la /tmp/omp…` → `ls -la /tmp/omp…`），拿不到就原样截断。
 * 整段 JSON 能解析时走 `summarizeArgs`，不走这里。
 */
function streamingArgsPreview(partialArgs: string): string {
 const s = partialArgs.trim();
 if (!s) return "";
 const m = /:\s*"((?:[^"\\]|\\.)*)/.exec(s);
 const raw = m ? m[1] : s;
 const text = raw.replace(/\\(["\\/bfnrt])/g, "$1").replace(/\\u[0-9a-fA-F]{0,4}$/, "").trim();
 return text.length > 96 ? `${text.slice(0, 96)}…` : text;
}

const folds = new Map<string, Fold>();
const sessionBuffers = new Map<string, FrameBuffer>();
/** 历史回读合并前，先提交当前会话已收到的实时帧。 */
export function flushSessionEvents(sid: string) {
 sessionBuffers.get(sid)?.flush();
}
// 消息可能在同一毫秒到达；序号在折叠态回收后也不能重用。
let userEchoSequence = 0;
/** 单测隔离用：清掉按会话累积的流式折叠态。 */
export function __resetFolds() {
 folds.clear();
}
const getFold = (sid: string): Fold => {
 let f = folds.get(sid);
 if (!f) {
  f = { textId: null, text: "", thinkingId: null, thinking: "", toolIds: {}, toolMeta: {}, startedAt: Date.now(), msgSeq: 0 };
  folds.set(sid, f);
 }
 return f;
};

/** 导出供单测回放真实事件序列（不涉及 tauri 副作用）。 */
export function frameToViewMsgs(sid: string, frame: Record<string, unknown>, dict: Text): ViewMsg[] {
 const t = frame.type as string;
 const fold = getFold(sid);
 const out: ViewMsg[] = [];
 if (t === "message_start" || t === "message_end") {
  const m = frame.message as { role?: string; content?: { type?: string; text?: string }[]; files?: unknown };
  // 每条新消息换一段 id 空间（contentIndex 在新消息里从 0 重新数，见 Fold.msgSeq）。
  // 必须在 handler 最前：`message_end` 要用同一个 msgSeq 给文本块补 id。
  if (t === "message_start") fold.msgSeq += 1;
  // @文件 提及（V2 M6b）：omp 读进上下文的文件，渲染成一排芯片。
  // id 由文件清单决定：message_start / message_end 重复推同一条消息时只出一排芯片。
  if (m?.role === "fileMention") {
   const files = mentionFilesOf(m as unknown as Record<string, unknown>);
   if (files.length > 0 && t === "message_start") {
    out.push({ kind: "files", id: `fm:${files.map((f) => f.path).join("|")}`, files });
   }
   return out;
  }
  // message_end 还有 assistant / toolResult 两套终态处理，继续走下面的分支
  if (t === "message_start" && m?.role === "user") {
   // 发送时补的附件顺序注记只给模型看：回显按同一条格式剥掉（乐观回显是原文，合并才不翻倍）
   const text = stripImageOrderNote(
    (m.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n"),
   );
   // 图片块（V2 M6）：随消息发出的图直接渲染在气泡里
   const { images, omitted } = imagesFromContent(m.content);
   out.push({
    kind: "user",
    // 前缀 `u-echo-` = 「待确认的实时回显」：omp 收到 prompt 后会把用户消息回显回来，
    // 而 Composer 发送时已乐观回显过一条 `u-local-*`。mergeViewMsgs 按同文本把本地行
    // 换成这条（换 id），不翻倍——「发一次出现两条」就是这两条各渲染了一次。
    id: `u-echo-${++userEchoSequence}`,
    text,
    mentions: [],
    ...(images.length > 0 ? { images } : {}),
    ...(omitted > 0 ? { imagesOmitted: omitted } : {}),
   });
   return out;
  }
  // developer（omp 注入的规则提醒）：落一条提醒分隔行（与历史回放同口径）——
  // 绝不进正文；只认 message_start，message_end 不重复落。
  if (t === "message_start" && m?.role === "developer") {
   const text = (m.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
   const rule = /rule="([^"]+)"/.exec(text)?.[1];
   out.push({
    kind: "divider",
    id: `${sid}:rem:${fold.msgSeq}`,
    divider: "reminder",
    text: rule ? fmt(dict.dividerRuleReminder, rule) : dict.dividerRuleReminderPlain,
   });
   return out;
  }
  if (t === "message_start") return out;
 }
 if (t === "message_update") {
  const e = frame.assistantMessageEvent as { type?: string; contentIndex?: number; delta?: string; content?: string; partial?: unknown; toolCall?: { id?: string; name?: string; arguments?: Record<string, unknown>; streamIndex?: number; intent?: string } };
  if (!e) return out;
  const key = `${sid}:${fold.msgSeq}:${e.contentIndex ?? 0}`;
  if (e.type === "text_start") {
   fold.textId = key;
   fold.text = "";
   out.push({ kind: "text", id: key, seq: 0, text: "", complete: false });
  } else if (e.type === "text_delta") {
   fold.text += e.delta ?? "";
   out.push({ kind: "text", id: key, seq: 0, text: fold.text, complete: false, __append: true } as ViewMsg);
  } else if (e.type === "text_end") {
   // 文本段完结（omp 在每条 assistant 消息里对每个文本块发一次；`content` 是全文）。
   // 不消费它的话这一行永远 `complete:false`：流式光标一直挂在已写完的段落上，
   // `hasLiveTail` 也把它当"还在输出"（「思考中…」指示行不再出现）。
   const text = e.content ?? fold.text;
   fold.textId = null;
   fold.text = "";
   if (text) out.push({ kind: "text", id: key, seq: 0, text, complete: true, __append: true } as ViewMsg);
  } else if (e.type === "thinking_start") {
   fold.thinkingId = key;
   fold.thinking = "";
   fold.startedAt = Date.now();
  } else if (e.type === "thinking_delta") {
   fold.thinking += e.delta ?? "";
   // 流式「思考中…」：首个 delta 就按同 id 推出（mergeViewMsgs 原位覆盖）。
   // 此前只在 thinking_end 落一条完成态——思考全程界面上没有任何运行迹象。
   out.push({ kind: "thinking", id: key, text: fold.thinking, seconds: 0, complete: false });
  } else if (e.type === "thinking_end") {
   const text = e.content || fold.thinking;
   // 空思考不产块（模型只发 thinking_start/end 不带内容时，此前会留下一条
   // 「思考 · 持续了 0 秒」的空块噪声）；有内容的就地落定为完成态。
   // 已经流过增量的块即使内容只剩空白也要落定，否则那一行永远停在「思考中…」。
   if (text.trim() || fold.thinkingId) {
    out.push({
     kind: "thinking",
     id: key,
     text,
     seconds: Math.max(0, Math.round((Date.now() - fold.startedAt) / 1000)),
     complete: true,
    });
   }
   fold.thinking = "";
   fold.thinkingId = null;
  } else if (e.type === "toolcall_start" || e.type === "toolcall_delta") {
   // 占位卡从**第一帧就带真名**：omp 实测 `partial`（当时那条完整 assistant 消息）
   // 在本帧的块里已含 `{type:"toolCall", name, id, args, partialArgs}`——此前占位卡
   // 写死 name "tool"，从输入到 toolcall_end 这一两秒里界面只有一行「工具 …」。
   const block = toolCallBlockOf(e);
   const blockId = block && typeof block.id === "string" && block.id ? block.id : "";
   // id 一旦从 `partial` 里拿到就记在 fold 上：后续帧即使没带 `partial` 也复用
   // 同一个 `tool:<id>`，不会另起一张占位卡。
   if (blockId) fold.toolIds[key] = `tool:${blockId}`;
   const id = fold.toolIds[key] ?? key;
   const name = block?.name ? String(block.name) : "tool";
   const args = (block?.arguments ?? {}) as Record<string, unknown>;
   const partialArgs = typeof block?.partialArgs === "string" ? block.partialArgs : "";
   out.push({
    kind: "tool",
    id,
    toolCallId: id.startsWith("tool:") ? id.slice(5) : "",
    name,
    intent: "",
    // 参数还在 JSON 串里长：能整段解析就用摘要（bash 的 command 等），否则先给可读片段；
    // 拿不到 `partial`（协议漂移）时给空摘要，合并侧会沿用旧卡里已有的那份。
    argsSummary: block ? (Object.keys(args).length > 0 ? summarizeArgs(name, args) : streamingArgsPreview(partialArgs)) : "",
    state: "streaming",
    output: "",
    streamIndex: e.contentIndex ?? 0,
    // 占位卡从 contentIndex id 换成 toolCallId id 时按 __replaceId 原位替换（同帧合并里会继承）
    ...(id !== key ? { __replaceId: key } : {}),
   } as IncomingViewMsg);
  } else if (e.type === "toolcall_end" && e.toolCall) {
   const tc = e.toolCall;
   const args = (tc.arguments ?? {}) as Record<string, unknown>;
   fold.toolMeta[tc.id ?? key] = {
    name: tc.name ?? "tool",
    intent: tc.intent ?? "",
    streamIndex: tc.streamIndex ?? 0,
   };
   // 卡 id 换成 toolCallId 版本（与历史回放 `viewMsgsFromJsonlLines` 的 `tool:<id>` 对齐），
   // 同时把之前按 contentIndex 建的"输入中"占位卡原位替换掉，避免一次调用两张卡。
   const diffStat = diffStatOf(tc.name ?? "tool", args);
   const path = primaryPathOf(tc.name ?? "tool", args);
   out.push({
    kind: "tool",
    id: tc.id ? `tool:${tc.id}` : key,
    toolCallId: tc.id ?? "",
    name: tc.name ?? "tool",
    intent: tc.intent ?? "",
    argsSummary: summarizeArgs(tc.name ?? "tool", args),
    state: "running",
    output: "",
    streamIndex: tc.streamIndex ?? 0,
    ...(diffStat ? { diffStat } : {}),
    ...(path ? { path } : {}),
    ...(tc.id ? { __replaceId: key } : {}),
   } as IncomingViewMsg);
  }
  return out;
 }
 if (t === "message_end") {
  const m = frame.message as { role?: string; content?: { type?: string; text?: string; thinking?: string }[] };
  if (m?.role === "assistant") {
   // 文本块与流式路径**共用同一个 id**（`${sid}:${msgSeq}:${contentIndex}`）：
   // `message_end.message.content` 就是流里那条文本的完整版（真机 18.8.3 实测携带全文），
   // 用 `__append` 原地补全——不这么做，deltas 已渲染一遍、这里再用随机 id 推一条就双份
   // （V1–V10 的历史缺陷，恢复时修正）。合并侧只更新同 id 的行（已完成的行不被增量帧重开）。
   const blocks = m.content ?? [];
   for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "text" && b.text) {
     out.push({
      kind: "text",
      id: `${sid}:${fold.msgSeq}:${i}`,
      seq: 0,
      text: b.text,
      complete: true,
      __append: true,
     } as IncomingViewMsg);
    }
   }
  }
  if (m?.role === "toolResult") {
   const text = (m.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
   const isDenied = text.includes("denied by user");
   const isError = (frame.message as { isError?: boolean }).isError === true;
   const tcId = (frame.message as { toolCallId?: string }).toolCallId ?? "";
   out.push({
    kind: "tool",
    // 与 toolcall_end / tool_execution_* 共用一个 id：同一次调用只有一张卡，
    // 终态就地覆盖（早前那张 running 卡不会残留成"永远转圈"）。
    id: toolCardId(tcId),
    toolCallId: tcId,
    name: (frame.message as { toolName?: string }).toolName ?? "tool",
    intent: "",
    argsSummary: "",
    // 拒绝分支统一渲染成 dict.toolDenied（omp 回的是英文 "Tool call denied by user: xxx"）
    state: isDenied || isError ? "error" : "ok",
    output: isDenied ? dict.toolDenied : text.length > 2000 ? text.slice(0, 2000) : text,
    outputFull: !isDenied && text.length > 2000 && text.length <= TOOL_OUTPUT_FULL_MAX ? text : undefined,
    streamIndex: 0,
   });
  }
  return out;
 }
 if (t === "tool_execution_start") {
  const meta = fold.toolMeta[String(frame.toolCallId ?? "")];
  const name = String(frame.toolName ?? meta?.name ?? "tool");
  const args = (frame.args as Record<string, unknown>) ?? {};
  const diffStat = diffStatOf(name, args);
  const path = primaryPathOf(name, args);
  out.push({
   kind: "tool",
   id: toolCardId(String(frame.toolCallId ?? "")),
   toolCallId: String(frame.toolCallId ?? ""),
   name,
   intent: String(frame.intent ?? meta?.intent ?? ""),
   argsSummary: summarizeArgs(name, args),
   state: "running",
   output: "",
   streamIndex: meta?.streamIndex ?? 0,
   ...(diffStat ? { diffStat } : {}),
   ...(path ? { path } : {}),
  });
  return out;
 }
 if (t === "tool_execution_end") {
  const result = frame.result as { content?: { type?: string; text?: string }[] };
  const text = (result?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
  const denied = text.includes("denied by user");
  out.push({
   kind: "tool",
   id: toolCardId(String(frame.toolCallId ?? "")),
   toolCallId: String(frame.toolCallId ?? ""),
   name: String(frame.toolName ?? "tool"),
   intent: "",
   argsSummary: "",
   state: frame.isError || denied ? "error" : "ok",
   output: denied ? dict.toolDenied : text.length > 2000 ? text.slice(0, 2000) : text,
   outputFull: !denied && text.length > 2000 && text.length <= TOOL_OUTPUT_FULL_MAX ? text : undefined,
   streamIndex: 0,
  });
  return out;
 }
 if (t === "extension_ui_request") {
  const method = frame.method as string;
  // 服务端撤回（请求被 abort / 超时）：撤掉卡片，别留下点不动的死卡
  if (method === "cancel") {
   const target = String(frame.targetId ?? "");
   if (target) out.push({ kind: "ui-cancel", id: `uic-${target}`, uiId: target });
   return out;
  }
  // 单向通知：不需要用户回包。notify 给一行分隔线，其余（setStatus / setWidget /
  // setTitle / set_editor_text）是宿主 UI 指令，桌面壳不实现，静默丢弃且不告警。
  if (method === "notify") {
   out.push({ kind: "divider", id: `n-${String(frame.id)}`, divider: "turn", text: String(frame.message ?? "") });
   return out;
  }
  if (method === "setStatus" || method === "setWidget" || method === "setTitle" || method === "set_editor_text") {
   return out;
  }
  const options = Array.isArray(frame.options) ? (frame.options as unknown[]).map(String) : [];
  // 审批是 select 的专用分支（options 含 Approve）：走 ApprovalCard，
  // 「总是允许」还要写会话级 yolo 意向，语义与通用 UI 回包不同。
  // options 缺失的 select 也按审批兜底（宁可让用户决定，也不静默丢一个请求）。
  if (method === "select" && (options.length === 0 || options.includes("Approve"))) {
   out.push({
    kind: "approval",
    id: `ap-${String(frame.id)}`,
    uiId: String(frame.id),
    toolName: "",
    command: "",
    cwd: "",
    title: String(frame.title ?? dict.approvalTitle),
   });
   return out;
  }
  // 其余交互方法：confirm / input / editor / 非审批 select / ask（V40 多问题卡），统一走 UiRequestCard，
  // 回包由后端 respond_ui 按方法组装（confirm 回 {confirmed}，input/editor/select 回 {value}，
  // ask 回 {answers}——见 Composer 之外的 UiRequestCard 提交路径）。
  if (method === "confirm" || method === "input" || method === "editor" || method === "select" || method === "ask") {
   const questions = askQuestionsOf(frame.questions);
   out.push({
    kind: "ui",
    id: `ui-${String(frame.id)}`,
    uiId: String(frame.id),
    method,
    title: String(frame.title ?? ""),
    ...(typeof frame.message === "string" ? { message: frame.message } : {}),
    ...(typeof frame.placeholder === "string" ? { placeholder: frame.placeholder } : {}),
    ...(typeof frame.prefill === "string" ? { prefill: frame.prefill } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(Array.isArray(frame.optionDetails) ? { optionDetails: (frame.optionDetails as unknown[]).map((d) => (typeof d === "string" ? d : null)) } : {}),
    ...(questions ? { questions } : {}),
    ...(typeof frame.timeout === "number" && frame.timeout > 0 ? { timeout: frame.timeout } : {}),
   });
  }
  return out;
 }
 if (t === "model_changed" || t === "thinking_level_changed") {
  // 口径同历史回放（viewmsg.ts 的 userSeen）：会话还没有用户消息时，模型 / 思考档变更
  // 不是「会话中切换」（切模型的档位自动跟进也走这条线），不渲染分隔线。
  const hasUser = (useApp.getState().eventsBySession[sid] ?? []).some((m) => m.kind === "user");
  if (hasUser) {
   out.push({
    kind: "divider",
    id: `d-${Date.now()}`,
    divider: t === "model_changed" ? "model" : "thinking",
    text:
     t === "model_changed"
      ? dict.dividerModel
      : fmt(dict.dividerThinking, String(frame.thinkingLevel ?? "")),
   });
  }
  return out;
 }
 if (t === "response") {
  const cmd = frame.command as string;
  if (frame.success === false) {
   out.push({ kind: "divider", id: `e-${Date.now()}`, divider: "exit", text: fmt(dict.opFailedDetail, cmd, String(frame.error ?? "")) });
  }
  return out;
 }
 // 本地命令输出（`/` 命令经 prompt 直发，无 agent turn）：
 // 后端已把状态收敛到 idle，此处渲染输出文本。
 // 字段名以真机为准：omp 18.2.1 发的是 `text`（`output` 是早期 canned 脚本的形状，一并兼容）。
 if (t === "command_output") {
  const text = String(
   (frame as Record<string, unknown>).text ?? (frame as Record<string, unknown>).output ?? "",
  );
  if (text) out.push({ kind: "command", id: `cmd-${String(frame.id ?? Date.now())}`, output: text });
  return out;
 }
 // 本地命令完成信号（`prompt_result{agentInvoked:false}`）：无输出就不渲染，
 // 状态机已由后端收敛，此处只消化帧、不告警。
 if (t === "prompt_result") return out;
 // 任务清单帧（`todo_reminder` 提醒 / `todo_auto_clear` 清理）：**不进消息流**——
 // 真值由 handler 写 `plansBySession`（浮卡 / 右栏「进度」区块展示）。上游
 // `todo_reminder` 是「未完成项提醒」（`{todos,attempt,maxAttempts}`），不带阶段清单。
 if (t === "todo_reminder" || t === "todo_auto_clear") return out;
 // 单向通知：`notice` 给一行分隔线。
 if (t === "notice" || t === "irc_message") {
  const text = String((frame as Record<string, unknown>).message ?? "");
  if (text) out.push({ kind: "divider", id: `n-${Date.now()}`, divider: "turn", text });
  return out;
 }
 // 压缩 / 重试 / 子代理的生命周期帧：给一行分隔线，不进消息计数。
 if (
  t === "auto_compaction_start" ||
  t === "auto_compaction_end" ||
  t === "auto_retry_start" ||
  t === "auto_retry_end" ||
  t === "retry_fallback_applied" ||
  t === "retry_fallback_succeeded"
 ) {
  const label =
   t === "auto_compaction_start"
    ? dict.dividerCompacting
    : t === "auto_compaction_end"
     ? dict.dividerCompacted
     : t === "auto_retry_start"
      ? dict.dividerRetrying
      : t === "auto_retry_end"
       ? dict.dividerRetryEnd
       : t === "retry_fallback_applied"
        ? dict.dividerFallbackRetry
        : dict.dividerFallbackOk;
  out.push({ kind: "divider", id: `${t}-${Date.now()}`, divider: "turn", text: label });
  return out;
 }
 // 子代理帧（task 工具 spawn 的子会话；订阅在 spawn 握手时打开，见 runtime.rs）：
 // lifecycle 起止各落一行；progress / event 是高频帧（每次工具推进都会来），
 // 不逐条渲染——否则一次并行调研能刷出几十行子代理分隔线。
 if (t === "subagent_lifecycle") {
  const p = (frame.payload ?? {}) as Record<string, unknown>;
  const agent = String(p.agent ?? "").trim() || "?";
  const status = String(p.status ?? "");
  const desc = typeof p.description === "string" ? p.description.trim() : "";
  const text =
   status === "started"
    ? desc
     ? fmt(dict.dividerSubagentStartedWith, agent, desc)
     : fmt(dict.dividerSubagentStarted, agent)
    : status === "completed"
     ? fmt(dict.dividerSubagentDone, agent)
     : status === "failed"
      ? fmt(dict.dividerSubagentFailed, agent)
      : fmt(dict.dividerSubagentAborted, agent);
  // id 带 status：同一次 spawn 的 started / completed 是两条独立消息（mergeViewMsgs 按 id 去重）
  out.push({ kind: "divider", id: `sub-${String(p.id ?? "")}-${status || "unknown"}`, divider: "subagent", text });
  return out;
 }
 if (t === "subagent_progress" || t === "subagent_event") return out;
 if (t === "turn_start" || t === "turn_end" || t === "agent_start" || t === "agent_end") return out;
 // 会话标题变更，两种来源都消费：
 // - `session_info_update`（omp 原生命令改了标题——壳侧的自动补标题走 `/rename`，实测
 //   18.10.3 的 rpc-ui 就发这个帧，带 `title`）；
 // - `title_change`（jsonl 事件，TUI 侧自动标题 / 改名的历史回放里有；rpc 实时流不发）。
 // 只更新 store.sessions 里该会话的标题（备注 note 优先的口径在后端 display_title，实时帧
 // 里没有 note 上下文：已有备注的会话不覆盖备注显示——TopBar 取 title 字段，备注优先已由后端落定）。
 if (t === "title_change" || t === "session_info_update") {
  const title = typeof frame.title === "string" ? frame.title.trim() : "";
  const st = useApp.getState();
  const cur = st.sessions.find((s) => s.id === sid);
  // 有备注的会话标题显示的是备注（display_title 口径），实时标题不该覆盖它；空标题帧忽略
  if (title && cur && !cur.note?.trim()) {
   st.set({ sessions: st.sessions.map((s) => (s.id === sid ? { ...s, title } : s)) });
  }
  return out;
 }
 // 其余未知帧：忽略不崩，但每个类型只告警一次（M4 协议漂移 guard——
 // omp 大版本升级后事件名对不上时，日志里能直接看出来是哪一类帧变了）。
 if (!unknownFrameTypes.has(t)) {
  unknownFrameTypes.add(t);
  console.warn(`[omp] 未知事件类型（已忽略，仅提示一次）：${t}`, frame);
 }
 return out;
}

/**
 * todo 工具帧的全量清单（`details.phases`）：`tool_execution_end`（`result.details`）与
 * `message_end{role:"toolResult"}`（`message.details`）两路同形（omp 18.10.4 实测）；
 * 其余帧 / 形状漂移一律 null（宁可不动，也不拿半截数据覆盖既有清单）。
 * 导出供单测回放真实帧形状。
 */
export function todoPhasesOf(p: Record<string, unknown>): TodoPhase[] | null {
 const t = p.type;
 let holder: Record<string, unknown> | undefined;
 if (t === "tool_execution_end") {
  if (String(p.toolName ?? "") !== "todo") return null;
  holder = p.result as Record<string, unknown> | undefined;
 } else if (t === "message_end") {
  const m = p.message as Record<string, unknown> | undefined;
  if (String(m?.toolName ?? "") !== "todo") return null;
  holder = m;
 } else {
  return null;
 }
 const phases = (holder?.details as Record<string, unknown> | undefined)?.phases;
 return Array.isArray(phases) ? (phases as TodoPhase[]) : null;
}

/**
 * 把 omp 回读的运行时真值落到 store：模型 + 思考档。
 * 档位非法/缺失（实测场景：切到无思考模型会丢掉档位，且切回来不会自动恢复）→ 归一到
 * **omp 配置的默认档**（`defaultThinkingLevel` 夹到支持集，见 `lib/thinkingDefault.ts`）并下发纠正。
 */
function applyRuntime(sid: string, rt: SessionRuntime) {
 const efforts = rt.efforts ?? null;
 const { level, shouldSync } = resolveThinking(efforts, rt.thinkingLevel, useApp.getState().ompDefaultThinking);
 useApp.setState((s) => ({
  currentEfforts: efforts,
  currentRuntime: rt,
  ...(rt.model ? { currentModel: `${rt.model.provider}/${rt.model.id}` } : {}),
  currentThinking: level,
  // 活动态真值（只有回读带）：补回「切走期间错过」的状态事件——不补的话，切回一个正在跑的
  // 会话会显示成 idle：流式「思考中」指示不出现，输入框还会把下一句当新 prompt 发出去
  // （运行中应当走 follow_up / steer，普通 prompt 会打断进行中的轮次）。
  ...(rt.status ? { statusBySession: { ...s.statusBySession, [sid]: { state: rt.status } as SessionStatus } } : {}),
 }));
 // 任务清单真值（浮卡数据源）：数组即覆盖——空数组 = 已清空（浮卡退场）；
 // `null` / 缺字段不动（帧路径已写的清单不被回读抹掉）。
 if (Array.isArray(rt.todoPhases)) useApp.getState().applyPlans(sid, rt.todoPhases);
 if (shouldSync && useApp.getState().activeSessionId === sid) {
  void api.setThinking(sid, level).catch(() => undefined);
 }
 // 队列真值（V40）：`get_state.queuedMessages` / omp-state 推送里带 steering / followUp 快照，
 // 落在 store（`queue_update` 帧是实时权威，这里是回读兜底——切走期间的队列变化靠它补回）。
 if (rt.queuedMessages) {
  useApp.getState().applyQueue(sid, {
   steering: rt.queuedMessages.steering ?? [],
   followUp: rt.queuedMessages.followUp ?? [],
  });
 }
}

/**
 * 命令面刷新：只替换 `currentRuntime.commands`，别的字段原样留着
 * （`applyRuntime` 是整块覆盖，拿它更新命令面会顺手抹掉刚推来的模型 / 档位 / 用量）。
 * 运行时真值还没到位时直接丢弃——那种情况下 `syncSessionRuntime` 的补拉会带上命令面
 * （后端 `SessionMeta.commands` 早已缓存），不必在这里另存一份。
 */
function applyCommands(sid: string, raw: unknown) {
 const st = useApp.getState();
 if (st.activeSessionId !== sid || !st.currentRuntime) return;
 useApp.setState({ currentRuntime: { ...st.currentRuntime, commands: normalizeCommands(raw) } });
}

/**
 * 补拉一次运行时真值（模型 / 思考档 / 上下文占用 / 命令面）。
 *
 * 两个调用点，缺一不可：订阅建立时（消除「推送早于订阅」的竞态）与 `open_session`
 * 返回之后（消除「补拉早于 spawn 完成」的竞态——resume 的长驻进程是在 open 里起的，
 * 订阅那次补拉必然拉空）。不是当前会话的包不动，避免切走之后被旧会话覆盖。
 */
export async function syncSessionRuntime(sid: string): Promise<void> {
 try {
  const rt = await api.getSessionRuntime(sid);
  if (rt && useApp.getState().activeSessionId === sid) applyRuntime(sid, rt);
 } catch {
  // 拉不到不影响阅读：会话内的推送与下一次回读会补
 }
}

// ---------- 非活跃会话历史的内存治理（V34） ----------

/** 内存里保留最近几个「打开过」的会话的完整历史（超出即清，切回时重新拉）。 */
const KEEP_HISTORY = 3;

/** 最近激活过的会话（新的在前）——历史清理的保留名单。 */
let recentHistoryIds: string[] = [];

/** 单测隔离用：清掉 LRU 记录。 */
export function __resetHistoryLru() {
 recentHistoryIds = [];
}

/**
 * 把「非活跃会话」的历史从内存里清掉（保留最近 `keep` 个激活过的）。
 *
 * 为什么需要：`eventsBySession` 里每个**打开过**的会话都会留下全量消息（工具全量
 * 输出文本也在里面），浏览十来个长会话就是几百 MB 到 GB 级的常驻内存。
 * 清掉是安全的——切回会话时 `openSessionWithHistory` 会重新读取最新一页。
 *
 * 正在跑 / 等审批的会话不动：它们的流还在写，用户随时可能切回去看中间态。
 */
export function trimSessionHistories(activeId: string | null, keep = KEEP_HISTORY): void {
 if (activeId) recentHistoryIds = [activeId, ...recentHistoryIds.filter((x) => x !== activeId)];
 recentHistoryIds = recentHistoryIds.slice(0, Math.max(1, keep));
 const keepSet = new Set(recentHistoryIds);
 const st = useApp.getState();
 let changed = false;
 const next: Record<string, ViewMsg[]> = {};
 const historyPages = { ...st.historyPages };
 for (const [sid, msgs] of Object.entries(st.eventsBySession)) {
  const running = st.statusBySession[sid]?.state;
  if (keepSet.has(sid) || running === "running" || running === "awaiting-approval") {
   next[sid] = msgs;
  } else {
   changed = true;
   folds.delete(sid);
   delete historyPages[sid];
  }
 }
 for (const sid of Object.keys(historyPages)) {
  const running = st.statusBySession[sid]?.state;
  if (!keepSet.has(sid) && running !== "running" && running !== "awaiting-approval") {
   delete historyPages[sid];
   changed = true;
  }
 }
 if (changed) st.set({ eventsBySession: next, historyPages });
}

/**
 * 会话被归档 / 删除后清掉它的前端缓存（事件流 / 运行状态 / 计划 / 附件 / 折叠态 / LRU 名单 /
 * 会话统计快照）。
 * 清掉是安全的：会话数据的真相在 jsonl，重新打开走 `get_history`。
 * 归档 / 删除都会先把长驻进程 kill 掉（后端），前端也就没有理由再留着这些。
 */
export function forgetSession(sid: string): void {
 folds.delete(sid);
 recentHistoryIds = recentHistoryIds.filter((x) => x !== sid);
 // 统计条的模块级快照（不在 store 里，得单独清）：不清的话，同名会话重新出现会先闪一次旧读数
 forgetSessionLiveStats(sid);
 const st = useApp.getState();
 if (
  !(sid in st.eventsBySession) &&
  !(sid in st.historyPages) &&
  !(sid in st.statusBySession) &&
  !(sid in st.plansBySession) &&
  !(sid in st.planCardBySession) &&
  !(sid in st.planDismissedBySession) &&
  !(sid in st.attachmentsBySession) &&
  !(sid in st.queuedBySession) &&
  !(sid in st.queueRestoreWarnings) &&
  !(sid in st.subagentsBySession)
 ) {
  return;
 }
 const events = { ...st.eventsBySession };
 const historyPages = { ...st.historyPages };
 const status = { ...st.statusBySession };
 const plans = { ...st.plansBySession };
 const planCards = { ...st.planCardBySession };
 const planDismissed = { ...st.planDismissedBySession };
 const atts = { ...st.attachmentsBySession };
 const queued = { ...st.queuedBySession };
 const queueWarnings = { ...st.queueRestoreWarnings };
 const subs = { ...st.subagentsBySession };
 delete events[sid];
 delete historyPages[sid];
 delete status[sid];
 delete plans[sid];
 delete planCards[sid];
 delete planDismissed[sid];
 delete atts[sid];
 delete queued[sid];
 delete queueWarnings[sid];
 delete subs[sid];
 st.set({
  eventsBySession: events,
  historyPages,
  statusBySession: status,
  plansBySession: plans,
  planCardBySession: planCards,
  planDismissedBySession: planDismissed,
  attachmentsBySession: atts,
  queuedBySession: queued,
  queueRestoreWarnings: queueWarnings,
  subagentsBySession: subs,
  // 旁问面板正开着这个会话时一并关掉（记录属于会话，不跨会话残留）
  ...(st.btw.sessionId === sid ? { btw: { open: false, sessionId: null, records: [], busyRecordId: null, draft: "", error: null } } : {}),
 });
}

/** 旁问话题的「最新一轮」：有 followUps 取最后一项，否则是话题本身（omp 口径）。 */
export function latestBtwTurn(r: BtwRecord): BtwTurn {
 const fus = r.followUps ?? [];
 return fus.length > 0 ? fus[fus.length - 1] : r;
}

/**
 * 旁问帧（V40）的落点：`btw_record` 全量替换该话题（开始 / 完成 / 失败各一帧，
 * 后到覆盖先到）、`btw_delta` 把增量追加到该话题的「最新一轮」。
 * 只处理面板当前打开的会话（关掉后重开会 `getBtwHistory` 拉全量，帧不必缓存）。
 */
function applyBtwFrame(sid: string, p: Record<string, unknown>) {
 const st = useApp.getState();
 if (!st.btw.open || st.btw.sessionId !== sid) return;
 if (p.type === "btw_record") {
  const raw = p.record as Record<string, unknown> | undefined;
  if (!raw || typeof raw.id !== "string") return;
  const rec = raw as unknown as BtwRecord;
  const records = st.btw.records.some((x) => x.id === rec.id)
   ? st.btw.records.map((x) => (x.id === rec.id ? rec : x))
   : [rec, ...st.btw.records];
  const running = latestBtwTurn(rec).status === "running";
  useApp.getState().setBtw({
   records,
   busyRecordId: running ? rec.id : st.btw.busyRecordId === rec.id ? null : st.btw.busyRecordId,
  });
  return;
 }
 if (p.type === "btw_delta") {
  const rid = typeof p.recordId === "string" ? p.recordId : "";
  const delta = typeof p.delta === "string" ? p.delta : "";
  if (!rid || !delta) return;
  useApp.getState().setBtw({
   records: st.btw.records.map((x) => {
    if (x.id !== rid) return x;
    const fus = x.followUps ?? [];
    if (fus.length === 0) return { ...x, answer: x.answer + delta };
    const last = fus[fus.length - 1];
    return { ...x, followUps: [...fus.slice(0, -1), { ...last, answer: last.answer + delta }] };
   }),
  });
 }
}

/** 「执行模式切换等生效」的挂起重启集合（重启期间的 exited 状态不上屏）。 */
const restartingSids = new Set<string>();

/** 已完成三个事件通道注册的会话；身份迁移后发送必须等新监听建立。 */
const readySessionListeners = new Set<string>();
const listenerWaiters = new Map<string, Set<() => void>>();

export async function waitForSessionListeners(sid: string): Promise<void> {
 if (!readySessionListeners.has(sid) || useApp.getState().activeSessionId !== sid) await new Promise<void>((resolve, reject) => {
  const finish = (error?: Error) => {
   clearTimeout(timer);
   unsubscribe();
   const waiters = listenerWaiters.get(sid);
   waiters?.delete(ready);
   if (waiters?.size === 0) listenerWaiters.delete(sid);
   if (error) reject(error);
   else resolve();
  };
  const ready = () => finish();
  const unsubscribe = useApp.subscribe((state) => {
   if (state.activeSessionId !== sid) finish(new Error(TEXT[state.locale].sessionSwitchedBeforeSend));
  });
  const timer = setTimeout(() => finish(new Error(TEXT[useApp.getState().locale].sessionListenerNotReady)), 10000);
  const waiters = listenerWaiters.get(sid) ?? new Set();
  waiters.add(ready);
  listenerWaiters.set(sid, waiters);
  if (useApp.getState().activeSessionId !== sid) finish(new Error(TEXT[useApp.getState().locale].sessionSwitchedBeforeSend));
  else if (readySessionListeners.has(sid)) finish();
 });
 if (isRemoteClient()) await new Promise<void>((resolve, reject) => {
  let finished = false;
  let unsubscribe = () => {};
  const timer = setTimeout(() => finish(false), 10000);
  const finish = (ready: boolean) => {
   if (finished) return;
   finished = true;
   clearTimeout(timer);
   unsubscribe();
   if (ready && useApp.getState().activeSessionId === sid) resolve();
   else reject(new Error(TEXT[useApp.getState().locale].sessionListenerNotReady));
  };
  unsubscribe = onRemoteConnection((state) => {
   if (state === "open") finish(true);
   else if (state === "unauthorized") finish(false);
  });
  if (finished) unsubscribe();
 });
}

/**
 * 重启会话 runtime 让会话级执行模式切换即时生效（V40）：Shift+Tab 在 idle 时直接调它，
 * running 时由挂起标记在转为 idle 后自动调；kill 的 exited 中间态被屏蔽。
 * 失败（BUSY = 用户在重启前又发了消息）静默——退回「下次会话生效」，不打扰。
 */
export async function restartRuntimeForApproval(sid: string): Promise<void> {
 restartingSids.add(sid);
 let actual = sid;
 try {
  const opened = await api.restartSessionRuntime(sid);
  actual = opened.id;
  if (actual !== sid) {
   const st = useApp.getState();
   const sessions = st.sessions.some((s) => s.id === actual)
    ? st.sessions.map((s) => s.id === actual ? opened : s)
    : [opened, ...st.sessions];
   if (st.activeSessionId === sid && !st.settingsTabActive) {
    if (!transferEditorDraft(sid, actual)) {
     const text = st.draftOf(sid);
     const images = st.attachmentsOf(sid);
     const occupied = new Set(st.attachmentsOf(actual).map((image) => image.slot));
     const assigned = st.addAttachments(actual, images.map((image) => occupied.has(image.slot) ? { ...image, slot: undefined } : image));
     const mapped = images.length ? restoreImageOrder(withImageOrderNote(text, images), assigned) : text;
     const current = st.draftOf(actual);
     const merged = current.trim() && mapped.trim() ? `${current}\n\n${mapped}` : current + mapped;
     st.setDraft(actual, merged);
     st.setDraft(sid, "");
     st.clearAttachments(sid);
     try {
      const raw = localStorage.getItem("omp.drafts.v1");
      const drafts = (raw ? JSON.parse(raw) : {}) as Record<string, string>;
      delete drafts[sid];
      if (merged) drafts[actual] = merged;
      else delete drafts[actual];
      localStorage.setItem("omp.drafts.v1", JSON.stringify(drafts));
     } catch { /* 草稿仍保留在内存中 */ }
    }
    st.set({ sessions, activeSessionId: actual });
    if (!useApp.getState().eventsBySession[actual]?.some((m) => m.id === "fork-note")) {
     useApp.getState().appendEvents(actual, [{ kind: "divider", id: "fork-note", divider: "reminder", text: TEXT[st.locale].dividerSessionForked }]);
    }
    if (isRemoteClient() && location.hash === `#/s/${sid}`) {
     history.replaceState(null, "", `#/s/${actual}`);
     window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
    const { openSessionWithHistory } = await import("./sessionOpen");
    if (useApp.getState().activeSessionId === actual && !useApp.getState().settingsTabActive) await openSessionWithHistory(actual, opened);
   } else {
    st.set({ sessions });
   }
  }
 } catch {
  // 静默：BUSY / 进程不可用都退回「下次会话生效」
 } finally {
  restartingSids.delete(sid);
  void syncSessionRuntime(actual);
 }
}

/**
 * `subagent_lifecycle` 帧的 payload / `get_subagents` 的条目 → 注册表条目（V41）。
 * 缺 id / agent 的帧丢弃（形状漂移时宁可少一条，不让整列崩）。
 */
function subagentFromFrame(payload: unknown): SubAgentInfo | null {
 if (!payload || typeof payload !== "object") return null;
 const p = payload as Record<string, unknown>;
 const id = typeof p.id === "string" ? p.id : "";
 const agent = typeof p.agent === "string" ? p.agent : "";
 if (!id || !agent) return null;
 const st = typeof p.status === "string" ? p.status : "";
 const status: SubAgentInfo["status"] =
  st === "completed" ? "completed" : st === "failed" ? "failed" : st === "aborted" ? "aborted" : "running";
 return { id, agent, description: typeof p.description === "string" ? p.description : "", status };
}

/**
 * 补拉子代理注册表（V41；打开会话 / 订阅建立时调一次）：
 * `get_subagents` 的 `{subagents:[…]}` 落 store（帧路径是实时权威，这里是切走期间的兜底）。
 */
export async function syncSubagents(sid: string): Promise<void> {
 try {
  const data = await api.getSubagents(sid);
  const st = useApp.getState();
  if (st.activeSessionId !== sid) return;
  const list: SubAgentInfo[] = (Array.isArray(data?.subagents) ? (data.subagents as unknown[]) : [])
   .map((x) => subagentFromFrame(x))
   .filter((x): x is SubAgentInfo => !!x);
  st.setSubagents(sid, list);
 } catch {
  // 拉不到不影响：帧路径照常工作
 }
}

export function useSessionEvents() {
 const { activeSessionId, set } = useApp();

 useEffect(() => {
   const sid = activeSessionId;
   if (!sid) return;
   // 手机 PWA 走 WebSocket；桌面端仍是 Tauri 事件。**在 effect 里判定**：
   // 移动端入口在渲染前才设置 `__OMP_REMOTE__`，模块加载期不能缓存这个开关。
   const listen = isRemoteClient() ? remoteListen : tauriListen;
   // 内存治理：非活跃会话的历史只留最近 K 个（更早的清掉，切回时重新 get_history 拉回）
   trimSessionHistories(sid);
  let off1: (() => void) | undefined;
  let off2: (() => void) | undefined;
  let off3: (() => void) | undefined;
  let offRe: (() => void) | undefined;
  // `listen` 是异步注册的：cleanup 先于注册完成时必须把「已在路上」的监听立刻解掉，
  // 否则监听器泄漏（旧会话的帧会一直写进 store）。
  let disposed = false;
  // 切会话先清运行时态，等真值回填（避免沿用上一个会话的模型/档位/用量）
  set({ currentModel: null, currentThinking: null, currentEfforts: null, currentRuntime: null });
  // 流式帧的 rAF 合并缓冲（V37）：同一渲染帧窗口内的多个 delta 合并成一次 store 写入
  // （每帧一次 setState + 全量 Markdown 重渲染会让长回复越写越卡）；切会话时丢弃
  // 未 flush 的帧——内容真相在 jsonl，切回时 `get_history` 会全量重拉。
  const buffer = createStreamBuffer((batch) => {
   // 已切走：丢弃（rAF 可能在 dispose 之后才触发）
   if (disposed) return;
   const st = useApp.getState();
   const cur = st.eventsBySession[sid] ?? [];
   st.set({ eventsBySession: { ...st.eventsBySession, [sid]: mergeViewMsgs(cur, batch) } });
  });
  sessionBuffers.set(sid, buffer);
  (async () => {
   const o1 = await listen<Record<string, unknown>>(IPC.chatEvent(sid), (e) => {
    const p = e.payload;
    // 命令面变化（装/卸技能与扩展时 omp 会重发）：只更新运行时真值，不进消息流。
    // 握手期那一发通常早于本订阅，所以 `syncSessionRuntime` 的补拉才是第一次到位的路径，
    // 这里管的是"会话开着时命令面又变了"。
    if (p?.type === "available_commands_update") {
     applyCommands(sid, p.commands);
     return;
    }
    // 队列快照（V40）：omp 的队列真值（steering / followUp 芯片文本），驱动待发区。
    // ack 后立即到达、撤回 / 提升 / 投递各推一次（服务端合并去重）——不做本地对账。
    if (p?.type === "queue_update") {
     useApp.getState().applyQueue(sid, {
      steering: Array.isArray(p.steering) ? (p.steering as unknown[]).map(String) : [],
      followUp: Array.isArray(p.followUp) ? (p.followUp as unknown[]).map(String) : [],
     });
     return;
    }
    // 旁问帧（V40）：面板开着本会话时消费（关掉后重开会拉全量历史，帧不必缓存）。
    if (p?.type === "btw_record" || p?.type === "btw_delta") {
     applyBtwFrame(sid, p);
     return;
    }
    // 子代理生命周期（V41）：先 upsert 注册表（面板数据源），帧本身继续走归一（消息流里的分隔线）。
    if (p?.type === "subagent_lifecycle") {
     const info = subagentFromFrame(p.payload);
     if (info) useApp.getState().upsertSubagent(sid, info);
    }
    // 任务清单真值（浮卡 / 右栏「进度」区块的数据源）：todo 工具结束帧与
    // `message_end{toolResult}` 都带全量 `details.phases`（omp 18.10.4 实测）——
    // 实时写入不等 `get_state` 回读节流；`todo_auto_clear`（清理）帧收到即清空。
    const todoPhases = todoPhasesOf(p);
    if (todoPhases) useApp.getState().applyPlans(sid, todoPhases);
    else if (p?.type === "todo_auto_clear") useApp.getState().applyPlans(sid, []);

    // 语言按帧到达时刻取：切语言后新帧立刻用新语言，已渲染的旧分隔线要重开会话才换。
    // 同一批帧统一打到达时刻（v2 轮时长行的实时来源；历史回放的时间来自 jsonl timestamp）。
    const nowMs = Date.now();
    const msgs = frameToViewMsgs(sid, p, TEXT[useApp.getState().locale]).map((m) =>
     m.at != null ? m : { ...m, at: nowMs },
    ) as IncomingViewMsg[];
    // 统一走合并管线：帧先入缓冲（同 id 折叠），flush 时再经 mergeViewMsgs 落 store
    // （text 流式同 id 覆盖、工具卡同 id 原位合并，避免一次调用渲染成多张卡）。
    buffer.push(msgs);
   });
   if (disposed) {
    o1();
    return;
   }
   off1 = o1;
   const o2 = await listen<SessionStatus & { detail?: string }>(IPC.chatStatus(sid), (e) => {
    // 执行模式切换的挂起重启（V40）：kill 触发的 exited 是重启的正常中间态，
    // 不当「会话退出」上屏（新进程随后会推 idle）。
    if (restartingSids.has(sid) && e.payload.state === "exited") return;
    const st = useApp.getState();
    set({
     statusBySession: { ...st.statusBySession, [sid]: { state: e.payload.state } as SessionStatus },
    });
    // 转为 idle 且挂着「执行模式切换等生效」→ 自动重启 runtime（BUSY 时静默放弃）
    if (e.payload.state === "idle") {
     // 活干完（running → idle 的翻转那一下）= agent 刚把文件写完的时刻：本会话目录的 git 快照
     // （提交键的改动状态 / 左栏徽章）跟着重读一次，别等 30s 兜底轮询——分支上「再有改动」要
     // 立刻看得见。只认翻转（重复 idle 帧不刷）；只刷本会话目录（别的目录这一轮没被动过）。
     if (st.statusBySession[sid]?.state !== "idle") {
      const cwd = st.sessions.find((x) => x.id === sid)?.cwd;
      if (!isRemoteClient()) scheduleWorkspaceGitRefresh(cwd ? [cwd] : undefined);
     }
     if (st.approvalRestartBySession[sid]) {
      st.clearApprovalRestart(sid);
      void restartRuntimeForApproval(sid);
     }
    }
   });
   if (disposed) {
    o2();
    return;
   }
   off2 = o2;
   // 运行时真值：实时推送 + 订阅建立后补拉一次（spawn 握手可能早于本订阅；
   // 若本订阅早于 spawn，则由 `openSessionWithHistory` 在 open 返回后再补一次）
   const o3 = await listen<SessionRuntime>(IPC.chatRuntime(sid), (e) => applyRuntime(sid, e.payload));
   if (disposed) {
    o3();
    return;
   }
   off3 = o3;
   readySessionListeners.add(sid);
   for (const ready of listenerWaiters.get(sid) ?? []) ready();
   void syncSessionRuntime(sid);
   // 子代理注册表补拉（V41）：与运行时真值同一次订阅建立时到位
   void syncSubagents(sid);
   // 手机端重连/打开会话时补拉「错过的审批」：审批帧不在 jsonl 里，只靠实时流会永久丢。
   const loadPending = () => {
    void remotePending(sid)
     .then((frames) => {
      if (disposed || useApp.getState().activeSessionId !== sid) return;
      const st = useApp.getState();
      const have = new Set((st.eventsBySession[sid] ?? []).map((m) => m.id));
      const dict = TEXT[st.locale];
      const rows = frames.flatMap((f) => frameToViewMsgs(sid, f, dict)).filter((m) => !have.has(m.id));
      if (rows.length > 0) st.appendEvents(sid, rows);
     })
     .catch(() => undefined);
   };
   if (isRemoteClient()) {
    loadPending();
    offRe = onRemoteReconnected(() => {
     loadPending();
     void syncSessionRuntime(sid);
    });
   }
  })();
  return () => {
   disposed = true;
   readySessionListeners.delete(sid);
   if (sessionBuffers.get(sid) === buffer) sessionBuffers.delete(sid);
   // 未 flush 的帧随会话切走一起丢弃（切回时 get_history 全量重拉，不丢内容）
   buffer.dispose();
   off1?.();
   off2?.();
   off3?.();
   offRe?.();
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [activeSessionId]);
}
