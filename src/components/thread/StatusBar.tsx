import { useApp } from "../../stores/app";
import { api } from "@shared/api";
import { contextPercent } from "../../lib/ctxUsage";
import { fmt } from "../../lib/locale";
import { useText } from "../../lib/useText";

/**
 * 输入框工具行的状态件：`CompactButton`（上下文 ≥80% 的压缩行动点）与 `QueueBadge`（排队条数），
 * 加上不可见的 `StatusBar` 读屏播报区。
 *
 * 常驻的 `OmpStatusPill`（「运行中 / 等待审批 / 出错 / 已退出 / 就绪」）已按用户口径整体退场
 * （2026-10-10：「去除红框中的复制和就绪」）——运行迹象由消息列的流式「思考中…」表达，
 * 状态语义本身不变（`statusBySession` 照旧驱动发送语义与读屏播报）。
 */

/**
 * 输入框工具行里的只读用量：上下文占用 / 本轮 token / 耗时 / TTFT。
 *
 * 数据全部来自后端透传的 omp 真值（`omp-state://<id>`）——前端不自算 token、
 * 不猜单位（omp 的 duration/ttft 实测就是毫秒，这里只把它显示成秒）。
 * 没有真值时整块不渲染，不占位、不显示"—"。
 */
export function CompactButton() {
 const t = useText();
 const { activeSessionId, currentRuntime, statusBySession } = useApp();
 // 口径见 lib/ctxUsage：omp 的 percent 就是 0–100，不做区间猜测
 const normalized = contextPercent(currentRuntime?.contextUsage);
 // 上下文占用 ≥80% 才露面：平时不占工具行，满了才是行动点。
 if (normalized == null || normalized < 80 || !activeSessionId) return null;
 const busy = statusBySession[activeSessionId]?.state === "running";
 const run = async () => {
  try {
   await api.compactSession(activeSessionId);
  } catch {
   // 失败走 divider 错误行展示（frameToViewMsgs 的 response 失败分支），此处不弹错
  }
 };
 return (
  <button
   onClick={() => void run()}
   disabled={busy}
   className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-warn/50 px-1.5 py-0.5 text-[11px] text-warn transition-colors duration-100 hover:bg-warn/15 disabled:cursor-default disabled:opacity-40"
   aria-label={fmt(t.compactAria, Math.round(normalized))}
   title={t.compactTitle}
  >
   {fmt(t.compactButton, Math.round(normalized))}
  </button>
 );
}

export function QueueBadge() {
 const t = useText();
 const n = useApp((s) => s.currentRuntime?.queuedCount ?? 0);
 if (!n || n <= 0) return null;
 return (
  <span
   className="flex shrink-0 items-center rounded-md bg-accent/15 px-1.5 py-0.5 text-[11px] text-accent"
   role="status"
   aria-label={fmt(t.queueAria, n)}
   title={t.queueTitle}
  >
   {fmt(t.queueBadge, n)}
  </span>
 );
}


export function StatusBar() {
 // 读屏播报区（`sr-only`，不占视觉空间）：运行态变化时播报。
 const t = useText();
 const { activeSessionId, statusBySession } = useApp();
 const status = activeSessionId ? statusBySession[activeSessionId]?.state : undefined;
 const text =
  status === "running"
   ? t.statusRunning
   : status === "awaiting-approval"
    ? t.statusAwaiting
    : status === "error"
     ? t.statusError
     : status === "exited"
      ? t.statusExited
      : "";
 if (!text) return null;
 return (
  <div className="sr-only" aria-live="polite">
   {text}
  </div>
 );
}
