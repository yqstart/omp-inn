import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * 卡内浮层的**水平锚定**（2026-10-16 用户口径）：浮层的包含块仍是**整条容器**
 * （`relative` 挂在统计条根上，见 MASTER §4.7——相对按钮定位的宽浮层在窄窗会向左溢出输入卡、
 * 被中列的 `overflow-hidden` 裁掉），但水平位置**跟随被点的项**：居中于触发按钮、再夹在条内。
 *
 * 为什么非要实测（用户实测）：贴着条根右缘展开的浮层与靠左的项隔得很远——点「会话统计」或容量环、
 * 浮层却贴到卡片最右侧；而直接退回「相对按钮 `left-0`」又会复现当年的溢出裁切。
 * 两者兼顾只剩实测一条路：`anchor.offsetLeft`（相对条根，故触发项的包装器**不许**自带 `relative`，
 * 否则它自己就成了包含块）算出按钮中心，再按浮层**实测宽度**把它夹在 `[0, 条宽 − 浮层宽]` 内。
 *
 * 口径与 `lib/streamCaret.ts` 同：**只写 style，不走 state**——测量结果不进 React（省一轮渲染，
 * 也不触发 `react-hooks/set-state-in-effect`）；浮层的 CSS 类保留 `right-0` 作兜底，
 * 没有布局的环境（jsdom）里 `offsetParent` 为 `null`，那时一个字都不写、照旧贴右缘展开。
 *
 * 测量时机：每次渲染（读数推进 / 某一项出现或消失都会挪动按钮，而条宽可能一点没变）
 * + 窗口 resize + 条根 / 按钮 / 浮层的 ResizeObserver。
 */
export function usePopoverAnchor<T extends HTMLElement = HTMLElement>(open: boolean): {
 /** 触发项（按钮自身；它的包含块 = 统计条根）。 */
 anchorRef: RefObject<T | null>;
 /** 浮层根（用来量它自己的实际宽度）。 */
 panelRef: RefObject<HTMLDivElement | null>;
} {
 const anchorRef = useRef<T>(null);
 const panelRef = useRef<HTMLDivElement>(null);

 const place = useCallback(() => {
  const anchor = anchorRef.current;
  const panel = panelRef.current;
  if (!anchor || !panel) return;
  const bar = anchor.offsetParent;
  if (!(bar instanceof HTMLElement)) return;
  const barW = bar.clientWidth;
  const panelW = panel.offsetWidth;
  if (barW <= 0 || panelW <= 0) return;
  const center = anchor.offsetLeft + anchor.offsetWidth / 2;
  const left = Math.round(Math.min(Math.max(center - panelW / 2, 0), Math.max(0, barW - panelW)));
  panel.style.left = `${left}px`;
  panel.style.right = "auto";
 }, []);

 // 每次渲染都摆一次（无依赖数组）：浮层是开的时候才挂载的，重挂载后这一跑就是它的首次定位
 useLayoutEffect(() => {
  if (open) place();
 });

 // 监听器只在打开期间挂一次（每次渲染重复挂会白跑一遍 add/remove）
 useLayoutEffect(() => {
  if (!open) return;
  window.addEventListener("resize", place);
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
  const anchor = anchorRef.current;
  const panel = panelRef.current;
  if (ro) {
   if (anchor) ro.observe(anchor);
   if (panel) ro.observe(panel);
   const bar = anchor?.offsetParent;
   if (bar instanceof HTMLElement) ro.observe(bar);
  }
  return () => {
   window.removeEventListener("resize", place);
   ro?.disconnect();
  };
 }, [open, place]);

 return { anchorRef, panelRef };
}
