import type { ViewMsg } from "@shared/types";

/**
 * 轮次定位轨（形态照 DeepSeek Harness 的 `TurnNavigator`）的**纯数据面**：
 * 一处派生「会话里每一轮提问」的序号 / 锚点 / 预览，以及阅读线落在第几轮、
 * 跳轮应该滚到什么位置。组件（`thread/TurnRail.tsx`）只做 DOM 测量与交互。
 *
 * 口径：
 * - **一轮 = 一条用户消息**（steering 插话也算新的一轮：它就是一个新提问的锚点），
 *   序号在整个会话里从 1 连续编号——历史分页只影响 `loaded`，不影响编号；
 * - **预览取「本轮最后一条已完成的非空助手正文」**（工具输出 / 思考不算回答；流式中的半截
 *   不进预览——它不是最终回答、每帧都在变），压成单空格并限长，
 *   与上游的 prompt / response 两行预览同语义；
 * - **阅读线** = 视口顶部往下 `min(96px, 20% 视口高)`（与上游一致）：贴底时由组件直接
 *   取最新一轮，其余时候看阅读线落在哪一行之上。
 */

/** 预览文本的量级：提示卡是 300px 宽的浮层，按 1 + 3 行截断，抄全文既放不下也没人读。 */
const PREVIEW_CHARS = 240;

/** 跳轮落地时行顶与视口顶的间距（px）：给上一个轮次留一点上下文，别让提问那句话贴边。 */
export const TURN_JUMP_INSET_PX = 24;

/** 一期定位轨的一条轮次。 */
export interface TurnRailItem {
 /** 会话内 1 起算的轮次序号（历史分页变化不改它）。 */
 turn: number;
 /** 该轮用户消息的 ViewMsg id（已加载时就是 DOM 锚点 `data-turn` 的数值来源）。 */
 id: string;
 /** 在完整事件流里的下标（用「总条数 − 下标」算要展开到第几页）。 */
 index: number;
 /** 本轮提问的预览（单行）。 */
 prompt: string;
 /** 本轮最后一条**已完成**的非空助手正文预览（没有就是空串；流式中的半截不进来）。 */
 response: string;
 /** 锚点行是否已在渲染窗口里；`false` = 更早的历史还没展开（点击要先放页）。 */
 loaded: boolean;
}

/**
 * 预览文本归一：换行 / 连续空白压成单空格，并限长。
 * 预览按行截断（`line-clamp`），原文换行只会提前把三行配额用光。
 *
 * 先截再归一：流式期间每条 delta 都会重算这一轮，不能对整篇回答跑正则
 * （`4 × 240` 的上限覆盖 240 字 + 空白折叠，超出的部分本来就会被截掉）。
 */
function previewText(text: string): string {
 const flat = text.slice(0, PREVIEW_CHARS * 4).replace(/\s+/g, " ").trim();
 return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
}

/**
 * 归一结果按**消息对象**缓存：`mergeEvents` 不动的消息保持同一引用，流式期间
 * 每条 delta 都会重跑 `buildTurnRail`，不能把整段历史的正则再烧一遍。
 * 只给「用户消息」与「已完成的助手正文」用——半截正文每帧都在长，缓存没有意义。
 */
const previewCache = new WeakMap<object, string>();

function cachedPreview(key: object, text: string): string {
 const hit = previewCache.get(key);
 if (hit !== undefined) return hit;
 const value = previewText(text);
 previewCache.set(key, value);
 return value;
}

/**
 * 从完整事件流派生定位轨（升序）。
 *
 * @param events - 会话的完整消息流（**不是**渲染窗口的切片：更早的轮次要能显示成
 *   `loaded=false` 并参与编号 / 预览）。
 * @param renderedFrom - 渲染窗口的第一条消息在 `events` 里的下标（= 被隐藏的条数）。
 *   下标小于它的轮次标记为未加载。
 */
export function buildTurnRail(events: ViewMsg[], renderedFrom: number): TurnRailItem[] {
 const items: TurnRailItem[] = [];
 let current: TurnRailItem | null = null;
 for (let i = 0; i < events.length; i++) {
  const m = events[i];
  if (m.kind === "user") {
   current = {
    turn: items.length + 1,
    id: m.id,
    index: i,
    prompt: cachedPreview(m, m.text),
    response: "",
    loaded: i >= renderedFrom,
   };
   items.push(current);
   continue;
  }
  // 只认**已完成**的助手正文；后出现的覆盖前面的——预览要的是「本轮最后怎么回答的」。
  // 流式中的半截不进预览：它不是最终回答，而且每帧都在变（预览不是阅读器）。
  if (m.kind === "text" && current && m.complete) {
   const preview = cachedPreview(m, m.text);
   if (preview !== "") current.response = preview;
  }
 }
 return items;
}

/** 一条轮次锚点的行顶（相对消息列视口顶，px）。 */
export interface TurnRowTop {
 turn: number;
 top: number;
}

/** 阅读线：视口顶部往下 `min(96px, 20% 视口高)`——追问 / 回答的分界就读这一条线。 */
export function readingLine(clientHeight: number): number {
 return Math.min(96, Math.max(0, clientHeight) * 0.2);
}

/**
 * 阅读线落在第几轮：`rows` 按行顶升序（= DOM 顺序），取最后一个「行顶 ≤ 阅读线」的轮次。
 * 阅读线在第一行之上时取第一轮（会话顶部没有「上一轮」可回退）；没有已加载轮次返回 `null`。
 */
export function activeTurnAt(rows: TurnRowTop[], line: number): number | null {
 if (rows.length === 0) return null;
 let turn = rows[0].turn;
 for (const row of rows) {
  if (row.top > line) break;
  turn = row.turn;
 }
 return turn;
}

/**
 * 跳轮落地的 `scrollTop`：把锚点行顶放到视口顶下方 `inset` 处，再按滚动范围夹住
 * （最后一轮在底部本来就滚不过去；第一轮在顶部同理）。
 *
 * @param rowTop - 锚点行顶相对消息列视口顶的偏移（`getBoundingClientRect` 差出来）。
 * @param scrollTop - 当前 `scrollTop`。
 * @param maxTop - `scrollHeight - clientHeight`（滚动范围上限）。
 */
export function turnJumpTop(rowTop: number, scrollTop: number, maxTop: number, inset = TURN_JUMP_INSET_PX): number {
 return Math.max(0, Math.min(Math.max(0, maxTop), scrollTop + rowTop - inset));
}
