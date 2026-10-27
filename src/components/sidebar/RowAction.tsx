import type { MouseEvent } from "react";
import type { IconComponent } from "reicon-react";

/**
 * 侧栏行尾的悬浮动作键（V43）：行 hover / 行内聚焦时随图标槽浮现的裸图标键。
 *
 * - 样式（size-6 圆角、muted → hover 上色；`danger` 只改 hover 图标色）与无障碍名
 *   （`aria-label` + `title`）统一在这里，各行的图标槽只负责 `group-hover` /
 *   `group-has-focus-visible` 显隐与排布（`focus-within` 会把鼠标点击后的遗留焦点算进来，
 *   图标在鼠标移开后常显——键盘可达用 `has-focus-visible` 表达，2026-10-13 修）；
 * - 点击一律 `preventDefault + stopPropagation`：图标键嵌在 `<summary>` 里时不让它顺带
 *   展开 / 收起所属分组（details 的 toggle 默认行为挂在 click 上）；button 自身无默认行为，
 *   preventDefault 无副作用；
 * - 真正的危险确认（删除工作区 / 对话 / 移除项目）仍由调用方的 `ConfirmDialog` 承担。
 */
export function RowAction({
 label,
 title,
 icon: Icon,
 danger = false,
 disabled = false,
 onClick,
}: {
 label: string;
 /** 悬停提示；不传 = 与 aria-label 同文案。 */
 title?: string;
 icon: IconComponent;
 danger?: boolean;
 disabled?: boolean;
 onClick: () => void;
}) {
 return (
  <button
   type="button"
   disabled={disabled}
   aria-label={label}
   title={title ?? label}
   onClick={(e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
   }}
   className={`flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted transition-colors duration-100 hover:bg-hover disabled:cursor-default disabled:opacity-40 ${danger ? "hover:text-danger" : "hover:text-foreground"}`}
  >
   <Icon size={13} aria-hidden />
  </button>
 );
}
