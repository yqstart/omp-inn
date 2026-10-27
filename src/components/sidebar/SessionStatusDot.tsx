import type { SessionRowStatus } from "../../lib/sessionRowStatus";

/**
 * 会话行状态点（2026-10-19，形态与档位照 DeepSeek Harness 的 `StateDot`）：
 * **运行中** = 中性灰转圈环（淡轨道 + 一段转动的弧）、**已完成未查看** = 绿实心点、
 * **待处理** = 橙实心点、**空闲** = 不渲染（行首槽位仍占位，标题列不错行）。
 * 视觉参数与静态降级都在 `index.css` 的 `.status-*`。
 *
 * `label` 同时进 `title`（悬停）与 `aria-label`（读屏），与上游给每个状态配读屏标签同口径。
 */
export function SessionStatusDot({ status, label }: { status: SessionRowStatus; label: string }) {
 if (status === "idle") return null;
 if (status === "running") {
  return (
   <span role="img" aria-label={label} title={label} className="inline-flex">
    <svg className="status-spinner" width={14} height={14} viewBox="0 0 24 24" aria-hidden="true">
     <g className="status-spinner-motion">
      <circle className="status-spinner-track" cx="12" cy="12" r="9.5" />
      <circle className="status-spinner-arc" cx="12" cy="12" r="9.5" />
     </g>
    </svg>
   </span>
  );
 }
 return <span role="img" aria-label={label} title={label} className="status-dot" data-state={status} style={{ width: 10, height: 10 }} />;
}
