import type { TodoPhase } from "@shared/types";
import { fmt, type Text } from "./locale";

/**
 * 任务清单的状态 → 展示口径：浮卡与右栏「进度」区块共用同一张表（单一真相，
 * 两处渲染不许各写一份映射）。「符号 + 色调 + 文案」三信号，颜色不作唯一信号。
 * 上游实测状态集：`pending` / `in_progress` / `completed` / `blocked`（带 `blocker` 文案）；
 * 未知状态按「待办」档渲染（`TODO_PENDING`）。
 */
export const TODO_DISPLAY: Record<string, { symbol: string; tone: string; label: keyof Text }> = {
 pending: { symbol: "○", tone: "text-faint", label: "planTodo" },
 in_progress: { symbol: "◐", tone: "text-accent", label: "planInProgress" },
 completed: { symbol: "✓", tone: "text-ok", label: "planDone" },
 blocked: { symbol: "⊘", tone: "text-danger", label: "planBlocked" },
};

/** 未知状态的兜底档（与 `pending` 同口径）。 */
export const TODO_PENDING = TODO_DISPLAY.pending;

/** 任务清单计数（浮卡统计文案与「全部完成」判定的唯一来源）。 */
export type TodoCounts = { total: number; done: number; inProgress: number; pending: number; blocked: number };

/** 按状态清点任务（未知状态并入 `pending`，与 `TODO_PENDING` 同口径）。 */
export function countTodos(phases: TodoPhase[]): TodoCounts {
 const c: TodoCounts = { total: 0, done: 0, inProgress: 0, pending: 0, blocked: 0 };
 for (const p of phases) {
  for (const task of p.tasks) {
   c.total += 1;
   if (task.status === "completed") c.done += 1;
   else if (task.status === "in_progress") c.inProgress += 1;
   else if (task.status === "blocked") c.blocked += 1;
   else c.pending += 1;
  }
 }
 return c;
}

/**
 * 浮卡头部统计文案（DeepSeek Harness 口径）：只列**未完成**的档位——「1 进行中 · 10 待处理」
 * （受阻档也占一位）；三档都为空（全部完成）时给完成计数。零计数的档位不出现，不做「0 待处理」。
 */
export function todoStatsText(c: TodoCounts, t: Text): string {
 const parts: string[] = [];
 if (c.inProgress > 0) parts.push(fmt(t.planStatInProgress, c.inProgress));
 if (c.pending > 0) parts.push(fmt(t.planStatTodo, c.pending));
 if (c.blocked > 0) parts.push(fmt(t.planStatBlocked, c.blocked));
 return parts.length > 0 ? parts.join(" · ") : fmt(t.planStatDone, c.done);
}
