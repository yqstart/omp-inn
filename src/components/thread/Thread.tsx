import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Bulb, ChevronRight, Sparkles } from "reicon-react";
import { THREAD_PAGE, useApp } from "../../stores/app";
import { fmt } from "../../lib/locale";
import { useText } from "../../lib/useText";
import { isRemoteClient } from "@shared/remote";
import { openBtwPanel } from "../../lib/btw";
import { loadEarlierHistory, openSessionWithHistory } from "../../lib/sessionOpen";
import { buildThreadLayout } from "../../lib/threadLayout";
import { buildTurnRail, turnJumpTop, type TurnRailItem } from "../../lib/turnRail";
import { NEAR_BOTTOM_PX } from "../../lib/threadScroll";
import type { ViewMsg } from "@shared/types";
import { PlanCard } from "./PlanCard";
import { TurnRail } from "./TurnRail";
import { ToolRow } from "./ToolRow";
import { ToolRunRow } from "./ToolRunRow";
import { TurnRow } from "./TurnRow";
import { ApprovalCard } from "./ApprovalCard";
import { UiRequestCard } from "./UiRequestCard";
import { MentionChips } from "./MentionChips";
import { AssistantText } from "./AssistantText";
import { ChatEmptyState } from "./ChatEmptyState";
import { MessageImage, type ImagePreview } from "./MessageImage";
import { ImageLightbox } from "./ImageLightbox";
import { useElapsedSeconds, formatElapsed } from "../../lib/useElapsed";
import { useRevealedText } from "../../lib/streamReveal";

/** 空消息流的稳定引用（见 `Thread` 里 `events` 的说明）。 */
const EMPTY_EVENTS: ViewMsg[] = [];

/** 一次划选最多引用的字符数：超长选区截断，避免把整篇对话塞进草稿 / 旁问。 */
const MAX_SELECTION = 2000;

/** 跳轮用瞬时还是平滑滚动：系统偏好减少动效时瞬时（与 `lib/streamReveal` 同口径）。 */
function prefersReducedMotion(): boolean {
 return (
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches
 );
}

export function Thread() {
 const { projects, activeSessionId, eventsBySession, historyPages, statusBySession, threadLimitSid, threadLimit, growThreadLimit, sessions } =
  useApp();
 const t = useText();
 const cwd = sessions.find((s) => s.id === activeSessionId)?.cwd ?? "";
 /** 图片预览浮层（2026-10-22）：消息气泡与历史回放共用，回调保持稳定引用（ThreadRow 是 memo）。 */
 const [preview, setPreview] = useState<ImagePreview | null>(null);
 const openImage = useCallback((p: ImagePreview) => setPreview(p), []);
 const closePreview = useCallback(() => setPreview(null), []);
 const scroller = useRef<HTMLDivElement>(null);
 // 划选浮条（V40）：划中正文后在选区上方浮出「引用到输入框 / 旁问」。
 // 位置在 mouseup 时算一次（fixed 定位），滚动 / Esc / 点别处 / 动作执行后即关。
 const selBar = useRef<HTMLDivElement>(null);
 const [sel, setSel] = useState<{ left: number; top: number; text: string } | null>(null);
 // 「贴着底」状态（V37，粘性语义）：贴底时**任何内容增长**都保持贴底——关键是流式文本
 // 原位追加（同一消息变高），此前只认「消息条数变化」，视口在文本流式期间完全不动，
 // 文字在屏外生长（用户实测「没有输出的爽感」：内容超出 480px 视口仍停在原地）。
 // 释放 / 恢复的判定只有一处实现（`userScrolledAway`），onScroll 与 `followBottom` 共用；
 // 跟随动作在 useLayoutEffect（paint 前补滚动，输出不先画在屏外再跳）。
 const stick = useRef(true);
 // 「加载更早」后要保住视口位置：记录加载前距底部的距离，插入后补回去
 const keepOffset = useRef<number | null>(null);
 /**
  * 「用户滚开了」的唯一判定（V37/V38/V49，`onScroll` 与 `followBottom` 共用）。两个要素：
  * 1. **位置真的往上挪了**（scrollTop 比基线更靠前，累计超出 8px 容差）——这是「用户动作」
  *    的判据，对滚轮 / 键盘 / 触屏 / 拖滚动条都成立；基线只在补滚 / 往下滚时跟新，小幅上翻可累加；
  * 2. **确实离底 ≥ 阈值**——视口变高会被浏览器夹掉一截 scrollTop（不是用户上翻）；
  *    在阈值内本来就算「还在底部」，不必释放。
  *
  * 为什么不能按「距底距离」判（V37 旧口径，等价于 `上次高度 − scrollTop − clientHeight > 8`）：
  * 它**完全不解释视口变矮**——输入框长高 / 查找条 / 健康横幅 / 窗口缩放都会让距底凭空多出
  * 一截，于是被判成「用户滚开了」，跟随当场死亡；而且视口变矮**本身就会派发 scroll 事件**，
  * `onScroll` 按同一距离口径再判一次，同样释放——之后既没有滚动也没有内容外的动作，
  * 跟随再也回不来（真机实测：释放后所有后续 delta 都不再跟随，只有手动滚回或点回底按钮才恢复）。
  */
 const lastTop = useRef(0);
 /**
  * 「离底」渲染状态（V47）：`stick` 是 ref，翻转不触发渲染——而回底按钮要按渲染层面的
  * 离底与否决定露面。**与释放状态同源**（`syncAway(!stick.current)`），且只在值变化时写
  * state：滚动是高频道，同值 setState 会让 React 白跑一轮（`onScroll` 每次都会调到这里）。
  */
 const [awayFromBottom, setAwayFromBottom] = useState(false);
 const awayRef = useRef(false);
 /**
  * 任务清单浮卡高度（V51）：卡片贴消息列底部、浮在输入卡上方——消息流底部要按它留出一段
  * 等高空白（末尾内容不被浮卡永久盖住），「回到底部」按钮也要上移让位。高度由 `PlanCard`
  * 上报（ResizeObserver 盯卡片自身：展开 / 收起、清单增减、视口变窄换行都会重报）；
  * 同值不写（滚动与 resize 频率下白跑一轮渲染不划算）。
  */
 const [planCardH, setPlanCardH] = useState(0);
 const syncPlanCardH = useCallback((h: number) => {
  setPlanCardH((prev) => (Math.abs(prev - h) < 1 ? prev : h));
 }, []);
 const syncAway = useCallback((away: boolean) => {
  if (awayRef.current === away) return;
  awayRef.current = away;
  setAwayFromBottom(away);
 }, []);
 const userScrolledAway = useCallback((el: HTMLDivElement): boolean => {
  const up = lastTop.current - el.scrollTop;
  // 基线只在「没往上走」时跟新（补滚 / 往下滚 / 不动）——连续的小幅上翻（拖滚动条、触屏惯性）
  // 要能累加过容差；每次都把基线拉平，慢速上翻永远攒不够位移，跟随就一直把视口拽回底部。
  if (up <= 0) lastTop.current = el.scrollTop;
  return up > 8 && el.scrollHeight - el.scrollTop - el.clientHeight >= NEAR_BOTTOM_PX;
 }, []);
 const followBottom = useCallback(() => {
  const el = scroller.current;
  if (!el) return;
  const h = el.scrollHeight;
  const dist = h - el.scrollTop - el.clientHeight;
  if (userScrolledAway(el)) {
   stick.current = false;
   syncAway(true);
   return;
  }
  // 回到阈值内自动重新武装（滚回来 / 内容变矮 / 视口变高都会把视口带回底部附近）——
  // 只靠 onScroll 恢复不了「没有滚动、只有高度变化」的那一半。
  if (dist < NEAR_BOTTOM_PX) stick.current = true;
  if (!stick.current) {
   syncAway(true);
   return;
  }
  el.scrollTop = h;
  // 读回夹过界（`scrollTop = scrollHeight` 会被浏览器夹到最大值）的真实位置：它是下次
  // 「用户有没有上翻」比对的基线，差一截就会把程序化滚动误判成用户滚开。
  lastTop.current = el.scrollTop;
  syncAway(false);
 }, [syncAway, userScrolledAway]);
 /**
  * 回到底部（V47）：恢复跟随 + 瞬时读底——与贴底跟随是同一个动作。
  * 不用平滑滚动：滚动途中每一帧都离底，会撞上 `followBottom` 的「用户已滚开」对账
  * 被当场释放；而流式内容还在增长，最后会停在旧底而不是最新一行。
  */
 const jumpToBottom = useCallback(() => {
  const el = scroller.current;
  if (!el) return;
  stick.current = true;
  el.scrollTop = el.scrollHeight;
  lastTop.current = el.scrollTop;
  syncAway(false);
 }, [syncAway]);
 /**
  * 消息列**内容盒**的回调 ref：平滑揭示每帧长高（不进 store），跟滚 effect 捕获不到——
  * ResizeObserver 盯内容盒，贴底时任何高度增长都补滚（揭示 / 图片加载 / 字体就位）。
  * 用回调 ref 而不是「effect + useRef」：Thread 常驻挂载，首屏可能是空态（内容盒不在 DOM），
  * 普通 effect 早退一次就再也接不上（浏览器核对实测过这个缺陷）；回调 ref 在节点
  * 真正挂上 / 换掉时触发，天然覆盖「空态 → 会话 → 换会话」所有路径。
  */
 const contentRo = useRef<ResizeObserver | null>(null);
 const attachContent = useCallback(
  (el: HTMLDivElement | null) => {
   contentRo.current?.disconnect();
   contentRo.current = null;
   if (el && typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => followBottom());
    ro.observe(el);
    contentRo.current = ro;
   }
  },
  [followBottom],
 );
 // 空态用模块级常量：`?? []` 每渲染都是新引用，会让下面的跟随 effect 依赖失效（eslint
 // exhaustive-deps 直接警告；语义上「没有事件」也不该被当成一次更新）。
 const rawEvents = (activeSessionId ? eventsBySession[activeSessionId] : undefined) ?? EMPTY_EVENTS;
 const events = useMemo(() => rawEvents.filter((m) => m.kind !== "divider" || !m.pendingPriorUser), [rawEvents]);
 // 流式进行中（后端状态帧 / 回读真值）：流尾没有「正在输出」的行时补一条「思考中…」。
 // 为什么必须有：慢模型（尤其推理档拉满）从发送到首个 delta 可能几十秒到几分钟，
 // 期间「只有用户那条消息」——用户看到的就是「发送后无任何反应」。指示行是纯派生渲染，
 // 不进 store、不参与历史与去重。
 const status = activeSessionId ? statusBySession[activeSessionId]?.state : undefined;
 const working = status === "running" && !hasLiveTail(events[events.length - 1]);
 // 指示行**延迟露面**（V46）：文本段收尾与下一个块（工具 / 思考）之间往往只隔一两帧，
 // 立即挂出会「闪一下又消失」；持续的空窗（等首个 token / 等下一步）才值得说「在跑」。
 const workingVisible = useDelayedFlag(working, 300);
 // 划选浮条：Esc / 点浮条外即关（浮条自身的 mousedown 被 preventDefault，不会清掉选区）
 useEffect(() => {
  if (!sel) return;
  const onKey = (e: KeyboardEvent) => {
   if (e.key === "Escape") setSel(null);
  };
  const onDown = (e: MouseEvent) => {
   const bar = selBar.current;
   if (bar && e.target instanceof Node && bar.contains(e.target)) return;
   setSel(null);
  };
  window.addEventListener("keydown", onKey);
  document.addEventListener("mousedown", onDown);
  return () => {
   window.removeEventListener("keydown", onKey);
   document.removeEventListener("mousedown", onDown);
  };
 }, [sel]);
 // 首屏增量（MASTER §7）：只渲染最后 N 条，向上加载更多。窗口按会话重置。
 const limit = threadLimitSid === activeSessionId ? threadLimit : THREAD_PAGE;
 const hidden = Math.max(0, events.length - limit);
 const historyPage = activeSessionId ? historyPages[activeSessionId] : undefined;
 const shown = hidden > 0 ? events.slice(-limit) : events;
 // 消息列布局（v2 §2.1）：相邻同类工具行聚合成摘要行 + 每轮末尾的时长行；
 // running 时跳过压在流尾的进行中轮次（没有时长可报）
 const layout = useMemo(() => buildThreadLayout(shown, status === "running"), [shown, status]);
 /**
  * 轮次定位轨的数据面（2026-10-21）：从**完整**消息流派生会话里每一轮的序号 / 预览 /
  * 是否在渲染窗口里——历史页收起时标记仍在（`loaded=false`），点击先放页再落地，
  * 编号与完整会话一致（不随分页重排）。
  */
 // 未加载完整历史时无法得知绝对轮次号，先不展示带编号的定位轨。
 const railItems = useMemo(() => historyPage?.before != null ? [] : buildTurnRail(events, hidden), [events, hidden, historyPage?.before]);
 const turnByMsgId = useMemo(() => new Map(railItems.map((item) => [item.id, item.turn])), [railItems]);
 /** 未加载轮次的落地意图：放页是同步的 store 更新，等下一帧 DOM 里有锚点行后再跳。
  *  带上会话 id——放页与渲染之间切了会话，这条意图就作废（轮次号在新会话里没有意义）。 */
 const pendingTurn = useRef<{ turn: number; sid: string | null } | null>(null);
 const loadEarlier = () => {
  const el = scroller.current;
  if (el) keepOffset.current = el.scrollHeight - el.scrollTop;
  growThreadLimit(THREAD_PAGE);
 };
 const loadEarlierPage = () => {
  const sid = activeSessionId;
  if (!sid) return;
  void loadEarlierHistory(sid, () => {
   if (useApp.getState().activeSessionId !== sid) return;
   const el = scroller.current;
   if (el) keepOffset.current = el.scrollHeight - el.scrollTop;
   growThreadLimit(THREAD_PAGE);
  });
 };
 /**
  * 把某一轮的锚点行滚到视口顶部（`turnJumpTop` 留 24px 呼吸位并夹住滚动范围）。
  * 跳轮 = 读者接管：先撤掉贴底跟随——平滑滚动途中到达的流式增量不许把视口拽回底部。
  * 但落点本来就在贴底阈值内时（短会话 / 点最新一轮）不亮「回到底部」——那里没有可回的距离。
  */
 const scrollToTurnRow = useCallback(
  (el: HTMLDivElement, row: HTMLElement, behavior: ScrollBehavior) => {
   const origin = el.getBoundingClientRect().top;
   const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
   const top = turnJumpTop(row.getBoundingClientRect().top - origin, el.scrollTop, maxTop);
   stick.current = false;
   syncAway(maxTop - top >= NEAR_BOTTOM_PX);
   // jsdom（单测）没有 Element.scrollTo：退回写 scrollTop，两条路到达同一个落点
   if (behavior === "smooth" && typeof el.scrollTo === "function") el.scrollTo({ top, behavior });
   else el.scrollTop = top;
  },
  [syncAway],
 );
 /** 点击轨上某一轮：已加载 = 直接滚；未加载 = 先把窗口放大到刚好含这一条。 */
 const jumpToTurn = useCallback(
  (item: TurnRailItem) => {
   const el = scroller.current;
   if (!el) return;
   if (!item.loaded) {
    const need = events.length - item.index;
    if (need > limit) growThreadLimit(need - limit);
    pendingTurn.current = { turn: item.turn, sid: activeSessionId };
    return;
   }
   const row = el.querySelector<HTMLElement>(`[data-turn="${item.turn}"]`);
   if (row) scrollToTurnRow(el, row, prefersReducedMotion() ? "auto" : "smooth");
  },
  [activeSessionId, events.length, limit, growThreadLimit, scrollToTurnRow],
 );
 // 未加载轮次放页后的落地：等锚点行真的进了 DOM 再跳（同步 setState 的下一轮渲染）
 useLayoutEffect(() => {
  const pending = pendingTurn.current;
  if (!pending) return;
  if (pending.sid !== activeSessionId) {
   pendingTurn.current = null;
   return;
  }
  const el = scroller.current;
  if (!el) return;
  const row = el.querySelector<HTMLElement>(`[data-turn="${pending.turn}"]`);
  if (!row) return;
  pendingTurn.current = null;
  // 整页历史刚插到上方：瞬时落地（平滑滚动会穿过一段与被点轮次无关的旧内容）
  scrollToTurnRow(el, row, "auto");
 });
 /**
  * 划选浮条定位（mouseup）：要求选区非空、且 anchor 与 focus 都在消息列容器内——
  * 跨到左栏 / 输入框的选区不算「划中对话内容」。位置取选区末端的矩形，越界往回收
  * （贴顶时往下让，靠边时水平收进视口），浮条本身是 fixed，不参与消息列布局。
  */
 const onMouseUp = () => {
  // 手机端划选浮条（旁问 / 引用）依赖桌面输入卡与 btw 面板，远程先关掉。
  if (isRemoteClient()) return;
  const el = scroller.current;
  if (!el) return;
  const s = window.getSelection();
  if (!s || s.isCollapsed || s.rangeCount === 0) return;
  if (!el.contains(s.anchorNode) || !el.contains(s.focusNode)) return;
  const text = s.toString().trim();
  if (!text) return;
  const rect = s.getRangeAt(0).getBoundingClientRect();
  setSel({
   left: Math.min(Math.max(rect.left + rect.width / 2, 96), Math.max(96, window.innerWidth - 96)),
   top: Math.max(rect.top - 6, 44),
   text: text.slice(0, MAX_SELECTION),
  });
 };
 /** 引用到输入框：选中文本转成每行 `> ` 的引用块追加进草稿（有空草稿时先空一行隔开）。 */
 const quoteSelection = () => {
  const sid = activeSessionId;
  if (!sid || !sel) return;
  const block = `${sel.text
   .split("\n")
   .map((l) => `> ${l}`)
   .join("\n")}\n\n`;
  const old = useApp.getState().draftOf(sid);
  useApp.getState().setDraft(sid, old.trim() ? `${old}\n\n${block}` : block);
  setSel(null);
 };
 /** 旁问：带着选中文本打开面板（预填进输入框，不自动发送）。 */
 const askSelection = () => {
  const sid = activeSessionId;
  if (!sid || !sel) return;
  void openBtwPanel(sid, sel.text);
  setSel(null);
 };
 useLayoutEffect(() => {
  const el = scroller.current;
  if (el && keepOffset.current != null) {
   el.scrollTop = el.scrollHeight - keepOffset.current;
   // 这一跳是程序为了「加载更早」补的视口位置，不是用户滚的：不刷新基线，
   // 下一次跟随会把这一跳误判成用户上翻。
   lastTop.current = el.scrollTop;
   keepOffset.current = null;
  }
 });
 // 切会话即读底（并重置贴底状态）：新会话消息先落位再滚到底（双 rAF 等首帧绘制完成）
 useEffect(() => {
  stick.current = true;
  lastTop.current = 0;
  syncAway(false);
  const raf = requestAnimationFrame(() => {
   requestAnimationFrame(() => {
    const el = scroller.current;
    if (el) {
     el.scrollTop = el.scrollHeight;
     lastTop.current = el.scrollTop;
    }
   });
  });
  return () => cancelAnimationFrame(raf);
 }, [activeSessionId, syncAway]);
 // 跟随时机（V37）：`events` 引用变化 = 本会话消息流有更新——流式文本原位追加、新消息追加、
 // 指示行出现 / 消失都算（此前缺的就是第一类）。useLayoutEffect 在 DOM 更新后、paint 前补滚动，
 // 不会出现「先画在屏外、再跳一下」的闪动；用户上翻（stick 为假）时不抢滚动。
 useLayoutEffect(() => {
  followBottom();
 }, [events, working, followBottom]);
 // 手机端没有项目 / 会话空态（移动壳自己渲染列表与引导）；只留正文区。
 if (isRemoteClient()) {
  if (!activeSessionId || (events.length === 0 && !working && historyPage?.before == null && !historyPage?.error && !historyPage?.skipped)) {
   return <div className="flex flex-1 items-center justify-center text-[13px] text-faint">{t.remoteThreadEmpty}</div>;
  }
 } else {
  if (projects.length === 0) return <ChatEmptyState kind="no-project" />;
  if (!activeSessionId || (events.length === 0 && !working && historyPage?.before == null && !historyPage?.error && !historyPage?.skipped)) {
   return <ChatEmptyState kind="no-session" hasSession={!!activeSessionId} />;
  }
 }
 return (
  <>
   {/* 相对定位外壳：回底按钮要相对「消息列视口」固定——scroller 内部是滚动内容，
       挂进去会随内容滚走，所以按钮是 scroller 的兄弟、absolute 贴外壳底边。
       同时是**轮次定位轨的容器查询容器**（窄窗 < 900px 时轨道收起） */}
   <div className="@container/thread relative flex min-h-0 min-w-0 w-full flex-1 flex-col">
    <div
     ref={scroller}
     onScroll={(e) => {
      // 滚动即关浮条：位置是 mouseup 那一刻算的，滚走了就贴不住选区
      setSel(null);
      const el = e.currentTarget;
      // 粘性判定（V37/V49，与 `followBottom` 同一函数）：用户上翻（位置比上次观察更靠前，
      // 且确实离底超过阈值）即释放，流式输出不再把视口拽下去；回到阈值内自动恢复跟随。
      if (userScrolledAway(el)) stick.current = false;
      else if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX) stick.current = true;
      // 回底按钮（V47）与释放状态同源：释放即露面，恢复跟随即收起。
      syncAway(!stick.current);
      // 滚到接近顶部时自动再放一页出来（配合下面的按钮，长会话不必手动点）
      if (hidden > 0 && el.scrollTop < 24) loadEarlier();
     }}
     onMouseUp={onMouseUp}
     /* 正文测量宽走 `--measure-content`（中列 85%，两侧各留 7.5%）：输入卡 / 查找条同一档，
        三者左缘对齐；`w-full` + `max-w` 得到的就是 85%（本元素外层无水平内边距，基准 = 中列）。 */
     className="thread-scroll mx-auto w-full max-w-(--measure-content) min-h-0 flex-1 px-5 py-5"
     role="log"
     aria-label={t.threadAria}
    >
     {/* 浮卡留白（V51）：`paddingBottom` = 卡片高度——`.`thread-scroll` 自带 `pb-5`，
         这段是额外垫高，滚到底时最后一条消息停在卡片之上而不是被盖住。 */}
     <div ref={attachContent} style={planCardH > 0 ? { paddingBottom: planCardH } : undefined}>
      {hidden > 0 && (
       <div className="mb-4 flex justify-center">
        <button
         onClick={loadEarlier}
         className="cursor-pointer rounded-md border border-border px-3 py-1 text-[13px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
         aria-label={fmt(t.loadEarlierAria, Math.min(hidden, THREAD_PAGE))}
        >
         {fmt(t.loadEarlier, Math.min(hidden, THREAD_PAGE), hidden)}
        </button>
       </div>
      )}
      {hidden === 0 && historyPage?.before != null && (
       <div className="mb-4 flex flex-col items-center gap-1">
        <button
         onClick={loadEarlierPage}
         disabled={historyPage.loading}
         className="cursor-pointer rounded-md border border-border px-3 py-1 text-[13px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground disabled:opacity-50"
        >
         {historyPage.loading ? t.historyLoading : t.historyLoadEarlier}
        </button>
        {historyPage.error && <span className="text-[12px] text-warn">{fmt(t.historyLoadFailed, historyPage.error)}</span>}
       </div>
      )}
      {hidden === 0 && historyPage?.before == null && historyPage?.error && (
       <div className="mb-4 flex flex-col items-center gap-1">
        <span className="text-[12px] text-warn">{fmt(t.historyLoadFailed, historyPage.error)}</span>
        <button onClick={() => void openSessionWithHistory(activeSessionId)} className="cursor-pointer text-[13px] text-muted hover:text-foreground">
         {t.historyRetry}
        </button>
       </div>
      )}
      {hidden === 0 && historyPage?.skipped && <div className="mb-4 text-center text-[12px] text-warn">{t.historyOversized}</div>}
      {layout.map((item, i) => {
       if (item.kind === "run") {
        // 聚合折叠行（v2）：命令批 / 编辑卡——展开仍是逐条 ToolRow
        return <ToolRunRow key={item.id} group={item.group} items={item.items} cwd={cwd} />;
       }
       if (item.kind === "turn") {
        // 轮时长行（v2）：收在该轮内容之后
        return <TurnRow key={item.id} span={item.span} />;
       }
       const prev = layout[i - 1];
       // 上一条是痕迹行（工具 / 思考）时收紧间距。聚合行（命令批 / 编辑卡）也是若干工具行
       // 折起来的——不认它，紧跟其后的思考 / 工具行就会白吃一档 `mb-4`（截图里那种空隙）。
       const prevTrace = prev?.kind === "run" ? true : prev?.kind === "msg" ? isTrace(prev.m) : false;
       return (
        <ThreadRow
         key={item.m.id}
         m={item.m}
         sessionId={activeSessionId}
         cwd={cwd}
         onImageOpen={openImage}
         turn={item.m.kind === "user" ? turnByMsgId.get(item.m.id) : undefined}
         tight={isTrace(item.m) && prevTrace}
        />
       );
      })}
      {workingVisible && <WorkingRow tight={isTrace(shown[shown.length - 1])} />}
     </div>
    </div>
    {/* 轮次定位轨：消息列右缘的刻度（scroller 的兄弟，不随内容滚走） */}
    {/* `key` = 会话：换会话重挂，高亮 / 预览 / 轨内滚动位置都不从上一段会话带过来 */}
    <TurnRail key={activeSessionId ?? "none"} items={railItems} scroller={scroller} planCardH={planCardH} onJump={jumpToTurn} />
    <PlanCard onHeightChange={syncPlanCardH} />
    {awayFromBottom && (
     // 回到底部（V47）：离底（> NEAR_BOTTOM_PX）时浮在消息列视口底部中央，点击 = 恢复跟随并读底。
     // 任何离底都露面（不只流式——长会话回看历史同样需要一键回底）。
     // 任务清单浮卡在场时整体上移到卡片之上（V51）——两者都贴底，重叠就点不到了。
     <button
      onClick={jumpToBottom}
      style={{ bottom: planCardH + 16 }}
      className="absolute left-1/2 z-10 flex size-8 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full border border-border bg-elevated text-muted shadow-pop transition-colors duration-100 hover:bg-hover hover:text-foreground"
      aria-label={t.scrollToBottom}
      title={t.scrollToBottom}
     >
      <ArrowDown size={14} aria-hidden />
     </button>
    )}
   </div>
   {sel && (
    // 浮条：fixed 定位（消息列布局一点都不受它影响），mousedown 不夺选区
    <div
     ref={selBar}
     onMouseDown={(e) => e.preventDefault()}
     style={{ left: sel.left, top: sel.top }}
     className="fixed z-50 flex -translate-x-1/2 -translate-y-full items-center gap-0.5 rounded-md border border-border bg-elevated p-0.5 shadow-pop"
    >
     <button
      onClick={quoteSelection}
      className="cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
      aria-label={t.selQuote}
      title={t.selQuote}
     >
      {t.selQuote}
     </button>
     <button
      onClick={askSelection}
      className="cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
      aria-label={t.selAsk}
      title={t.selAsk}
     >
      {t.selAsk}
     </button>
    </div>
   )}
   <ImageLightbox preview={preview} onClose={closePreview} />
  </>
 );
}

/**
 * 流尾是否已经有「正在输出」的行：流式文本 / 未完成的思考 / 正在跑（含参数流式）的工具卡。
 * 有的话界面本身就在动（打字机 / 转圈），不必再补指示行；没有才是「发送后没反应」的窗口——
 * 模型在思考、或刚交完工具结果在等下一步。
 */
const hasLiveTail = (m: ViewMsg | undefined): boolean =>
 !!m &&
 ((m.kind === "text" && !m.complete) ||
  (m.kind === "thinking" && !m.complete) ||
  (m.kind === "tool" && (m.state === "running" || m.state === "streaming")));

/**
 * 「持续成立才露面」的布尔：条件成立后延迟 `delayMs` 才转为真，中途失效立即回落。
 * 服务流式指示行防闪（V46）：段与段之间的一两帧空窗不该让「思考中…」闪一下。
 *
 * 状态翻转在**渲染期**同步重置（React 的「props 变化时派生调整」模式），effect 里只在
 * 定时器到点时 setState——不直接在 effect 体内 setState（react-hooks/set-state-in-effect）。
 */
function useDelayedFlag(active: boolean, delayMs: number): boolean {
 const [state, setState] = useState({ active: false, shown: false });
 if (state.active !== active) setState({ active, shown: false });
 useEffect(() => {
  if (!active) return;
  const timer = window.setTimeout(() => setState({ active: true, shown: true }), delayMs);
  return () => window.clearTimeout(timer);
 }, [active, delayMs]);
 return active && state.shown;
}

/**
 * 流式「思考中…」指示行（纯派生，不写 store）。
 * 视觉与流式思考块同源（呼吸灯泡 + muted 文字）：都是「模型在思考」，读法一致。
 */
function WorkingRow({ tight }: { tight?: boolean }) {
 const t = useText();
 // 走字（V38）：这一段等待已经持续了多久——静止的一行读不出「还在跑」。
 const secs = useElapsedSeconds(true);
 return (
  <div className={`flex items-center gap-1.5 px-1.5 py-[3px] text-[13px] text-muted ${tight ? "mb-1" : "mb-4"}`}>
   <Bulb size={13} aria-hidden className="shrink-0 animate-pulse text-accent" />
   {t.thinking}
   {secs > 0 && (
    <span className="font-mono text-[11px] text-faint" aria-hidden>
     {formatElapsed(secs)}
    </span>
   )}
  </div>
 );
}

/**
 * 思考块（V38 重写）：流式中**自动展开**并实时显示思考文本（读者能看着它长、还有走字秒数），
 * 完成后自动折叠成一行「思考 · N 秒」；用户手动拨过开合就尊重用户的选择（touched）。
 * 走字秒数从挂载起算（历史块 complete 恒 true、不会走字）；完成后用 omp 的真实秒数
 * （`thinking_end` 帧携带），历史里没有秒数的块退化为「已思考」而不是假的「0 秒」。
 */
function ThinkingBlock({ m }: { m: Extract<ViewMsg, { kind: "thinking" }> }) {
 const t = useText();
 const [open, setOpen] = useState(() => !m.complete);
 const touched = useRef(false);
 const shown = useRevealedText(m.text, m.complete);
 const secs = useElapsedSeconds(!m.complete);
 const box = useRef<HTMLDivElement>(null);
 useEffect(() => {
  if (m.complete && !touched.current) setOpen(false);
 }, [m.complete]);
 // 流式中内部滚动跟随（思考可以长过 max-h-80；不跟就看着它停住）
 useLayoutEffect(() => {
  const el = box.current;
  if (el && !m.complete) el.scrollTop = el.scrollHeight;
 }, [shown, m.complete]);
 const label = m.complete
  ? m.seconds > 0
   ? fmt(t.thoughtDone, m.seconds)
   : t.thoughtDoneNoSeconds
  : secs > 0
   ? fmt(t.thinkingWithSeconds, secs)
   : t.thinking;
 return (
  <details
   className="group/think"
   open={open}
   onToggle={(e) => setOpen(e.currentTarget.open)}
  >
   <summary
    onClick={() => {
     // 用户拨动过开合 → 完成后不再自动折叠（原生 toggle 语义保持不变）
     touched.current = true;
    }}
    className="flex w-fit cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-[3px] text-[13px] text-muted transition-colors duration-100 hover:bg-hover"
   >
    {/* 思考中：灯泡走 accent 并跟着呼吸；已完成的思考退回静止的 faint（不抢正文） */}
    <Bulb
     size={13}
     className={`shrink-0 ${m.complete ? "text-faint" : "animate-pulse text-accent"}`}
     aria-hidden
    />
    {label}
    <ChevronRight
     size={12}
     aria-hidden
     className="shrink-0 transition-transform duration-150 group-open/think:rotate-90"
    />
   </summary>
   <div
    ref={box}
    className="mt-0.5 mb-1 ml-6 max-h-80 overflow-auto border-l border-border-soft pr-1 pl-3 text-[13px] leading-6 whitespace-pre-wrap text-muted"
   >
    {shown}
   </div>
  </details>
 );
}

/**
 * 「执行痕迹」类消息（工具调用 / 思考）：它们在流里成串出现，行与行之间收紧间距
 * （`mb-4` → 无），读起来是一段紧凑的时间线；正文段落才用整档间距隔开。
 */
const isTrace = (m: ViewMsg | undefined): boolean =>
 !!m && (m.kind === "tool" || m.kind === "thinking");

/**
 * 单条消息行（V2 M8）。
 *
 * 为什么必须 memo：流式输出每个 delta 都会更新 store，整列如果跟着重渲染，
 * 展开到几百上千条时每次 token 都要重算所有 Markdown / 工具卡。
 * `mergeViewMsgs` 只替换发生变化的那条消息、其余保持**同一对象引用**，
 * 所以浅比较即能让"只有正在流式的那一行"重渲染。
 */
const ThreadRow = memo(function ThreadRow({
 m,
 sessionId,
 cwd,
 turn,
 tight,
 onImageOpen,
}: {
 m: ViewMsg;
 sessionId: string | null;
 cwd: string;
 /** 用户消息的轮次序号（轮次定位轨的锚点）；其余消息为空。 */
 turn?: number;
 /** 上一条也是执行痕迹：间距收紧，成串的工具行读成一段。 */
 tight?: boolean;
 /** 点图片打开预览（父层持有浮层；引用稳定，memo 不受影响）。 */
 onImageOpen: (p: ImagePreview) => void;
}) {
 const t = useText();
 return (
  // `data-msg-id`：会话内查找（⌘F）靠它把命中定位回消息行（另一并行任务消费）
  // `data-turn`：轮次定位轨的锚点（只有用户消息有）——轨道按它量阅读线、跳轮
  <div className={`text-sm leading-[1.7] ${tight ? "mb-1" : "mb-4"}`} data-msg-id={m.id} data-turn={turn}>
   {m.kind === "user" && (
    <div className="ml-auto w-fit max-w-[72%]">
     {/* 用户气泡走 `--hover` 级中性填充（MASTER §4.4：右侧窄灰泡、圆角 lg）：一句「这是我说的」
         靠填充与右对齐就够；助手正文保持裸 Markdown 无底色，两者一眼分得开 */}
     <div className="rounded-lg rounded-br-sm bg-hover px-3.5 py-2">
      {m.text && <div className="whitespace-pre-wrap">{m.text}</div>}
      {(m.images?.length ?? 0) > 0 && (
       <div className={`flex flex-wrap gap-2 ${m.text ? "mt-2" : ""}`}>
        {m.images?.map((img, i) => (
         <MessageImage
          key={img.blob ?? `${img.mimeType}:${img.data?.slice(0, 24) ?? ""}:${i}`}
          img={img}
          index={i}
          alt={fmt(t.imageAlt, i + 1)}
          onOpen={onImageOpen}
         />
        ))}
       </div>
      )}
      {(m.imagesOmitted ?? 0) > 0 && (
       <div className="mt-1.5 text-[11px] text-faint">{fmt(t.imagesOmitted, m.imagesOmitted ?? 0)}</div>
      )}
     </div>
    </div>
   )}
   {m.kind === "text" && <AssistantText text={m.text} complete={m.complete} />}
   {m.kind === "thinking" && <ThinkingBlock m={m} />}
   {m.kind === "tool" && <ToolRow m={m} cwd={cwd} />}
   {m.kind === "approval" && sessionId && <ApprovalCard m={m} sessionId={sessionId} />}
   {m.kind === "ui" && sessionId && <UiRequestCard m={m} sessionId={sessionId} />}
   {m.kind === "files" && <MentionChips m={m} cwd={cwd} />}
   {m.kind === "ui-cancel" && null}
   {m.kind === "command" && (
    // 本地命令（`/` 开头）的输出：左侧 accent 竖条 + 正文色——它是用户主动要的结果，
    // 不是模型的解释，所以不给 muted（那会读起来像备注）
    <div className="rounded-md border-l-2 border-accent/40 bg-code px-3 py-2 font-mono text-xs whitespace-pre-wrap text-foreground">
     {m.output}
    </div>
   )}
   {m.kind === "divider" && (m.divider === "subagent" ? (
    // 子代理行（v2 §2.1）：`创建 / 完成 子代理 X` 紧凑行（图标 + 文本），不画分隔线
    <div className="flex items-center gap-1.5 px-1.5 py-[3px] text-[12px] text-muted" role="status">
     <Sparkles size={12} className="shrink-0 text-accent" aria-hidden />
     <span className="min-w-0 truncate">{m.text}</span>
    </div>
   ) : (
    <div className="flex items-center gap-3 py-1">
     <span className="h-px flex-1 bg-border-soft" aria-hidden />
     <span className="text-[11px] text-faint">{m.text}</span>
     <span className="h-px flex-1 bg-border-soft" aria-hidden />
    </div>
   ))}
  </div>
 );
});


