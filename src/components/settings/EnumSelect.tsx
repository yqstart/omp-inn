import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Loader } from "reicon-react";
import { topDialog, useDropdown } from "../../lib/useDropdown";

/** 下拉里的一项（`label` 已经是界面文本——取值表与 label 解析在 `lib/settingsList.ts` 的 `OPTION_LABELS`）。 */
export type EnumChoice = { value: string; label: string };

/** 列表与视口边缘的间距 / 触发按钮与列表的间距 / 列表高度上限 / 压缩后的最小高度。 */
const MARGIN = 8;
const GAP = 4;
const MAX_HEIGHT = 280;
const MIN_HEIGHT = 96;

/** 默认触发按钮（设置页行内的窄按钮）：内容自适应宽度。 */
const TRIGGER_CLASS =
 "flex min-h-8 max-w-full cursor-pointer items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[12px] transition-colors duration-100 hover:bg-hover disabled:opacity-40";

/** 默认列表项（设置页行内的窄按钮配 13px 正文）。 */
const ITEM_CLASS =
 "block w-full cursor-pointer rounded px-2 py-1 text-left text-[13px] break-words transition-colors duration-100 hover:bg-hover";

/**
 * 思考档下拉的触发按钮形态（模型角色行、失败转移目标行共用）：比默认触发按钮略宽的
 * 行内小按钮，与同一行的「选择 / 清除」按钮同档。**一处定义**——两处的档位下拉是同一个
 * 交互，形态分叉会让同一个「思考档」在不同区块长得不一样。
 */
export const LEVEL_TRIGGER_CLASS =
 "flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[13px] transition-colors duration-100 hover:bg-hover disabled:opacity-50";

/**
 * 枚举下拉的浮层（设置页行内与表单字段共用）。
 *
 * **绝不内嵌展开**：设置页的内容区是唯一滚动容器（`SettingsPage`），行内展开会把后面几十行
 * 设置整体推走、也把「这块区域」变成页面里的一块常驻内容；弹窗里的表单同理（内嵌列表会把
 * 保存按钮推下去，用户实测）。所以列表 `portal` 出去、用 `fixed` 定位贴着触发按钮
 * （`fixed` 不受滚动容器裁剪）：滚动 / 改窗时重算，下方放不下且上方更宽裕时向上弹，
 * 量到位置前先 `visibility: hidden`（不闪左上一帧）。
 *
 * 触发按钮与列表项的形态可由调用方整体覆盖（`triggerClassName` / `itemClassName`）：
 * 「添加供应商」的接口类型要的是**全宽表单字段**（与旁边的输入框同高、等宽字体），
 * 定位与开合逻辑不变。
 *
 * 触发按钮平时显示 `value` 原文；`display` 用来显示与值不同的文本——模型角色的思考档把
 * 「不写后缀」这一档编成空串（`value` 为空串，`display` = 「默认」），不能直接拿值去渲染。
 *
 * 挂载层 = 最上层的模态弹窗（没有则 `document.body`）：弹窗遮罩是 `z-30`，挂在 body 的
 * 列表（`z-10`）会被整个盖住——**「安装插件」弹窗里的项目下拉看不见就是这个**；而且
 * `useDropdown` 只把模态内的浮层当生效浮层（不挂进去就不自动聚焦、Esc 也不先关它）。
 * `fixed` 定位的列表不受弹窗卡片 `overflow-hidden` 裁剪，量出的位置照常可用。
 *
 * 位置直接写 `style`（effect 的职责就是同步 DOM，不为此 setState）：列表只在打开时由
 * React 渲染，`top` / `right` / `maxHeight` 不参与 React 的 style diff，后续重渲染不会
 * 把量好的位置刷掉。
 *
 * 关掉与聚焦交给 `useDropdown`：传 `ignore` 让触发按钮吃自己的点击——同一次点击若在
 * `pointerdown` 关、又在 `click` 开，按钮就永远关不上。
 */
export function EnumSelect({
 label,
 value,
 choices,
 busy = false,
 disabled = false,
 display,
 triggerTitle,
 triggerClassName = TRIGGER_CLASS,
 itemClassName = ITEM_CLASS,
 onPick,
}: {
 /** 行 label（下拉的无障碍名）。 */
 label: string;
 /** 当前值；不是字符串（上游没这个键 / 类型漂移）时显示占位符。 */
 value: string | undefined;
 choices: readonly EnumChoice[];
 busy?: boolean;
 disabled?: boolean;
 /** 触发按钮上显示的文本（缺省 = `value` 原文；值本身不便阅读时用，如空串 = 「默认」档）。 */
 display?: string;
 /** 触发按钮的悬停提示（缺省不加 `title`）。 */
 triggerTitle?: string;
 /** 触发按钮的类名（整体覆盖默认形态）。 */
 triggerClassName?: string;
 /** 列表项的类名（整体覆盖默认形态；选中项的 `text-accent` 由组件追加）。 */
 itemClassName?: string;
 onPick: (value: string) => void;
}) {
 const [open, setOpen] = useState(false);
 const triggerRef = useRef<HTMLButtonElement>(null);
 const close = useCallback(() => setOpen(false), []);
 const listRef = useDropdown(open, close, triggerRef);
 // 打开那一帧解析挂载层：触发按钮就在弹窗里，此刻弹窗必定已在 DOM 中
 const layer = open ? topDialog() ?? document.body : null;

 useLayoutEffect(() => {
  const trigger = triggerRef.current;
  const list = listRef.current;
  if (!open || !trigger || !list) return;
  const place = () => {
   const rect = trigger.getBoundingClientRect();
   // scrollHeight 是内容高度（不受上一轮 maxHeight 影响）；量不到布局时退回上限值
   const height = Math.min(list.scrollHeight || MAX_HEIGHT, MAX_HEIGHT);
   const below = window.innerHeight - rect.bottom - GAP - MARGIN;
   const above = rect.top - GAP - MARGIN;
   const up = height > below && above > below;
   const room = Math.max(MIN_HEIGHT, up ? above : below);
   list.style.top = `${up ? Math.max(MARGIN, rect.top - GAP - Math.min(height, room)) : rect.bottom + GAP}px`;
   list.style.right = `${Math.max(MARGIN, window.innerWidth - rect.right)}px`;
   list.style.minWidth = `${Math.round(rect.width)}px`;
   // 宽度按最长选项撑开（`w-max`），但要夹在「右对齐后不会越过视口左缘」的范围内：
   // 面板右缘贴着触发按钮右缘，可用宽度 = 到左缘的距离；不够时收窄（选项换行，仍不截断）。
   // `min-width` 优先于 `max-width`，所以最窄也就是触发按钮自身的宽度。
   list.style.maxWidth = `${Math.max(
    Math.round(rect.width),
    Math.min(window.innerWidth - 2 * MARGIN, rect.right - MARGIN),
   )}px`;
   list.style.maxHeight = `${Math.min(height, room)}px`;
   list.style.visibility = "visible";
  };
  place();
  // 设置面板滚动 / 窗口缩放都要跟着走（捕获阶段拿所有滚动容器的事件）
  window.addEventListener("scroll", place, true);
  window.addEventListener("resize", place);
  return () => {
   window.removeEventListener("scroll", place, true);
   window.removeEventListener("resize", place);
  };
 }, [open, listRef]);

 return (
  <>
   <button
    ref={triggerRef}
    onClick={() => setOpen((v) => !v)}
    disabled={busy || disabled}
    aria-expanded={open}
    aria-haspopup="listbox"
    aria-label={label}
    title={triggerTitle}
    className={triggerClassName}
   >
    {busy ? <Loader size={11} className="shrink-0 animate-spin" aria-hidden /> : null}
    {/* 值占满余量：全宽按钮（表单字段）上箭头才会靠右；窄按钮的宽度仍由内容决定 */}
    <span className="min-w-0 flex-1 truncate text-left">{display ?? (typeof value === "string" ? value : "—")}</span>
    <ChevronDown size={11} className="shrink-0" aria-hidden />
   </button>
   {layer && createPortal(
    <div
     ref={listRef}
     role="listbox"
     aria-label={label}
     style={{ visibility: "hidden" }}
     className="fixed z-10 w-max max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border border-border bg-elevated p-1 shadow-pop"
    >
     {choices.map((choice) => (
      <button
       key={choice.value}
       onClick={() => {
        close();
        if (choice.value !== value) onPick(choice.value);
       }}
       role="option"
       aria-selected={choice.value === value}
       title={choice.label}
       className={`${itemClassName} ${choice.value === value ? "text-accent" : ""}`}
      >
       {choice.label}
      </button>
     ))}
    </div>,
    layer,
   )}
  </>
 );
}
