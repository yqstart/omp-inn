import { useState } from "react";
import {
 Command,
 FilePlus,
 FileText,
 Loader,
 Pen2,
 Search,
 TerminalSquare,
 X,
} from "reicon-react";
import type { ViewMsg } from "@shared/types";
import { fmt } from "../../lib/locale";
import { useText } from "../../lib/useText";
import { useOpenPath } from "../../lib/openPath";
import { toolLineParts, type ToolLineIcon } from "../../lib/toolLine";
import { useElapsedSeconds, formatElapsed } from "../../lib/useElapsed";
import { useApp } from "../../stores/app";
import { isRemoteClient } from "@shared/remote";

/**
 * 工具调用行（原 `ToolCard`）。
 *
 * 形状参考 ZCode 的对话流：**一行**就够，没边框没底色——
 * `图标 + 动词 + 文件基名 + 目录 + +N −M`，展开才给输出。
 * 一次工具调用在长会话里能出现几十上百次，每张卡都画边框+底色会把消息流
 * 压成一摞盒子、正文被淹没；工具调用的信息密度本来就支持压成一行。
 *
 * 状态只画"需要说话"的那几种：成功默认闭嘴（一行流过就是成功），
 * 失败给红叉并自动展开，运行中给转圈——颜色不作唯一信号，`sr-only` 里带状态词。
 * 一次调用只有一行由 `mergeViewMsgs` 的 id 合并保证（见 `src/lib/mergeEvents.ts`）。
 */
/**
 * 工具身份配色：图标与动词同色，main（文件基名 / 命令）仍走正文色。
 *
 * 长会话里工具行占绝大多数，全灰会让整段执行痕迹糊成一片；按**动作性质**给三个色：
 * 读 / 搜 / 跑 = accent（取信息与执行）、写 = ok（新增）、改 = warn（改动既有内容）。
 * 语义色只做**身份**，成功 / 失败仍由既有信号表达（失败是 danger 的 X + danger 主文本、
 * 运行中是 spinner），所以颜色不作唯一信号这条依然成立。
 */
const TONES: Record<ToolLineIcon, string> = {
 read: "text-accent",
 write: "text-ok",
 edit: "text-warn",
 bash: "text-accent",
 search: "text-accent",
 other: "text-muted",
};

export function ToolRow({ m, cwd }: { m: Extract<ViewMsg, { kind: "tool" }>; cwd?: string }) {
 const t = useText();
 const [open, setOpen] = useState(m.state === "error");
 const [showFull, setShowFull] = useState(false);
 const { notice, open: openLocal } = useOpenPath(cwd ?? "");
 // 运行中走字（V38）：长任务（构建 / 安装 / 长命令）需要「还在跑」的活体信号；
 // 终态不显示累计耗时（起点只有挂载时刻，历史回放里没有可信起点，不假装有）。
 const secs = useElapsedSeconds(m.state === "running");
 const stateText =
  m.state === "ok"
   ? t.toolStateOk
   : m.state === "error"
    ? t.toolStateError
    : m.state === "running"
     ? t.toolStateRunning
     : t.toolStateStreaming;
 const line = toolLineParts(m, t);
 // 数据层不再内嵌占位文案：`argsSummary` 可能为空，展示时按状态兜底
 const main = line.main || (m.state === "streaming" ? t.toolStreaming : t.toolNoArgs);
 const failed = m.state === "error";
 const diff = m.diffStat && (m.diffStat.added > 0 || m.diffStat.removed > 0) ? m.diffStat : null;
 return (
  <div role="group" aria-label={fmt(t.toolAria, m.name, stateText)}>
   <button
    onClick={() => setOpen((v) => !v)}
    aria-expanded={open}
    title={[m.intent, stateText].filter(Boolean).join(" · ")}
    className={`flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-[3px] text-left transition-colors duration-100 hover:bg-hover ${open ? "bg-hover" : ""}`}
   >
    <ToolIcon icon={line.icon} />
    <span className={`shrink-0 text-[13px] ${failed ? "text-danger" : TONES[line.icon]}`}>{line.verb}</span>
    <span
     className={`text-[13px] ${line.pathLike ? "shrink-0" : "min-w-0 truncate"} ${failed ? "text-danger" : line.main ? "text-foreground" : "text-muted"}`}
    >
     {main}
    </span>
    {line.sub && <span className="min-w-0 truncate font-mono text-[11px] text-faint">{line.sub}</span>}
    {diff && (
     <span className="flex shrink-0 items-center gap-1 font-mono text-[11px]">
      {diff.added > 0 && <span className="text-ok">+{diff.added}</span>}
      {diff.removed > 0 && <span className="text-danger">−{diff.removed}</span>}
     </span>
    )}
    {/* 成功不画勾：安静的一行本身就是回执。失败 / 运行中才占尾位 */}
    {m.state === "ok" ? null : m.state === "error" ? (
     <X size={12} className="ml-auto shrink-0 text-danger" aria-hidden />
    ) : (
     <Loader size={12} className="ml-auto shrink-0 animate-spin text-accent" aria-hidden />
    )}
    {m.state === "running" && secs > 0 && (
     <span className="shrink-0 font-mono text-[11px] text-faint" aria-hidden>
      {formatElapsed(secs)}
     </span>
    )}
    <span className="sr-only">{stateText}</span>
   </button>
   {open && (
    <div className="mt-0.5 mb-1 ml-6 space-y-1.5">
     {m.path && m.state !== "streaming" && (
      <button
       onClick={() => useApp.getState().setDiffPath(m.path!)}
       className="cursor-pointer text-[13px] text-accent transition-opacity duration-150 hover:opacity-80"
      >
       {t.diffOpen}
      </button>
     )}
     {m.intent && <div className="text-[12px] text-muted">{m.intent}</div>}
     {m.argsSummary && (
      <button
       className="block w-full cursor-pointer truncate text-left font-mono text-[11px] text-faint hover:text-foreground"
       title={fmt(t.toolOpenTitle, m.argsSummary)}
       onClick={() => { if (!isRemoteClient()) void openLocal(m.argsSummary); }}
      >
       {m.argsSummary}
      </button>
     )}
     {m.output && (
      <div>
       <pre className="max-h-60 overflow-auto rounded-md bg-code p-2.5 font-mono text-xs leading-5 whitespace-pre-wrap">
        {showFull && m.outputFull ? m.outputFull : m.output}
       </pre>
       {m.outputFull && (
        <button
         onClick={() => setShowFull((v) => !v)}
         className="mt-1 cursor-pointer text-[13px] text-accent transition-opacity duration-150 hover:opacity-80"
        >
         {showFull ? t.collapse : t.expand}
        </button>
       )}
      </div>
     )}
     {notice && <div className="text-[11px] text-warn">{notice}</div>}
    </div>
   )}
  </div>
 );
}

/** 工具身份图标（Reicon，Outline 权重；尺寸随文字 13px）。 */
function ToolIcon({ icon }: { icon: ToolLineIcon }) {
 const p = { size: 13, className: `shrink-0 ${TONES[icon]}`, "aria-hidden": true } as const;
 if (icon === "read") return <FileText {...p} />;
 if (icon === "write") return <FilePlus {...p} />;
 if (icon === "edit") return <Pen2 {...p} />;
 if (icon === "bash") return <TerminalSquare {...p} />;
 if (icon === "search") return <Search {...p} />;
 return <Command {...p} />;
}
