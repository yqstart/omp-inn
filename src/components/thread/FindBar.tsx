import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, X } from "reicon-react";
import type { ViewMsg } from "@shared/types";
import { useApp } from "../../stores/app";
import { fmt } from "../../lib/locale";
import { useText } from "../../lib/useText";
import { isMacKeyboard } from "../../lib/platform";

/**
 * 会话内查找（⌘F / Ctrl+F，对齐 zcode）：一条与消息列同宽的横条，输入即搜。
 *
 * - **搜什么**：当前会话事件流的可见文本（用户消息 / 助手正文 / 思考 / 本地命令输出 / 工具输出），
 *   大小写不敏感的子串匹配；命中单位是**消息**（一条消息里命中多次只算一项，但框内全部标黄）；
 * - **跳转**：滚动当前命中消息的 DOM（`[data-msg-id]`，由 Thread 标注）。消息被分页裁掉时
 *   该命中直接跳过，不空转；
 * - **高亮**：CSS Custom Highlight API（不动 DOM 结构，与 React 渲染不打架）。jsdom / 旧 WebView
 *   没有 `CSS.highlights` 时静默退化成「只滚动 + 只计数」，不抛错、不影响其它功能；
 * - 打开时自动聚焦；关闭清空查询与高亮；切会话重置（会话之间不串命中项）。
 */

/** 消息里可被查找的文本（与消息列上真正看得见的内容同源）。 */
function searchableText(m: ViewMsg): string {
 switch (m.kind) {
  case "user":
  case "text":
  case "thinking":
   return m.text;
  case "command":
  case "tool":
   return m.output;
  default:
   return "";
 }
}

/** 命中消息的 DOM 节点；没渲染出来（被分页裁掉）就是 null。 */
function domOf(id: string): HTMLElement | null {
 const esc = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(id) : id;
 return document.querySelector<HTMLElement>(`[data-msg-id="${esc}"]`);
}

/** CSS Custom Highlight API 的最小形状（lib.dom 的 HighlightRegistry 只声明了 forEach）。 */
type HighlightRegistryLike = { set(name: string, value: unknown): void; delete(name: string): void };
type HighlightCtor = new (...ranges: Range[]) => unknown;
/** 需要从全局对象上取的成员（DOM lib 的 `CSS.highlights` 声明不全，按实际用法收窄）。 */
type HighlightGlobals = { CSS?: { highlights?: HighlightRegistryLike }; Highlight?: HighlightCtor };

const HL_ALL = "omp-find";
const HL_ACTIVE = "omp-find-active";

/** 拿到高亮句柄；浏览器不支持时返回 null（调用方静默退化）。 */
function highlightApi(): { reg: HighlightRegistryLike; ctor: HighlightCtor } | null {
 const g = globalThis as unknown as HighlightGlobals;
 const reg = g.CSS?.highlights;
 const ctor = g.Highlight;
 if (!reg || typeof ctor !== "function") return null;
 return { reg, ctor };
}

/** 把 `root` 下所有文本节点里的 `needle`（已小写）收进 `out`。 */
function collectRanges(root: HTMLElement, needle: string, out: Range[]): void {
 const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
 for (let node = walker.nextNode(); node; node = walker.nextNode()) {
  const text = node.textContent ?? "";
  if (!text) continue;
  const lower = text.toLowerCase();
  let i = lower.indexOf(needle);
  while (i !== -1) {
   const range = document.createRange();
   range.setStart(node, i);
   range.setEnd(node, i + needle.length);
   out.push(range);
   i = lower.indexOf(needle, i + needle.length);
  }
 }
}

const EMPTY_EVENTS: ViewMsg[] = [];

export function FindBar() {
 const t = useText();
 const findOpen = useApp((s) => s.findOpen);
 const setFindOpen = useApp((s) => s.setFindOpen);
 const events = useApp((s) => (s.activeSessionId ? s.eventsBySession[s.activeSessionId] ?? EMPTY_EVENTS : EMPTY_EVENTS));
 // 查询串放 store：关闭即清（`setFindOpen(false)` 联动）；带会话归属——切会话后旧查询自动不生效
 // （组件本地态做这两件事要在 effect 里同步 setState，触发级联渲染告警）。
 const query = useApp((s) => (s.findQuerySid === s.activeSessionId ? s.findQuery : ""));
 const setQuery = useApp((s) => s.setFindQuery);

 const [idx, setIdx] = useState(0);
 const inputRef = useRef<HTMLInputElement>(null);

 // 命中项 = 消息 id 的有序列表（与事件流同序，上/下的遍历顺序就是消息列顺序）
 const hits = useMemo(() => {
  const needle = query.toLowerCase();
  if (!needle.trim()) return [];
  return events.filter((m) => searchableText(m).toLowerCase().includes(needle)).map((m) => m.id);
 }, [events, query]);

 // `idx` 只在输入 / 上一步下一步时改写，命中项变少（继续打字）后可能越界：
 // 渲染、高亮、滚动一律按夹过的值走，别出现「5 / 2」这种帧。
 const cur = hits.length === 0 ? -1 : Math.min(idx, hits.length - 1);

 // 打开就聚焦，省一次点击
 useEffect(() => {
  if (findOpen) inputRef.current?.focus();
 }, [findOpen]);

 /** 上/下一个：环形遍历，DOM 里找不到的命中项跳过。 */
 const step = useCallback(
  (dir: 1 | -1) => {
   if (hits.length === 0) return;
   let next = cur;
   for (let i = 0; i < hits.length; i++) {
    next = (next + dir + hits.length) % hits.length;
    if (domOf(hits[next])) break;
   }
   setIdx(next);
  },
  [hits, cur],
 );

 // 滚动到当前命中项（仅聊天形态的滚动容器是 Thread，`block: center` 与 zcode 同口径）
 useEffect(() => {
  if (!findOpen) return;
  const id = hits[cur];
  if (!id) return;
  const el = domOf(id);
  // jsdom 没实现 scrollIntoView；真实 WebView 才有
  if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
 }, [findOpen, hits, cur]);

 // 高亮：全部命中进 omp-find，当前命中再进 omp-find-active（后注册的盖在上面）
 useEffect(() => {
  const api = highlightApi();
  if (!api) return; // 无 Custom Highlight API：静默退化
  api.reg.delete(HL_ALL);
  api.reg.delete(HL_ACTIVE);
  if (!findOpen) return;
  const needle = query.toLowerCase();
  if (!needle.trim() || hits.length === 0) return;
  const all: Range[] = [];
  const active: Range[] = [];
  hits.forEach((id, i) => {
   const el = domOf(id);
   if (!el) return;
   const ranges: Range[] = [];
   collectRanges(el, needle, ranges);
   all.push(...ranges);
   if (i === cur) active.push(...ranges);
  });
  if (all.length > 0) api.reg.set(HL_ALL, new api.ctor(...all));
  if (active.length > 0) api.reg.set(HL_ACTIVE, new api.ctor(...active));
 }, [findOpen, query, hits, cur]);

 // 卸载时别把高亮留在页面上
 useEffect(
  () => () => {
   const api = highlightApi();
   api?.reg.delete(HL_ALL);
   api?.reg.delete(HL_ACTIVE);
  },
  [],
 );

 // ⌘G / ⇧⌘G（非 mac 用 Ctrl）：与 zcode 一致的下一个 / 上一个
 useEffect(() => {
  if (!findOpen) return;
  const onKey = (e: KeyboardEvent) => {
   if (e.isComposing || e.altKey) return;
   const mod = isMacKeyboard() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
   if (!mod || e.key.toLowerCase() !== "g") return;
   e.preventDefault();
   step(e.shiftKey ? -1 : 1);
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
 }, [findOpen, step]);

 if (!findOpen) return null;

 const iconBtn =
  "shrink-0 cursor-pointer rounded-md border border-border p-1 text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground disabled:cursor-default disabled:opacity-40";

 return (
  <div className="flex shrink-0 justify-center pt-2">
   {/* 宽度 = 中列 85%（`--measure-content`，与正文 / 输入卡同档）：外层不挂水平内边距，
       否则 85% 的基准变成「中列 − 2×内边距」，比正文窄一截。 */}
   <div className="flex w-full max-w-(--measure-content) items-center gap-2 rounded-lg border border-border bg-elevated px-2 py-1.5 shadow-pop">
    <input
     ref={inputRef}
     value={query}
     onChange={(e) => {
      // 查询一变就回到第一个命中项（与输入同一次更新里发生，不留旧序号的闪帧）
      setQuery(e.target.value);
      setIdx(0);
     }}
     onKeyDown={(e) => {
      if (e.key === "Enter") {
       e.preventDefault();
       step(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
       // 只有查找栏吃这个 Esc（别让外层会话级 Esc 也跟着响）
       e.preventDefault();
       e.stopPropagation();
       setFindOpen(false);
      }
     }}
     placeholder={t.findPlaceholder}
     aria-label={t.lcFind}
     spellCheck={false}
     className="h-6 min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-faint"
    />
    <span data-testid="find-count" className="shrink-0 text-[11px] tabular-nums text-muted">
     {cur >= 0 ? fmt(t.findCount, cur + 1, hits.length) : query.trim() ? t.findNoMatch : ""}
    </span>
    <button
     type="button"
     className={iconBtn}
     aria-label={t.findPrevAria}
     title={t.findPrevAria}
     disabled={hits.length === 0}
     onClick={() => step(-1)}
    >
     <ArrowUp size={14} aria-hidden />
    </button>
    <button
     type="button"
     className={iconBtn}
     aria-label={t.findNextAria}
     title={t.findNextAria}
     disabled={hits.length === 0}
     onClick={() => step(1)}
    >
     <ArrowDown size={14} aria-hidden />
    </button>
    <button
     type="button"
     className={iconBtn}
     aria-label={t.findCloseAria}
     title={t.findCloseAria}
     onClick={() => setFindOpen(false)}
    >
     <X size={14} aria-hidden />
    </button>
   </div>
  </div>
 );
}
