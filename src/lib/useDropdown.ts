import { useEffect, useRef, type RefObject } from "react";
function isVisible(element: HTMLElement) {
 if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
 if (getComputedStyle(element).visibility === "hidden") return false;
 for (let node: HTMLElement | null = element; node; node = node.parentElement) {
  if (getComputedStyle(node).display === "none") return false;
 }
 return true;
}

/**
 * 最上层的可见模态弹窗（`role="dialog"` + `aria-modal="true"`），没有则 `null`。
 *
 * 弹窗内的浮层用它挑挂载层：弹窗遮罩是 `z-30`，挂 `document.body` 的浮层（`z-10`）会被盖住；
 * 且下面 `useDropdown` 的 `active()` 只把「在模态弹窗里」的浮层当生效浮层——所以弹窗内的浮层
 * 要挂进弹窗（浮层是 `fixed` 定位，祖先的 `overflow` 裁不到它）。
 */
export function topDialog() {
 const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
 for (let i = dialogs.length - 1; i >= 0; i--) {
  if (isVisible(dialogs[i])) return dialogs[i];
 }
 return null;
}

/** 是否有可见的模态弹窗（含各设置弹窗、抽屉等对话框）。 */
export function hasOpenDialog(): boolean {
 return topDialog() !== null;
}
export function useDialogFocus(
 dialogRef: RefObject<HTMLElement | null>,
 open: boolean,
 onClose: () => void,
 initialFocusRef?: RefObject<HTMLElement | null>,
) {
 const closeRef = useRef(onClose);
 useEffect(() => {
  closeRef.current = onClose;
 });

 useEffect(() => {
  const dialog = dialogRef.current;
  if (!open || !dialog) return;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const previousDialog = previous?.closest<HTMLElement>('[role="dialog"]');
  if (topDialog() === dialog && (initialFocusRef || !dialog.contains(document.activeElement))) {
   (initialFocusRef?.current ?? dialog).focus({ preventScroll: true });
  }

  const onKey = (event: KeyboardEvent) => {
   if (event.defaultPrevented || event.isComposing || (event.key !== "Escape" && event.key !== "Tab")) return;
   if (topDialog() !== dialog) return;
   if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeRef.current();
    return;
   }
   const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex], [contenteditable="true"]',
   )).filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") && isVisible(element));
   const first = controls[0];
   const last = controls[controls.length - 1];
   const active = document.activeElement;
   if (!first || !dialog.contains(active) || active === dialog || (event.shiftKey ? active === first : active === last)) {
    event.preventDefault();
    (event.shiftKey ? last ?? dialog : first ?? dialog).focus({ preventScroll: true });
   }
  };
  // 下拉在 document 先处理 Esc，弹窗在 window 再兜底，顺序不依赖挂载先后。
  window.addEventListener("keydown", onKey);
  return () => {
   window.removeEventListener("keydown", onKey);
   // 切去终端或打开另一弹窗后不抢焦点；触发项已删时退回仍可见的父弹窗。
   const active = document.activeElement;
   if (active !== document.body && !dialog.contains(active)) return;
   if (previous && isVisible(previous) && !previous.matches(":disabled")) previous.focus({ preventScroll: true });
   else if (previousDialog && isVisible(previousDialog)) previousDialog.focus({ preventScroll: true });
  };
 }, [dialogRef, initialFocusRef, open]);

}

/**
 * 单开下拉容器：点击外部 / Esc 关闭，打开时聚焦首个可聚焦元素。
 * 解决截图问题 1：模型列表与思考等级弹窗同时开、点外部关不掉。
 *
 * `ignore` 是「由它自己开关」的元素（触发按钮）：pointerdown 落在里面时这里不关——否则
 * 同一次点击先被 pointerdown 关掉、又被随后的 click 打开，按钮就永远关不上（`EnumSelect`
 * 依赖这一条；其它调用方没传 `ignore`，行为与从前一致）。
 */
export function useDropdown(
 open: boolean,
 onClose: () => void,
 ignore?: { readonly current: HTMLElement | null },
) {
 const ref = useRef<HTMLDivElement>(null);
 // 面板挂载时可能已有 autoFocus（输入框）：提交后再读 activeElement 会把输入框误当触发项。
 const focusOnMount = useRef(document.activeElement);
 const closeRef = useRef(onClose);
 useEffect(() => {
  closeRef.current = onClose;
 });

 useEffect(() => {
  const popup = ref.current;
  if (!open || !popup) return;
  const focused = popup.contains(document.activeElement) ? focusOnMount.current : document.activeElement;
  const previous = focused instanceof HTMLElement ? focused : null;
  let restoreFocus = true;
  const active = () => {
   if (!isVisible(popup)) return false;
   const modal = topDialog();
   return !modal || modal.contains(popup);
  };
  const first = Array.from(popup.querySelectorAll<HTMLElement>(
   'input, button, [href], select, textarea, [tabindex]:not([tabindex="-1"])',
  )).find((element) => element.tabIndex >= 0 && !element.matches(":disabled") && isVisible(element));
  if (active()) first?.focus({ preventScroll: true });
  const onDown = (event: PointerEvent) => {
   const target = event.target as Node;
   if (!active() || popup.contains(target) || ignore?.current?.contains(target)) return;
   restoreFocus = false;
   closeRef.current();
  };
  const onKey = (event: KeyboardEvent) => {
   if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || !active()) return;
   // 焦点不一定在浮层里（输入框触发、或用户点回编辑器）：Esc 一律关掉当前浮层
   event.preventDefault();
   event.stopImmediatePropagation();
   closeRef.current();
  };
  document.addEventListener("pointerdown", onDown);
  document.addEventListener("keydown", onKey);
  return () => {
   document.removeEventListener("pointerdown", onDown);
   document.removeEventListener("keydown", onKey);
   if (!restoreFocus || (document.activeElement !== document.body && !popup.contains(document.activeElement))) return;
   if (previous && isVisible(previous) && !previous.matches(":disabled")) previous.focus({ preventScroll: true });
  };
  // `ignore` 是调用方的 ref（`useRef` 的返回值，引用稳定），进依赖只为让 lint 满意
 }, [ignore, open]);

 return ref;
}

/**
 * 「点外部关闭」的**不抢焦点**版：与 `useDropdown` 同一套 document `pointerdown` 口径，
 * 但不聚焦浮层、也不还原焦点——输入卡的 `+` / `/` 面板与 `@` 补全都是**编辑器转交键盘**
 * （↑↓/Tab/Enter 由 `DraftEditor` 的 capture 交给 Composer），抢焦点会打断打字。
 *
 * `isInside(target)` 判断这次 pointerdown 是否算浮层内部（浮层自身 + 它自己的触发按钮）：
 * 返回 `true` 时不关。**触发按钮必须算进去**——否则 pointerdown 先关、随后的 click 又开，
 * 按钮永远关不掉（与 `useDropdown` 的 `ignore` 同一个坑）。
 * 回调与判定放 ref：只有 `open` 翻转才重装监听，每次渲染的新闭包不会多挂一份。
 */
export function useOutsideDismiss(
 open: boolean,
 onDismiss: () => void,
 isInside: (target: Node) => boolean,
) {
 const dismissRef = useRef(onDismiss);
 const insideRef = useRef(isInside);
 useEffect(() => {
  dismissRef.current = onDismiss;
  insideRef.current = isInside;
 });
 useEffect(() => {
  if (!open) return;
  // capture 阶段：子元素 stopPropagation 不该让浮层关不掉（编辑器只拦键盘，但这里不赌）
  const onDown = (event: PointerEvent) => {
   const target = event.target;
   if (!(target instanceof Node)) return;
   if (insideRef.current(target)) return;
   dismissRef.current();
  };
  document.addEventListener("pointerdown", onDown, true);
  return () => document.removeEventListener("pointerdown", onDown, true);
 }, [open]);
}

