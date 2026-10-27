import { useState } from "react";
import { CheckListSquare, ChevronRight, Pen2, TerminalSquare, X } from "reicon-react";
import type { ViewMsg } from "@shared/types";
import { useApp } from "../../stores/app";
import { fmt } from "../../lib/locale";
import { splitPath, splitRange, toolLineParts } from "../../lib/toolLine";
import { sumDiff, type ToolGroupKind } from "../../lib/threadLayout";
import { useText } from "../../lib/useText";
import { ToolRow } from "./ToolRow";

type ToolMsg = Extract<ViewMsg, { kind: "tool" }>;

/**
 * 摘要式折叠行（v2 §2.1，对齐 Codex 的 `Ran 3 commands` / `Edited 2 files +26 −1`）：
 * 把相邻的同类工具调用折叠成一行——一次工具一行在长会话里能占几十上百行，
 * 正文被淹没；折叠后「跑了什么」一眼带过，展开仍是逐条原样（复用 `ToolRow`）。
 *
 * - `commands`（bash 批）：单行摘要 + 展开逐条命令；
 * - `edits`（写 / 改文件批）：编辑卡——文件名行常显（点击 = 打开该文件的改动 diff），
 *   行尾 `+N −M` 只染数字（MASTER §4.4）；
 * - `plans`（todo 批）：单行摘要 `更新了 N 次任务清单`——清单**当前状态**看消息列
 *   底部的浮卡（`PlanCard`）。
 */
export function ToolRunRow({ group, items, cwd }: { group: ToolGroupKind; items: ToolMsg[]; cwd: string }) {
 const t = useText();
 const [open, setOpen] = useState(false);
 if (group === "edits") return <EditRunCard items={items} />;
 const failed = items.filter((m) => m.state === "error").length;
 const planRun = group === "plans";
 const label = planRun ? fmt(t.updatedPlan, items.length) : fmt(t.ranCommands, items.length);
 const Icon = planRun ? CheckListSquare : TerminalSquare;
 return (
  <div role="group" aria-label={label} className="mb-1">
   <button
    onClick={() => setOpen((v) => !v)}
    aria-expanded={open}
    className={`flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-[3px] text-left transition-colors duration-100 hover:bg-hover ${open ? "bg-hover" : ""}`}
   >
    <Icon size={13} className="shrink-0 text-accent" aria-hidden />
    <span className="min-w-0 truncate text-[13px] text-muted">{label}</span>
    {failed > 0 && (
     <span className="flex shrink-0 items-center gap-0.5 text-[12px] text-danger">
      <X size={11} aria-hidden />
      {failed}
     </span>
    )}
    <ChevronRight size={12} aria-hidden className={`shrink-0 text-faint transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
   </button>
   {open && (
    <div className="mt-0.5 mb-1 ml-6 space-y-0.5 border-l border-border-soft pl-2">
     {items.map((m) => (
      <ToolRow key={m.id} m={m} cwd={cwd} />
     ))}
    </div>
   )}
  </div>
 );
}

/** 编辑卡：`编辑了 N 个文件 +X −Y` + 文件行（路径 + 行级增量，点击打开 diff）。 */
function EditRunCard({ items }: { items: ToolMsg[] }) {
 const t = useText();
 const { added, removed } = sumDiff(items);
 const label = fmt(t.editedFiles, items.length);
 return (
  <div role="group" aria-label={label} className="mb-2 rounded-lg border border-border bg-surface px-2.5 py-1.5">
   <div className="flex items-center gap-1.5 text-[13px]">
    <Pen2 size={13} className="shrink-0 text-warn" aria-hidden />
    <span className="min-w-0 truncate font-medium text-foreground">{label}</span>
    <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
     {added > 0 && <span className="text-ok">+{added}</span>}
     {removed > 0 && <span className="text-danger">−{removed}</span>}
    </span>
   </div>
   <ul className="mt-1 space-y-px">
    {items.map((m) => {
     const name = m.name === "write" ? t.toolVerbWrite : t.toolVerbEdit;
     const parts = toolLineParts(m, t);
     const { base, dir } = splitPath(splitRange(m.argsSummary).path);
     const d = m.diffStat;
     return (
      <li key={m.id}>
       <button
        onClick={() => {
         if (m.path) useApp.getState().setDiffPath(m.path);
        }}
        disabled={!m.path}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors duration-100 enabled:hover:bg-hover disabled:cursor-default"
        aria-label={fmt(t.editCardOpenAria, parts.main || base)}
        title={m.path ?? undefined}
       >
        <span className="min-w-0 shrink-0 truncate text-[12px] text-foreground">{base || name}</span>
        {dir && <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-faint">{dir}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[10px]">
         {d && d.added > 0 && <span className="text-ok">+{d.added}</span>}
         {d && d.removed > 0 && <span className="text-danger">−{d.removed}</span>}
        </span>
       </button>
      </li>
     );
    })}
   </ul>
  </div>
 );
}
