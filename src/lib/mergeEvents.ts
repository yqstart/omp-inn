import type { ViewMsg } from "@shared/types";
import { textHasContent } from "./viewmsg";

/**
 * 实时事件与已有消息流的合并（纯函数，便于单测）。
 *
 * 背景（历史 bug）：一次工具调用在 RPC 流里会分多个阶段到达——
 * `toolcall_delta`（输入中）→ `toolcall_end`（运行中）→ `tool_execution_start`
 * → `tool_execution_end` / `message{toolResult}`（终态）。若每个阶段都无脑追加，
 * 同一次调用会渲染成 2～3 张卡，其中"输入中"那张永远转圈——就是设计稿点名要修的
 * 「已完成工具仍转圈」。历史回放路径已由 `viewMsgsFromJsonlLines` 按 toolCallId
 * 合并解决；本模块负责实时路径的同等待遇。
 *
 * 两条合并规则：
 * 1. `text` 的 `__append`：同一个流式块按 id 覆盖（不是新增一行）。
 * 2. `tool` 卡：按 id 覆盖并**合并字段**——状态与输出以新卡为准，名称/意图/参数摘要
 *    这类"调用元数据"只在早期事件里出现，必须从旧卡继承，否则终态卡会丢参数。
 */

/** 内部标记：只在实时管线中使用，落 store 前会被剥掉，不属于 ViewMsg。 */
export type InternalFlags = {
 /** text 流式追加：同 id 覆盖而非新增。 */
 __append?: boolean;
 /** 工具卡换 id：先用 contentIndex 占位、`toolcall_end` 后换成 toolCallId 卡。 */
 __replaceId?: string;
};

export type IncomingViewMsg = ViewMsg & InternalFlags;

type ToolCard = Extract<ViewMsg, { kind: "tool" }>;

/** 工具卡字段合并：终态覆盖状态/输出，早期事件里的元数据不许丢。 */
export function mergeToolCard(oldCard: ToolCard, next: ToolCard): ToolCard {
 return {
  ...oldCard,
  ...next,
  id: next.id || oldCard.id,
  toolCallId: next.toolCallId || oldCard.toolCallId,
  name: next.name && next.name !== "tool" ? next.name : oldCard.name,
  intent: next.intent || oldCard.intent,
  // 参数摘要：谁有谁覆盖（空摘要不覆盖已有的）。流式占位卡从 V46 起也带内容
  // （`partial` 里的工具名 + 半截参数预览），所以不再按状态冻结；终态帧没有摘要
  // （toolResult / tool_execution_end）时沿用旧卡。占位文案由渲染层按当前语言给。
  argsSummary: next.argsSummary || oldCard.argsSummary,
  output: next.output || oldCard.output,
  outputFull: next.outputFull ?? oldCard.outputFull,
  // 行数增量只在早期事件（toolcall_end / tool_execution_start 带参数的那帧）算得出，
  // 终态帧没有参数，必须从旧卡继承，否则 `+N −M` 会在结果到达时消失。
  diffStat: next.diffStat ?? oldCard.diffStat,
 };
}

/** 剥掉内部标记，保证 store 里只留干净 ViewMsg（e2e:ipc 的 ViewMsg 契约不受影响）。 */
export function stripInternal(m: IncomingViewMsg): ViewMsg {
 if (m.__append === undefined && m.__replaceId === undefined) return m;
 const { __append, __replaceId, ...rest } = m;
 void __append;
 void __replaceId;
 return rest as ViewMsg;
}

export function mergeViewMsgs(cur: ViewMsg[], incoming: IncomingViewMsg[]): ViewMsg[] {
 const out = cur.slice();
 for (const raw of incoming) {
  const next = stripInternal(raw);
  // 换 id：流式占位卡被正式卡取代，原位替换成合并后的卡（保持消息顺序）
  if (raw.__replaceId) {
   const ri = out.findIndex((x) => x.id === raw.__replaceId);
   if (ri >= 0) {
    const oldCard = out[ri];
    out.splice(ri, 1);
    if (oldCard.kind === "tool" && next.kind === "tool") {
     const dup = out.findIndex((x) => x.kind === "tool" && x.id === next.id);
     if (dup >= 0) {
      out[dup] = mergeToolCard(oldCard, out[dup] as ToolCard);
     } else {
      out.splice(ri, 0, mergeToolCard(oldCard, next));
     }
     continue;
    }
   }
  }
  if (raw.__append && next.kind === "text") {
   const idx = out.findIndex((x) => x.kind === "text" && (x.id === next.id || x.liveId === next.id));
   // 无内容文本块（模型在思考与工具调用之间吐的孤立标点）：完结时**整行不生**，已经由
   // 流式增量建出来的就地撤掉——否则消息列里留一格空白加一个「.」（判定见 `textHasContent`）。
   if (next.complete && !textHasContent(next.text)) {
    if (idx >= 0) out.splice(idx, 1);
    continue;
   }
   if (idx < 0) {
    out.push(next);
   } else {
    const prev = out[idx] as Extract<ViewMsg, { kind: "text" }>;
    // 已完成的行只接受完成态的更新（`text_end` / `message_end` 的收尾；迟到的增量帧
    // 不许把写完的段落重开——那会在流尾留下一个永远的打字机光标）。
    if (!prev.complete || next.complete) {
     out[idx] = prev.liveId === next.id ? { ...next, id: prev.id, liveId: prev.liveId, seq: prev.seq, at: prev.at ?? next.at, historyOffset: prev.historyOffset } : next;
    }
   }
   continue;
  }
  // 思考块：流式增量与完成帧共用同一个 id（`${sid}:${contentIndex}`），按 id 原位覆盖
  //（complete:false 「思考中…」→ true 「思考 · N 秒」），整段思考始终只有一块。
  if (next.kind === "thinking") {
   const idx = out.findIndex((x) => x.kind === "thinking" && (x.id === next.id || x.liveId === next.id));
   if (idx >= 0) {
    const prev = out[idx] as Extract<ViewMsg, { kind: "thinking" }>;
    if (!prev.complete || next.complete) {
     out[idx] = prev.liveId === next.id ? { ...next, id: prev.id, liveId: prev.liveId, at: prev.at ?? next.at, historyOffset: prev.historyOffset } : next;
    }
    continue;
   }
  }
  // omp 的实时回显（`message_start` role=user，`u-echo-*`）与 Composer 的乐观回显
  //（`u-local-*`）是同一条消息的两个版本：用发送文本配对，保留用户输入的原文。
  // 不翻倍——否则「发一次」会在消息列渲染成两条相同的气泡。
  if (next.kind === "user" && next.id.startsWith("u-echo-")) {
   const idx = out.findIndex((x) => x.kind === "user" && (x.id.startsWith("u-local-") || x.awaitingEcho) && (x.sentText ?? x.text) === next.text);
   if (idx >= 0) {
    const local = out[idx] as Extract<ViewMsg, { kind: "user" }>;
    // 历史先到时保留已配对的持久行 id，避免下一次回读再次生成重复行。
    // 实时大图可能被上限省略，不能覆盖更完整的本地图片或历史图片引用。
    const keepLocalImages = (local.images?.length ?? 0) > (next.images?.length ?? 0);
    out[idx] = { ...next, id: local.id.startsWith("u-local-") ? next.id : local.id, text: local.text, mentions: local.mentions, sentText: next.text, awaitingEcho: false, historyBeforeSend: local.historyBeforeSend, historyEndBeforeSend: local.historyEndBeforeSend, historyOffset: local.historyOffset, ...(keepLocalImages ? { images: local.images, imagesOmitted: local.imagesOmitted } : {}) };
    continue;
   }
  }
  if (next.kind === "tool") {
   const idx = out.findIndex((x) => x.kind === "tool" && x.id === next.id);
   if (idx >= 0) {
    out[idx] = mergeToolCard(out[idx] as ToolCard, next);
    continue;
   }
  }
  // 同一个审批请求重复推送（重连 / 重放）只保留一张卡
  if (next.kind === "approval") {
   const idx = out.findIndex((x) => x.kind === "approval" && x.id === next.id);
   if (idx >= 0) {
    out[idx] = next;
    continue;
   }
  }
  // 通用 UI 请求同理按 uiId 去重（同一条 request 重放不会出两张卡）
  if (next.kind === "ui") {
   const idx = out.findIndex((x) => x.kind === "ui" && x.uiId === next.uiId);
   if (idx >= 0) {
    out[idx] = next;
    continue;
   }
  }
  // @文件 芯片排：同一批文件重复推送只留一排（message_start/end 各推一次的情况）
  if (next.kind === "files") {
   const idx = out.findIndex((x) => x.kind === "files" && x.id === next.id);
   if (idx >= 0) {
    out[idx] = next;
    continue;
   }
  }
  // 服务端撤回：连同对应卡片一起从流里移除（用户已无法回包，留着就是死卡）
  if (next.kind === "ui-cancel") {
   const idx = out.findIndex((x) => x.kind === "ui" && x.uiId === next.uiId);
   if (idx >= 0) out.splice(idx, 1);
   continue;
  }
  out.push(next);
 }
 return out;
}

/**
 * 流式帧在「同一渲染帧窗口」内的合并（V37，纯函数）。
 *
 * 背景：RPC 的每个 delta 一帧，此前每帧一次 store 写入 + 全量 Markdown 重渲染——
 * 实测 3000 字符的回复出现单次 86ms 的长任务（长回复会随长度二次方级变慢，顿挫感）。
 * `createStreamBuffer` 把窗口内的帧攒起来、每个渲染帧至多写一次 store，本函数负责
 * 攒的时候先把「同一条消息的多个版本」折叠掉（否则 pending 会按 token 数增长，
 * 文本帧每帧都携带全量字符串，内存二次方级膨胀）。
 *
 * 合并规则与 `mergeViewMsgs` 同源，但作用于**未落 store 的 pending**：
 * - 同 id 的 `text` / `thinking`：后者整体覆盖（每帧都是全量文本）；
 * - 同 id 的 `tool`：`mergeToolCard` 合并（保住早期帧才有的元数据），**并继承
 *   `__replaceId`**——`toolcall_end` 的「占位卡原位替换」语义不能因为后续帧
 *   （tool_execution_start / _end 没有这个标记）在同窗口覆盖而丢，丢了占位卡
 *   会永远转圈（正是 mergeEvents 头部注释里的历史 bug）；
 * - 其余（不同 id / 无 id 帧）保序 append。
 */
export function coalesceStream(pending: IncomingViewMsg[], incoming: IncomingViewMsg[]): IncomingViewMsg[] {
 const out = pending.slice();
 for (const m of incoming) {
  const i = out.findIndex((x) => x.kind === m.kind && x.id === m.id);
  if (i < 0) {
   out.push(m);
   continue;
  }
  const prev = out[i];
  if (m.kind === "tool" && prev.kind === "tool") {
   out[i] = {
    ...mergeToolCard(prev, m),
    __append: m.__append ?? prev.__append,
    __replaceId: m.__replaceId ?? prev.__replaceId,
   };
  } else {
   out[i] = { ...m, __append: m.__append ?? prev.__append, __replaceId: m.__replaceId ?? prev.__replaceId };
  }
 }
 return out;
}

/** 流式帧缓冲（V37）：rAF 对齐的批次写入。 */
export type FrameBuffer = {
 /** 攒入一批帧（内部先折叠同 id 版本），并安排在下一个渲染帧 flush。 */
 push(msgs: IncomingViewMsg[]): void;
 /** 立即处理已收到的帧，供历史回读合并前使用。 */
 flush(): void;
 /** 会话切走 / 卸载：丢弃未 flush 的帧（内容真相在 jsonl，切回时 `get_history` 重拉）。 */
 dispose(): void;
};

/**
 * 把同一渲染帧窗口内到达的 delta 合并成一次 flush（store 写入）。
 *
 * 为什么用 rAF：与浏览器渲染节奏对齐，60fps 下至多每帧一次 store 写入 / 重渲染；
 * 窗口隐藏时 rAF 停摆，pending 挂着（已折叠、量级 = 消息数不是 token 数），
 * 页面恢复可见的下一帧立即 flush——切回来的瞬间看到的是完整内容，不是积压队列。
 */
export function createStreamBuffer(flush: (msgs: IncomingViewMsg[]) => void): FrameBuffer {
 let pending: IncomingViewMsg[] = [];
 let scheduled = false;
 const flushPending = () => {
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  flush(batch);
 };
 const run = () => {
  scheduled = false;
  flushPending();
 };
 return {
  push(msgs) {
   if (msgs.length === 0) return;
   pending = coalesceStream(pending, msgs);
   if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(run);
   }
  },
  flush: flushPending,
  dispose() {
   // 已调度的 rAF 留着无妨：run 见 pending 为空直接返回
   pending = [];
  },
 };
}
