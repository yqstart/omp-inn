import { Channel } from "@tauri-apps/api/core";
import { api } from "@shared/api";
import type { OmpUpdate, OmpUpdateEvent, OmpUpdateRun, OmpUpdateStatus } from "@shared/types";
import { useApp } from "../stores/app";

/**
 * omp 运行时更新的数据层（左栏字标行的版本 chip + 详情弹窗）：**检查**与**执行**两条路。
 *
 * 上游能力都在 `src-tauri/src/omp_update.rs`：`omp update --check`（只检查）与 `omp update`
 * （真安装，上游自己识别 brew / npm / bun / 独立二进制再选路）。这条链路与本应用的更新
 * （Tauri updater）完全独立：一个是 omp 自己，一个是本应用。
 *
 * 三条约定：
 * - **单飞**：同一时刻只有一个检查在飞（重复调用共用同一次）；更新另有前端 `updating` 闸门
 *   + 后端全局单槽兜底（并发更新返回 BUSY）；
 * - **静默路径有冷却**：启动与「重新检测 omp」都会顺手查一次，间隔小于
 *   [`SILENT_MIN_INTERVAL_MS`] 就直接跳过——手动点（chip / 弹窗的「重新检查」）不受冷却限制；
 * - **失败不弹窗**：静默检查失败只落 `error` 状态（chip 上一个 warn 点 + 弹窗里的原因），
 *   更新失败 / 取消也只落在 `ompUpdateRun` 里（弹窗的日志区 + 一键重试），不打断任何操作。
 */

/** 静默检查（启动 / 健康重检）的最小间隔：检查会打 GitHub。 */
export const SILENT_MIN_INTERVAL_MS = 5 * 60_000;
/** 打开弹窗时，「上次结果多久算旧」——旧了顺手重查一次，让点开的动作总是看到新结论。 */
export const DIALOG_STALE_MS = 10 * 60_000;

/** 回包 → 状态（纯函数，单测锁着）：`latest` 非空 = 有新版本，否则上游判定「已是最新」。 */
export function deriveOmpUpdate(status: OmpUpdateStatus, now: number): OmpUpdate {
 return {
  status: status.latest ? "available" : "latest",
  current: status.current,
  latest: status.latest,
  channel: status.channel,
  message: null,
  checkedAt: now,
 };
}

/** 检查失败 → 状态（纯函数）：保留上一轮已知的当前版本 / 渠道，清掉旧结论（别把旧结论当现状）。 */
export function deriveOmpUpdateError(prev: OmpUpdate, message: string, now: number): OmpUpdate {
 return {
  status: "error",
  current: prev.current,
  latest: null,
  channel: prev.channel,
  message,
  checkedAt: now,
 };
}

/** 静默检查该不该跑（纯函数）：没查过 → 跑；正在查 → 不重入；上次结果还新 → 跳过。 */
export function shouldCheckSilently(state: OmpUpdate, now: number, minIntervalMs: number): boolean {
 if (state.status === "checking") return false;
 if (state.checkedAt === null) return true;
 return now - state.checkedAt >= minIntervalMs;
}

// ==================== 单飞执行 ====================

let inflight: Promise<void> | null = null;

async function runCheck(): Promise<void> {
 const set = useApp.getState().set;
 const prev = useApp.getState().ompUpdate;
 set({ ompUpdate: { ...prev, status: "checking", message: null } });
 try {
  const status = await api.checkOmpUpdate();
  set({ ompUpdate: deriveOmpUpdate(status, Date.now()) });
 } catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  set({ ompUpdate: deriveOmpUpdateError(useApp.getState().ompUpdate, message, Date.now()) });
 }
}

/** 跑一次检查（单飞：并发的调用共用同一次，包含手动与静默两条路径）。 */
export function checkOmpUpdate(): Promise<void> {
 if (inflight) return inflight;
 inflight = runCheck().finally(() => {
  inflight = null;
 });
 return inflight;
}

/** 静默检查（启动 / 「重新检测 omp」）：冷却期内直接跳过，失败只落状态不打扰。 */
export function autoCheckOmpUpdate(): Promise<void> {
 const state = useApp.getState().ompUpdate;
 if (!shouldCheckSilently(state, Date.now(), SILENT_MIN_INTERVAL_MS)) return Promise.resolve();
 return checkOmpUpdate();
}

/** 打开详情弹窗；结果太旧（或从没查过）就顺手重查一次。 */
export function openOmpUpdateDialog(): void {
 useApp.getState().set({ ompUpdateDialogOpen: true });
 if (shouldCheckSilently(useApp.getState().ompUpdate, Date.now(), DIALOG_STALE_MS)) void checkOmpUpdate();
}

// ==================== 执行更新（`omp update`） ====================

/** 弹窗日志区的行数上限（上游装二进制时会输出不少行；超了就丢最老的）。 */
export const OMP_UPDATE_LOG_MAX = 400;

/** 追加一行日志（纯函数，单测锁着）。 */
export function appendOmpUpdateLine(lines: string[], line: string, max = OMP_UPDATE_LOG_MAX): string[] {
 if (lines.length >= max) return [...lines.slice(lines.length - max + 1), line];
 return [...lines, line];
}

/**
 * 事件 → 任务状态（纯函数，单测锁着）。
 *
 * `exit` 只落**终态与结果**：日志与「更新前版本」保留（用户要回看刚才发生了什么）。
 * `to`（更新后版本）留 null——它由成功后的健康检查回填（[`finishUpdateSuccess`]）。
 */
export function reduceOmpUpdateRun(run: OmpUpdateRun | null, event: OmpUpdateEvent): OmpUpdateRun {
 const base: OmpUpdateRun = run ?? { phase: "running", lines: [], from: null, to: null, error: null, startedAt: null };
 if (event.type === "line") return { ...base, lines: appendOmpUpdateLine(base.lines, event.text) };
 return { ...base, phase: event.outcome.phase, from: event.outcome.from ?? base.from, error: event.outcome.error };
}

/** 更新成功后收尾：刷新健康（新版 omp 的路径 / 版本）+ 把新版本回填进任务 + 重查一次。 */
async function finishUpdateSuccess(): Promise<void> {
 let to: string | null = null;
 try {
  // 这里直接用 api.getHealth：`lib/ompDiag.ts` 的 refreshOmpHealth 反向依赖本模块（会成环），
  // 而这一步要的就是「重探 omp 路径与版本」这一件事。
  const health = await api.getHealth();
  useApp.getState().set({ health });
  to = health.omp.ompVersion ?? null;
 } catch {
  // 刷新失败：界面退到「更新命令已完成」的通用文案，不编造版本
 }
 const run = useApp.getState().ompUpdateRun;
 if (to && run) useApp.getState().set({ ompUpdateRun: { ...run, to } });
 await checkOmpUpdate();
}

let updating = false;

/**
 * 执行更新（`omp update`，真安装）：日志流式进 store，终局落 `ompUpdateRun`。
 *
 * - 前端单飞 + 后端单槽双保险（后端对并发返回 BUSY，多窗口 / 快速连点不会起两个安装）；
 * - 成功后刷新健康并重查版本（chip 立刻反映新版本）；
 * - 失败 / 取消**保留**任务记录（用户要看原因，也要能一键重试）。
 */
export function startOmpUpdate(): void {
 const state = useApp.getState();
 if (updating || state.ompUpdateRun?.phase === "running") return;
 updating = true;
 const from = state.ompUpdate.current ?? state.health?.omp.ompVersion ?? null;
 state.set({ ompUpdateRun: { phase: "running", lines: [], from, to: null, error: null, startedAt: Date.now() } });
 const channel = new Channel<OmpUpdateEvent>();
 channel.onmessage = (event) => {
  const s = useApp.getState();
  s.set({ ompUpdateRun: reduceOmpUpdateRun(s.ompUpdateRun, event) });
  if (event.type === "exit") {
   updating = false;
   if (event.outcome.phase === "done") void finishUpdateSuccess();
  }
 };
 api.startOmpUpdate(channel).catch((e) => {
  // 命令本身失败（omp 缺失 / BUSY）：任务落 failed，错误原样进日志区
  updating = false;
  const message = e instanceof Error ? e.message : String(e);
  const run = useApp.getState().ompUpdateRun;
  useApp.getState().set({
   ompUpdateRun: {
    ...(run ?? { phase: "failed", lines: [], from, to: null, error: null, startedAt: Date.now() }),
    phase: "failed",
    error: message,
   },
  });
 });
}

/** 取消进行中的更新（终局经 Channel 的 `exit` 到达：phase = canceled）。 */
export async function cancelOmpUpdate(): Promise<void> {
 try {
  await api.cancelOmpUpdate();
 } catch (e) {
  // 后端回「没有进行中的任务」= 前端这份 running 状态已经过期（任务刚结束、或应用重载过）：
  // 落成失败态并带上原因，别让界面卡在「正在更新…」上。`updating` 必须一起复位，
  // 否则后续点「再次更新」会被前端单飞闸门永久拦住。
  const message = e instanceof Error ? e.message : String(e);
  updating = false;
  const run = useApp.getState().ompUpdateRun;
  if (run?.phase === "running") {
   useApp.getState().set({ ompUpdateRun: { ...run, phase: "failed", error: message } });
  }
 }
}
