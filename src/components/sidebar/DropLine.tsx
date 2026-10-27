/**
 * 拖拽插入指示线（V26）：零高度包装 + 绝对定位的细线——插入点落在行与行之间，
 * 但不改变布局（拖拽时不抖）。组的成员列表与平铺模式的列表共用。
 *
 * `data-drop-line` 是稳定的 DOM 钩子（界面核对 / 自动化断言用）。
 */
export function DropLine() {
 return (
  <div aria-hidden data-drop-line className="relative h-0">
   <span className="absolute -top-px right-1 left-1 h-0.5 rounded-full bg-accent" />
  </div>
 );
}
