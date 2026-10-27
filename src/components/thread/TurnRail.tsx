import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { fmt } from "../../lib/locale";
import { useText } from "../../lib/useText";
import { NEAR_BOTTOM_PX } from "../../lib/threadScroll";
import { activeTurnAt, readingLine } from "../../lib/turnRail";
import type { TurnRailItem, TurnRowTop } from "../../lib/turnRail";

/** 轨内容滚动时两端的淡出带（px），与 `index.css` 的遮罩同步。 */
const FADE_PX = 24;

/**
 * 按当前滚动位置读「读到第几轮」：贴底 = 最新一轮；否则取最后一个行顶不超过阅读线的
 * 已加载轮次。行顶只量消息列里的锚点行（`data-turn`），不量整列——轮次通常几十个，
 * 一次滚动事件量几十个矩形是可接受的开销（与上游的二分读数同量级）。
 */
function readActiveTurn(el: HTMLDivElement, list: TurnRailItem[]): number | null {
 if (list.length === 0) return null;
 const last = list[list.length - 1];
 if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX) return last.turn;
 const origin = el.getBoundingClientRect().top;
 const rows: TurnRowTop[] = [];
 el.querySelectorAll<HTMLElement>("[data-turn]").forEach((row) => {
  const turn = Number(row.dataset.turn);
  if (Number.isSafeInteger(turn)) rows.push({ turn, top: row.getBoundingClientRect().top - origin });
 });
 // 历史页全被收起时没有锚点行：停在最新一轮比留空更像「有东西可读」
 return rows.length === 0 ? last.turn : activeTurnAt(rows, readingLine(el.clientHeight));
}

/**
 * 轮次定位轨（2026-10-21，形态照 DeepSeek Harness 的 `TurnNavigator`）：
 * 消息列右缘一条**固定节距**的刻度轨，一**轮提问**一道短杠——当前读到的那一轮最长最亮，
 * 悬停 / 聚焦出预览（本轮提问 + 最后一条回答），点击把那一轮滚到视口顶部（24px 呼吸位）。
 *
 * 口径（与上游逐条对齐，改之前先看 `lib/turnRail.ts` 的数据面）：
 * - **不按内容比例铺**：节距恒 10px，轮次多了就在轨内滚动（两端遮罩淡出），
 *   这样 100 轮的会话也不会挤成一条灰线；
 * - **颜色只表达「读到哪 / 能不能马上跳」**：当前 = 前景色 + 全长；悬停 = muted + 90%；
 *   未加载（更早的历史页还没展开）= 40% 长 + 60% 不透明；默认 = 边框色 + 60%；
 * - **贴底 = 最新一轮**（`NEAR_BOTTOM_PX` 与 Thread 的跟随同门槛）：在底部时用户关心的
 *   就是刚问的那一轮，不必再按阅读线反推；
 * - **不抢滚动**：指针在轨上时自动跟随暂停（用户正在挑某一轮，别把轨道在他手底下挪走）；
 * - 轮次数 < 2 时整条轨不渲染；容器宽 < 900px 时收起（窄窗里正文两侧没有可站的地方）。
 */
export function TurnRail({
 items,
 scroller,
 planCardH,
 onJump,
}: {
 /** 会话全部轮次（含未加载的历史页）。 */
 items: TurnRailItem[];
 /** 消息列的滚动容器（`.thread-scroll`）：阅读线、贴底判定都读它。 */
 scroller: RefObject<HTMLDivElement | null>;
 /** 任务清单浮卡高度：轨的定位带要让开卡片（卡片贴底、会盖住轨的下半截）。 */
 planCardH: number;
 /** 点击某一轮：已加载 = 直接滚；未加载 = 先展开历史页再滚（`Thread` 负责）。 */
 onJump: (item: TurnRailItem) => void;
}) {
 const t = useText();
 // 初始高亮 = 最新一轮：打开会话本来就读底（Thread 切会话即滚到底），
 // 等 effect 再读会先闪一帧「谁都没高亮」。
 const [active, setActive] = useState<number | null>(() => items[items.length - 1]?.turn ?? null);
 const [preview, setPreview] = useState<{ turn: number; top: number } | null>(null);
 const [fade, setFade] = useState({ top: false, bottom: false });
 const frame = useRef<HTMLElement>(null);
 const railScroller = useRef<HTMLDivElement>(null);
 /** 指针在轨上 = 用户正在挑某一轮：自动把当前轮带进视野的动作暂停（上游同口径）。 */
 const pointerInside = useRef(false);
 const previewId = useId();
 /**
  * 滚动监听里要读最新的轮次表（新提问 / 历史页展开都会换引用），但又不想让监听
  * 每帧重新订阅：表过 ref（**在 layout effect 里写**，render 期不写 ref）。
  */
 const latestItems = useRef(items);
 useLayoutEffect(() => {
  latestItems.current = items;
 }, [items]);
 /**
  * 首帧不读 DOM：打开会话时 Thread 的双 rAF「读底」还没跑，此刻 scrollTop 仍在 0——
  * 按阅读线读会先把第一轮点亮、再被滚到底翻成最新一轮（闪一下）。初始高亮已取最新一轮
  * （会话本来就开在底部）；真正的读数从第一次滚动 / 内容变化开始。
  */
 const initialized = useRef(false);
 const loadedCount = items.reduce((n, item) => n + (item.loaded ? 1 : 0), 0);

 // 轮次数量 / 已加载数变化时重算高亮（流式增量不改这两个数，不必每帧量 DOM）
 useEffect(() => {
  if (!initialized.current) {
   initialized.current = true;
   return;
  }
  const el = scroller.current;
  if (el) setActive(readActiveTurn(el, latestItems.current));
 }, [items.length, loadedCount, scroller]);

 useEffect(() => {
  const el = scroller.current;
  if (!el) return;
  let raf = 0;
  const onScroll = () => {
   if (raf) return;
   raf = requestAnimationFrame(() => {
    raf = 0;
    const current = scroller.current;
    if (current) setActive(readActiveTurn(current, latestItems.current));
   });
  };
  el.addEventListener("scroll", onScroll, { passive: true });
  return () => {
   el.removeEventListener("scroll", onScroll);
   if (raf) cancelAnimationFrame(raf);
  };
 }, [scroller]);

 // 视口变高 / 变矮（输入框长高、查找条、窗口缩放）会改变阅读线，但**不一定派发 scroll**：
 // 盯消息列的尺寸补一次读数（jsdom 没有 ResizeObserver，单测里跳过）。
 useEffect(() => {
  const el = scroller.current;
  if (!el || typeof ResizeObserver === "undefined") return;
  const ro = new ResizeObserver(() => setActive(readActiveTurn(el, latestItems.current)));
  ro.observe(el);
  return () => ro.disconnect();
 }, [scroller]);

 /**
  * 滚轮接力：轨是 scroller 的**兄弟**（不随内容滚走），指针停在轨上时滚轮不会落到消息列。
  * 轨自己装得下（没有溢出）就把 wheel 转给消息列——否则右侧这 28px 会变成「滚不动」的死区；
  * 轨溢出时让它自己滚（`overscroll-behavior: contain` 不许把滚动链漏给会话，上游同口径）。
  */
 const railVisible = items.length >= 2;
 useEffect(() => {
  if (!railVisible) return;
  const nav = frame.current;
  const thread = scroller.current;
  if (!nav || !thread) return;
  const onWheel = (e: WheelEvent) => {
   const rail = railScroller.current;
   if (rail && rail.scrollHeight > rail.clientHeight) return;
   // deltaMode：0 = 像素、1 = 行、2 = 页——直接加 deltaY 会把鼠标滚轮（行）变成 3px 一步
   const step =
    e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * thread.clientHeight : e.deltaY;
   thread.scrollTop += step;
   e.preventDefault();
  };
  nav.addEventListener("wheel", onWheel, { passive: false });
  return () => nav.removeEventListener("wheel", onWheel);
 }, [railVisible, scroller]);

 /** 轨内滚动的两端淡出（只在那一端真的还有内容时挂遮罩，短轨不淡）。 */
 const syncFade = useCallback(() => {
  const el = railScroller.current;
  if (!el) return;
  const top = el.scrollTop > 1;
  const bottom = el.scrollTop < el.scrollHeight - el.clientHeight - 1;
  setFade((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
 }, []);

 // 当前轮次在轨的可视范围内被自动带入视野（指针在上面时不抢：用户正在挑，别挪手底下）
 useLayoutEffect(() => {
  const el = railScroller.current;
  if (!el) return;
  if (!pointerInside.current) {
   const mark = active === null ? null : el.querySelector<HTMLElement>(`[data-turn="${active}"]`);
   if (mark) {
    const top = mark.offsetTop;
    const bottom = top + mark.offsetHeight;
    if (top < el.scrollTop + FADE_PX) el.scrollTop = Math.max(0, top - FADE_PX);
    else if (bottom > el.scrollTop + el.clientHeight - FADE_PX) el.scrollTop = bottom - el.clientHeight + FADE_PX;
   }
  }
  syncFade();
 }, [active, items.length, loadedCount, syncFade]);

 /**
  * 预览锚点：标记中心相对整条轨的位置。**不做纵向夹取**——提示卡本来就比短轨高，
  * 夹进轨高反而会把它从被悬停的那一道上挪开（卡片是浮层，越过轨边不会盖住正文）。
  */
 const showPreview = useCallback((turn: number, mark: HTMLElement) => {
  const box = frame.current?.getBoundingClientRect();
  if (!box) return;
  const rect = mark.getBoundingClientRect();
  setPreview({ turn, top: rect.top + rect.height / 2 - box.top });
 }, []);

 // 轮次太少没有「跳」的意义：整条轨不出现（也不占屏幕右缘的点击面积）
 if (!railVisible) return null;
 const previewItem = preview === null ? undefined : items.find((item) => item.turn === preview.turn);

 return (
  // 定位带：贴着中列右缘，上下各留 24px、底部让开任务清单浮卡——
  // 高度确定，下面轨的 `max-height: 100%` 才有百分比基准（不靠 ResizeObserver 量）。
  <div
   className="pointer-events-none absolute right-3 z-10 hidden w-7 @min-[900px]/thread:block"
   style={{ top: 24, bottom: planCardH + 24 }}
  >
   <nav
    ref={frame}
    aria-label={t.turnRailLabel}
    onPointerEnter={() => {
     pointerInside.current = true;
    }}
    onPointerLeave={() => {
     pointerInside.current = false;
     setPreview(null);
    }}
    style={{ maxHeight: "min(420px, 100%)" }}
    className="pointer-events-auto absolute top-1/2 flex w-7 -translate-y-1/2 cursor-pointer flex-col"
   >
    <div
     ref={railScroller}
     onScroll={syncFade}
     className={`turn-rail-scroll min-h-0 overflow-y-auto ${fade.top ? "turn-rail-fade-top" : ""} ${fade.bottom ? "turn-rail-fade-bottom" : ""}`}
    >
     {/* 6px 的上下留白 = 上游的 RAIL_INSET：第一 / 最后一道杠不贴轨边 */}
     <div className="relative py-1.5">
      {items.map((item) => {
       const current = item.turn === active;
       // 已加载 / 未加载两档只差在「要不要先放历史页」：长度与不透明度一起降一档，
       // 悬停 / 聚焦立刻回到可点的那一档（告诉用户它不是禁用，是还没铺到）
       const bar = current
        ? "scale-x-100 bg-foreground"
        : item.loaded
          ? "scale-x-[.6] bg-border group-hover:scale-x-[.9] group-hover:bg-muted group-focus-visible:scale-x-[.9] group-focus-visible:bg-muted"
          : "scale-x-[.4] bg-border opacity-60 group-hover:scale-x-[.9] group-hover:bg-muted group-focus-visible:scale-x-[.9] group-focus-visible:bg-muted";
       return (
        <button
         key={item.turn}
         type="button"
         data-turn={item.turn}
         aria-label={
          item.loaded ? fmt(t.turnRailJump, item.turn) : fmt(t.turnRailJumpLoad, item.turn)
         }
         aria-current={current ? "true" : undefined}
         aria-describedby={preview?.turn === item.turn ? previewId : undefined}
         onClick={() => onJump(item)}
         onPointerEnter={(e) => showPreview(item.turn, e.currentTarget)}
         onFocus={(e) => showPreview(item.turn, e.currentTarget)}
         onBlur={() => setPreview(null)}
         className="turn-rail-mark group relative block h-2.5 w-full cursor-pointer bg-transparent p-0"
        >
         {/* 键盘焦点：不做整条 28px 的焦点框（那比「当前轮」还抢眼），只给杠所在的
             20×10 区域描一圈 1px accent（上游同口径：按钮 outline:none + 杠上的焦点框） */}
         <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 hidden w-5 rounded-[2px] outline-1 outline-accent outline-offset-[-1px] group-focus-visible:block"
         />
         <span
          aria-hidden
          className={`absolute top-1/2 right-0 h-0.5 w-5 origin-right -translate-y-1/2 rounded-[2px] transition-[scale,background-color] duration-150 ${bar}`}
         />
        </button>
       );
      })}
     </div>
    </div>
    {preview && previewItem && (
     // 预览：贴在轨左侧（浮层语言：--elevated + --shadow-pop + --border-soft），
     // 一轮提问一行、回答三行截断；`pointer-events-none`——卡片不能被悬停，
     // 否则指针从标记移到卡片上就断了预览
     <div
      id={previewId}
      role="tooltip"
      style={{ top: preview.top }}
      className="turn-rail-preview pointer-events-none absolute right-full mr-2.5 w-[min(300px,calc(100cqw-120px))] -translate-y-1/2 rounded-lg border border-border-soft bg-elevated px-3 py-2.5 shadow-pop"
     >
      <div className="line-clamp-1 text-[13px] font-medium text-foreground">
       {previewItem.prompt || fmt(t.turnRailTurn, previewItem.turn)}
      </div>
      {previewItem.response !== "" && (
       <div className="mt-1 line-clamp-3 text-[12px] leading-5 text-faint">{previewItem.response}</div>
      )}
     </div>
    )}
   </nav>
  </div>
 );
}
