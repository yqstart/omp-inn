import { Fragment, useEffect, useRef } from "react";
import { CircleInfo, CodeFile, File, FileText, FileZip, Folder, FolderFiles, Image } from "reicon-react";
import type { IconComponent } from "reicon-react";
import { fileKindOf, type FileKind } from "../../lib/fileKind";
import { splitPath } from "../../lib/toolLine";
import { useText } from "../../lib/useText";

/**
 * 后端 `complete_path` 的单条候选（与 `shared/api.ts` 的返回形状一致）。
 * `path` = 展示 / 定位用（可能是用户写的短标签前缀），`label` = 选中后写进输入框的**短标签**
 * （最短唯一后缀，目录由调用方补尾斜杠）。
 */
export type PathCandidate = {
 /** 展示 / 定位用（短标签补全时保持用户写的前缀）。 */
 path: string;
 /** **真实相对路径**：写进输入框芯片、最终交给 omp 的形态。 */
 real: string;
 isDir: boolean;
 /** 选中后显示在芯片上的短标签（最短唯一后缀）。 */
 label: string;
};

/**
 * 浮层里的一行：路径候选，或「工作区文件」入口（2026-10-20）。
 *
 * 入口只在刚打出 `@`（token 为空）时插在候选**前面**：`@` 路径补全只覆盖当前会话目录，
 * 跨项目的文件原本只有 ⌘⇧P 一条路；把「工作区文件」放进 `@` 浮层，键盘流里也能直达
 * （↑ 一下到入口、Enter 打开引用浮层）。默认高亮仍落在第一条路径上（打 `@` 的主诉求是文件）。
 */
export type MentionRow = { kind: "path"; cand: PathCandidate } | { kind: "workspace" };

/**
 * 类别 → 图标形状。**形状承担辨识度，颜色不承担**（§2 单强调色）：
 * 目录用 `accent`（与左栏文件夹同色），文件一律灰阶。
 */
const KIND_ICON: Record<FileKind, IconComponent> = {
 dir: Folder,
 code: CodeFile,
 doc: FileText,
 image: Image,
 archive: FileZip,
 file: File,
};

/**
 * 输入框 `@` 路径补全浮层：分组标题 + 候选行 + 操作提示行。
 *
 * 行内口径与工具行（`ToolRow`）一致——**主片段是文件基名**（正文色，完整显示），
 * **次要片段是目录**（11px mono `faint`，保留结尾斜杠，放不下时截断）；
 * 识别信息交给图标，不给文件名上色（上游数据是路径，不是我们的文案）。
 *
 * 顶部另有一行**工作区文件**入口（`MentionRow` 的 `workspace` 档）：它属于同一个 listbox，
 * 但用一条细分隔线与路径候选分开——"打开另一个选择器"与"选中一个路径"是两种动作。
 *
 * 取词状态也在这个框里如实说（`status`）：**正在搜**与**没有匹配**都留着这一行——
 * 让浮层无声消失会被当成「补全坏了」（用户实测：输入 `@baselin` 浮层直接没了）。
 */
export function MentionList({
 rows,
 active,
 onPick,
 onHover,
 status = "ready",
}: {
 rows: MentionRow[];
 /** 高亮下标（`-1` = 无高亮）。 */
 active: number;
 onPick: (row: MentionRow) => void;
 onHover: (index: number) => void;
 /** `loading` = 防抖 / 取词中；`empty` = 取完了没有匹配；`ready` = 有候选。 */
 status?: "loading" | "ready" | "empty";
}) {
 const t = useText();
 const boxRef = useRef<HTMLDivElement>(null);
 // 上下键移动高亮时把选中项滚进视野：候选最多 20 条，超出可视区要跟着走
 useEffect(() => {
  boxRef.current?.querySelector('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
 }, [active]);

 return (
  <div className="overflow-hidden rounded-md border border-border bg-elevated shadow-pop">
   <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-faint">{t.mentionListTitle}</div>
   {/* role="listbox" 只包候选行：标题与提示行不是可选项，不该出现在选项列表里 */}
   <div
    ref={boxRef}
    role="listbox"
    aria-label={t.mentionListAria}
    className="max-h-52 overflow-y-auto overscroll-contain pb-1"
   >
    {status === "loading" && <p className="px-2.5 py-1.5 text-[12px] text-faint">{t.mentionListLoading}</p>}
    {status === "empty" && <p className="px-2.5 py-1.5 text-[12px] text-faint">{t.mentionListEmpty}</p>}
    {status === "ready" &&
     rows.map((row, i) => {
      if (row.kind === "workspace") {
       return (
        <Fragment key="workspace-entry">
         <button
          type="button"
          role="option"
          aria-selected={i === active}
          onClick={() => onPick(row)}
          onMouseEnter={() => onHover(i)}
          className={`flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left ${i === active ? "bg-hover" : ""}`}
         >
          <FolderFiles size={14} aria-hidden className="shrink-0 text-accent" />
          <span className="shrink-0 text-[13px] text-foreground">{t.mentionWorkspaceTitle}</span>
          <span className="ml-auto min-w-0 truncate pl-2 text-[11px] text-faint">{t.mentionWorkspaceHint}</span>
         </button>
         {/* 入口与路径候选之间的分隔：两种动作（打开选择器 / 选中路径）不该混成一片；
             没有路径候选时不画（避免悬空的一条线） */}
         {i < rows.length - 1 && <div role="presentation" className="mx-2.5 my-0.5 border-t border-border-soft" />}
        </Fragment>
       );
      }
      const c = row.cand;
      const { base, dir } = splitPath(c.path);
      const Icon = KIND_ICON[fileKindOf(c.path, c.isDir)];
      return (
       <button
        key={`${c.path}\u0000${c.real}`}
        type="button"
        role="option"
        aria-selected={i === active}
        onClick={() => onPick(row)}
        onMouseEnter={() => onHover(i)}
        className={`flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left ${i === active ? "bg-hover" : ""}`}
       >
        <Icon size={14} aria-hidden className={`shrink-0 ${c.isDir ? "text-accent" : "text-muted"}`} />
        <span className="shrink-0 text-[13px] text-foreground">{base}</span>
        {dir && <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">{dir}</span>}
       </button>
      );
     })}
   </div>
   <div className="flex items-center gap-1.5 border-t border-border-soft px-2.5 py-1.5 text-[11px] text-faint">
    <CircleInfo size={12} aria-hidden />
    {t.mentionListHint}
   </div>
  </div>
 );
}
