import { useState } from "react";
import { ChevronRight, Timer } from "reicon-react";
import { fmt } from "../../lib/locale";
import { formatElapsed } from "../../lib/useElapsed";
import type { TurnSpan } from "../../lib/threadLayout";
import { useText } from "../../lib/useText";

/**
 * 轮时长行（v2 §2.1 的 `Worked for 5m 32s ›`）：一轮（用户消息 → 下一次用户消息之前）的耗时，
 * 收在该轮内容之后。点击展开显示起止本地时刻（可核对，不编造读数）。
 *
 * 数据 = `lib/threadLayout.ts` 的 `TurnSpan`：历史轮次来自 jsonl 的消息时间戳，
 * 实时轮次来自帧到达时刻；没有可信时间的轮次不产这一行。
 */
export function TurnRow({ span }: { span: TurnSpan }) {
 const t = useText();
 const [open, setOpen] = useState(false);
 const secs = Math.max(1, Math.round(span.ms / 1000));
 const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour12: false });
 return (
  <div className="mb-2">
   <button
    onClick={() => setOpen((v) => !v)}
    aria-expanded={open}
    className="flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-[3px] text-[12px] text-faint transition-colors duration-100 hover:bg-hover hover:text-muted"
   >
    <Timer size={12} className="shrink-0" aria-hidden />
    <span>{fmt(t.workedFor, formatElapsed(secs))}</span>
    <ChevronRight size={11} aria-hidden className={`shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
   </button>
   {open && (
    <div className="ml-6 flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1.5 pt-0.5 font-mono text-[11px] text-faint">
     <span>{fmt(t.turnStartedAt, clock(span.startAt))}</span>
     <span>{fmt(t.turnEndedAt, clock(span.endAt))}</span>
    </div>
   )}
  </div>
 );
}
