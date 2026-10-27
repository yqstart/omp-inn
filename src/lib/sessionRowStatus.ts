import type { SessionStatus } from "../shared/types";

/**
 * 会话行的状态档（2026-10-19，档位与优先级照 DeepSeek Harness 的会话行状态）。
 *
 * 上游取证（`@deepseek-ai/dsh-client-ui-workspace/lib/client.js` 的 `sessionStatuses` +
 * `SessionStatusDots`，点本体在 `dsh-client-ui-primitives` 的 `StateDot`）：**主状态唯一**，
 * 按优先级取第一档，行首 16px 格里只画它——
 * **待处理（warning 橙点）> 运行中（ongoing 转圈环）> 已完成未查看（done 绿点）> 空闲（行内不显示点）**；
 * 待处理那档还会把行尾的相对时间换成紧凑标签（`status.compact.*`：待批准 / 计划待审 / 待回答）。
 *
 * 本壳的对应关系：`awaiting-approval`（omp 的 ask 对话框：审批 / 提问）→ 待处理；
 * `running` → 运行中；`unreadBySession`（后台跑完未读，见「左栏未读」）→ 已完成；其余 → 空闲。
 */
export type SessionRowStatus = "awaiting" | "running" | "done" | "idle";

/** 行状态要用的三个字典键（`TEXT[locale]` 的子集形状；组件把 `useText()` 的 t 直接传进来）。 */
export type SessionRowStatusText = {
 statusAwaiting: string;
 statusRunning: string;
 statusDone: string;
};

/**
 * 派生一行的状态档（唯一口径：行首状态点、行尾标签、悬停文案共用这一份判断）。
 *
 * - `live` = 本壳的实时状态（`store.statusBySession`，只有打开过的会话有记录）；
 *   没记录时退回扫描快照 `running`——与 `ChatSidebar.mergedSessions` 同一口径
 *   （打开过的会话不被「打开那一刻」的快照钉死，没打开过的照旧用行自带值）。
 * - `unread` = 后台跑完未读（`store.unreadBySession`）；**只有不忙时才算**
 *   （正在跑的会话即便上一轮没看也不再标完成，与上游「主状态唯一」一致）。
 */
export function sessionRowStatus(input: {
 live: SessionStatus["state"] | undefined;
 running: boolean;
 unread: boolean;
}): SessionRowStatus {
 const state = input.live ?? (input.running ? "running" : "idle");
 if (state === "awaiting-approval") return "awaiting";
 if (state === "running") return "running";
 return input.unread ? "done" : "idle";
}

/** 状态档 → 状态点的悬停 / 读屏文案（空闲档不渲染状态点，故不进表）。 */
export function sessionRowStatusLabel(status: SessionRowStatus, t: SessionRowStatusText): string | null {
 if (status === "awaiting") return t.statusAwaiting;
 if (status === "running") return t.statusRunning;
 if (status === "done") return t.statusDone;
 return null;
}
