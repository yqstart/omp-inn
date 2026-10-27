import { useRef } from "react";
import { X } from "reicon-react";
import { useText } from "../../lib/useText";
import { useDialogFocus } from "../../lib/useDropdown";


/**
 * 设置页的模态壳（「添加供应商」与「挑选模型」用）：fixed 全屏遮罩 + 居中卡片 + 内容区滚动。
 *
 * 为什么是 fixed 弹窗、而不是行内展开：设置页的 tab 内容区是 `overflow-y-auto` 的滚动容器，
 * 行内展开的长列表（73 个提供商、几十个模型）会把区块撑成一长条；fixed 定位不受滚动容器裁剪，
 * 配过滤框用才顺手。Esc / 点遮罩 / 右上角按钮都关闭（调用方在 `onClose` 里收尾）。
 */
export function DialogShell({
 title,
 onClose,
 children,
 width = "max-w-xl",
 initialFocusRef,
 bodyScroll = true,
}: {
 title: string;
 onClose: () => void;
 children: React.ReactNode;
 /** 卡片最大宽度（默认 `max-w-xl`；表单类给 `max-w-2xl`）。 */
 width?: string;
 /** 初始焦点（如模型挑选的搜索框）；缺省时聚焦卡片。 */
 initialFocusRef?: React.RefObject<HTMLElement | null>;
 /**
  * 内容区是否整体滚动（默认 `true`）。`false` = 内容区按列排布且自身不滚，由子内容
  * 自己挑哪一块滚（子块写 `flex-1 min-h-0 overflow-y-auto`）——长列表的挑选弹窗要的是
  * 「过滤框 / 计数行固定，只有列表滚」（2026-10-19 用户口径），整体滚会把输入框滚出视野。
  */
 bodyScroll?: boolean;
}) {
 const t = useText();
 const cardRef = useRef<HTMLDivElement>(null);
 useDialogFocus(cardRef, true, onClose, initialFocusRef);

 return (
  <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-3 sm:p-6" onClick={onClose}>
   <div
    ref={cardRef}
    tabIndex={-1}
    role="dialog"
    aria-modal="true"
    aria-label={title}
    className={`flex max-h-[85dvh] min-w-0 w-full ${width} flex-col overflow-hidden rounded-xl border border-border bg-elevated shadow-dialog outline-none`}
    onClick={(e) => e.stopPropagation()}
   >
    <div className="flex shrink-0 items-center gap-3 border-b border-border-soft px-4 py-3 sm:px-5">
     <div className="min-w-0 text-sm font-semibold break-words">{title}</div>
     <button
      type="button"
      onClick={onClose}
      aria-label={t.close}
      title={t.close}
      className="ml-auto flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
     >
      <X size={12} aria-hidden />
     </button>
    </div>
    <div
     className={`min-h-0 min-w-0 flex-1 overflow-x-hidden p-4 [overflow-wrap:anywhere] sm:p-5 ${
      bodyScroll ? "overflow-y-auto" : "flex flex-col overflow-y-hidden"
     }`}
    >
     {children}
    </div>
   </div>
  </div>
 );
}
