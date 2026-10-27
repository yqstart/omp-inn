import type { Text } from "./locale";
import { api } from "@shared/api";
import { useApp } from "../stores/app";
import { restartRuntimeForApproval } from "./useSessionEvents";

/** 执行模式循环序（对齐 codex / zcode 的 Shift+Tab）：omp 三档。 */
export const APPROVAL_CYCLE = ["always-ask", "write", "yolo"] as const;

/**
 * 执行模式（权限档）的**唯一真值面**（2026-10-14 收敛）：输入卡上的档位显示与写入都从这里走，
 * 谁都不许再自己缓存一份。
 *
 * 真值有两个来源，别混：
 * - **omp 全局默认**（`tools.approvalMode`）：新会话 spawn 时不带 `--approval-mode`，omp 读它；
 *   壳侧只在「读到 / 写成功」时落 store，**没读到就是 `null`**（过去的做法是拿 `"write"` 兜底，
 *   于是 omp 里明明是别的档、输入卡却显示「写入询问」——用户看到的就是「每次新开对话都不对」）。
 * - **本会话覆盖**（覆盖层 `sessionApproval`）：resume / 重启时作为 `--approval-mode` 传给 omp，
 *   优先于全局默认。启动时从覆盖层**水合**（见 [`loadApprovalState`]）——过去只水合当次运行里
 *   写过的会话，重启应用后存量覆盖全丢，显示与实际生效的档位对不上。
 */

/** 档位名的界面文案（菜单行 / 统计弹窗共用一份）；未知档位回退原文，`null` = 还没有真值。 */
export function approvalName(t: Text, mode: string | null | undefined): string {
 if (!mode) return "";
 if (mode === "always-ask") return t.permAlwaysAsk;
 if (mode === "write") return t.permWrite;
 if (mode === "yolo") return t.permYolo;
 return mode;
}

/** 在途的全局档读取（单飞：App 启动、菜单挂载共用同一次）。 */
let globalLoad: Promise<string | null> | null = null;

/**
 * 读 omp 的全局默认档（`get_global_approval` → `omp config get tools.approvalMode --json`）。
 * 已有值直接命中（`force` 强制重读）；读失败返回 `null` 且**不写 store**——
 * 显示层保持「未知」，下一次调用（打开菜单等）自然重试。
 */
export function ensureGlobalApproval(force = false): Promise<string | null> {
 const cur = useApp.getState().globalApproval;
 if (cur && !force) return Promise.resolve(cur);
 if (!globalLoad) {
  globalLoad = api
   .getGlobalApproval()
   .then((m) => {
    useApp.setState({ globalApproval: m });
    return m;
   })
   .catch(() => null)
   .finally(() => {
    globalLoad = null;
   });
 }
 return globalLoad;
}

/**
 * 启动水合：覆盖层的**本会话覆盖**（存量会话的档位，重启应用后不能丢）+ omp 全局默认档。
 * 两个来源互不依赖，并发读；任一失败都不影响另一个（失败面自己兜底）。
 */
export async function loadApprovalState(): Promise<void> {
 const overlays = api
  .getOverlay()
  .then((ov) => {
   // 后端覆盖层是文件格式（snake_case），wire 上照原样给——别按 camelCase 猜（猜了就是 undefined）
   useApp.setState({ sessionApprovals: { ...(ov.session_approval ?? {}) } });
  })
  .catch(() => undefined);
 await Promise.all([overlays, ensureGlobalApproval()]);
}

/**
 * 写档位（输入卡菜单的唯一写入面）：
 * - **总是写** omp 全局默认档 → 新会话不用再选一遍（用户口径：这是「以后都这样」的那一档）；
 * - 带 `sid`（正在会话里改）时**再写**本会话覆盖 → 本会话立即生效（idle 时重启 runtime 立即换档，
 *   running / 等审批时挂起到本轮结束自动重启，见 [`restartRuntimeForApproval`]）；
 *   不带 `sid`（空态输入卡）就只改全局默认。
 * 返回是否成功（失败保持原档位，不假装切了）。
 */
export async function applyApproval(sid: string | null, mode: string): Promise<boolean> {
 const st = useApp.getState();
 try {
  await api.setGlobalApproval(mode);
  st.set({ globalApproval: mode });
  if (sid) {
   await api.setSessionApproval(sid, mode);
   st.set({ sessionApprovals: { ...useApp.getState().sessionApprovals, [sid]: mode } });
   scheduleApprovalRestart(sid);
  }
  return true;
 } catch {
  return false;
 }
}

/** 档位换完怎么生效：跑着就挂起（转 idle 自动重启，见 `useSessionEvents` 的收敛点），空着就立刻重启。 */
function scheduleApprovalRestart(sid: string): void {
 const st = useApp.getState();
 const status = st.statusBySession[sid]?.state;
 if (status === "running" || status === "awaiting-approval") {
  st.markApprovalRestart(sid);
 } else {
  void restartRuntimeForApproval(sid);
 }
}

/**
 * 会话执行模式循环（Shift+Tab 与执行模式菜单共用）：`always-ask → write → yolo → always-ask`。
 * omp 的档位是启动参数（`--approval-mode`），运行中改不了——写本会话覆盖后按
 * [`scheduleApprovalRestart`] 的节奏生效，不打断进行中的轮次。返回新档位（失败返回 null）。
 */
export async function cycleSessionApproval(sid: string): Promise<string | null> {
 const st0 = useApp.getState();
 const cur = st0.sessionApprovals[sid] ?? (await ensureGlobalApproval());
 const idx = APPROVAL_CYCLE.indexOf(cur as (typeof APPROVAL_CYCLE)[number]);
 const next = APPROVAL_CYCLE[(idx + 1) % APPROVAL_CYCLE.length];
 try {
  await api.setSessionApproval(sid, next);
  const st = useApp.getState();
  st.set({ sessionApprovals: { ...st.sessionApprovals, [sid]: next } });
  scheduleApprovalRestart(sid);
  return next;
 } catch {
  // 写覆盖层失败：静默（徽标不变）
  return null;
 }
}
