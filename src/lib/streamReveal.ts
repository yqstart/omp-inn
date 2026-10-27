import { useEffect, useRef, useState } from "react";

/**
 * 流式「平滑揭示」（V38）：把成块到达的文本按帧铺开显示——Codex TUI 的 commit 动画
 * （`streaming/chunking.rs`：平稳期每帧一行、积压时整队追赶）在 GUI 的同构物。
 *
 * 与「人工打字机」的区别（口径边界）：**不设固定速率、不制造滞后**。每帧推进
 * `backlog / REVEAL_CATCHUP_FRAMES`，且两头都做了截断：
 * - 积压 ≤ `REVEAL_SNAP_CHARS`：直接落定（连续逐 token 流永远无感、零滞后）；
 * - 积压 > `REVEAL_FLUSH_CHARS`：整段立刻落下（超大突发 = 非流式供应商一次吐一大块，
 *   逐帧倾倒只会推迟可读内容；Codex 的 catch-up 同样是整队快进）。
 * 中间档（几十 ~ 一千字符的突发）才会看到一次 ~0.2–0.4s 的平滑倾倒。
 */
export const REVEAL_CATCHUP_FRAMES = 8;

/** 积压不超过此值（字符）就直接显示全量——尾部不逐字爬。 */
export const REVEAL_SNAP_CHARS = 24;

/** 积压超过此值（字符）整段落下——不逐帧倾倒大块内容。 */
export const REVEAL_FLUSH_CHARS = 1200;

/**
 * 下一帧应显示的字符数（纯函数）。
 * - `complete`：立即显示全量（收尾不做延迟）；
 * - `target <= shown`：文本被整体替换（缩短）时直接收敛，不回放；
 * - 其余见模块头：小积压落定、大积压整段、中间按 8 帧追赶（至少 1 字符）。
 */
export function nextRevealLength(shown: number, target: number, complete: boolean): number {
 if (complete || target <= shown) return target;
 const backlog = target - shown;
 if (backlog <= REVEAL_SNAP_CHARS || backlog > REVEAL_FLUSH_CHARS) return target;
 return shown + Math.max(1, Math.ceil(backlog / REVEAL_CATCHUP_FRAMES));
}

/** 组合字符 / 变体选择符 / 代理对 / ZWJ 序列：切点不能落在这些码点之间。 */
const isCombining = (cp: number): boolean =>
 (cp >= 0x0300 && cp <= 0x036f) ||
 (cp >= 0x1ab0 && cp <= 0x1aff) ||
 (cp >= 0x1dc0 && cp <= 0x1dff) ||
 (cp >= 0x20d0 && cp <= 0x20ff) ||
 (cp >= 0xfe00 && cp <= 0xfe0f) ||
 (cp >= 0x1f3fb && cp <= 0x1f3ff); // 肤色修饰符

/**
 * 把切点收回到最近的字形边界（纯函数，输入输出都是字符下标）。
 * 只做局部调整：代理对、组合记号、ZWJ 序列不被切开（emoji 中段闪烁的最小防线）。
 */
export function clampToGrapheme(text: string, cut: number): number {
 if (cut <= 0 || cut >= text.length) return cut;
 let i = cut;
 for (let guard = 0; guard < 8 && i > 0; guard++) {
  const prev = text.charCodeAt(i - 1);
  const next = text.codePointAt(i) ?? 0;
  const prevIsHighSurrogate = prev >= 0xd800 && prev <= 0xdbff;
  const prevIsZwj = prev === 0x200d;
  if (prevIsHighSurrogate || prevIsZwj || next === 0x200d || isCombining(next)) {
   i--;
   continue;
  }
  break;
 }
 return Math.max(0, i);
}

/**
 * 平滑揭示 hook：返回当前应显示的（`text` 的前缀）子串。
 *
 * - 挂载时直接显示当时的全量（打开一个正在跑的会话不做「倒放」）；
 * - `complete` 或系统偏好减少动效（`prefers-reduced-motion`）时立即全量；
 * - 文本被替换（同 id 覆盖成更短内容）直接收敛，不回放。
 */
export function useRevealedText(text: string, complete: boolean): string {
 const [shown, setShown] = useState(() => text.length);
 const state = useRef({ shown: text.length });
 const raf = useRef<number | null>(null);
 useEffect(() => {
  const target = text.length;
  if (state.current.shown > target) state.current.shown = target;
  const reduce =
   typeof window !== "undefined" &&
   typeof window.matchMedia === "function" &&
   window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (complete || reduce || state.current.shown >= target) {
   if (state.current.shown !== target) {
    state.current.shown = target;
    setShown(target);
   }
   return;
  }
  const step = () => {
   raf.current = null;
   const cur = state.current.shown;
   const next = Math.min(target, clampToGrapheme(text, nextRevealLength(cur, target, false)));
   if (next !== cur) {
    state.current.shown = next;
    setShown(next);
   }
   if (next < target) raf.current = requestAnimationFrame(step);
  };
  raf.current = requestAnimationFrame(step);
  return () => {
   if (raf.current != null) {
    cancelAnimationFrame(raf.current);
    raf.current = null;
   }
  };
 }, [text, complete]);
 return complete ? text : text.slice(0, shown);
}
