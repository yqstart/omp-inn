import { Channel } from "@tauri-apps/api/core";
import { api } from "@shared/api";
import type { OmpUpdateEvent } from "@shared/types";
import { useApp } from "../stores/app";
import { autoCheckOmpUpdate, reduceOmpUpdateRun } from "./ompUpdate";

/**
 * omp 首次安装的数据层（左栏「安装 omp」chip + 安装弹窗）。
 *
 * 与本应用的更新、omp 的更新都是独立链路：这里跑的是 **omp 官方安装脚本**
 * （`curl -fsSL https://omp.sh/install | sh`，Windows 为 `install.ps1`），只在
 * `get_health` 识别不到 omp 时出现。壳侧不自己拼 brew / npm 命令——安装方式由官方脚本识别。
 *
 * 口径与 `lib/ompUpdate.ts` 一致：
 * - **单飞**：前端 `installing` 闸门 + 后端全局单槽（与更新互斥，并发返回 BUSY）；
 * - 过程与终局都走 Channel（`line` 流式日志 + `exit` 终局），弹窗关闭不中断任务；
 * - 失败 / 取消保留日志与原因，可一键重试；
 * - 成功（或脚本成功但暂时没识别到 omp）都重新 `getHealth` 识别一次——识别到了就顺手
 *   静默查一次 omp 版本，让左栏 chip 从「安装 omp」变回版本号。
 */

let installing = false;

/**
 * 安装完成后的收尾：重新识别 omp（路径 / 版本 / agentDir）。识别**不到**也保留已完成状态
 * （脚本可能把 omp 装到了 PATH 之外，弹窗里有「重新检测 / 指定路径」两条路）。
 */
async function finishInstallSuccess(): Promise<void> {
 let to: string | null = null;
 let found = false;
 try {
  // 直接用 api.getHealth：安装后要的是「重新探测 omp 路径与版本」这一件事，
  // 静默检查更新在下面按需补（`refreshOmpHealth` 会把两件事绑在一起）。
  const health = await api.getHealth();
  useApp.getState().set({ health });
  found = Boolean(health.omp.ompPath);
  to = health.omp.ompVersion ?? null;
 } catch {
  // 刷新失败：界面退到「安装脚本已完成」的通用文案，不编造版本
 }
 const run = useApp.getState().ompInstallRun;
 if (to && run) useApp.getState().set({ ompInstallRun: { ...run, to } });
 if (found) void autoCheckOmpUpdate();
}

/**
 * 安装 omp（官方安装脚本）：日志流式进 `store.ompInstallRun`，终局也落在这里。
 *
 * - 前端单飞 + 后端单槽（与 omp 更新互斥；快速连点不会起两个安装）；
 * - 成功后自动重新识别 omp，chip 立刻从「安装 omp」变回版本号；
 * - 失败 / 取消保留任务记录（看原因、一键重试）。
 */
export function startOmpInstall(): void {
 const state = useApp.getState();
 if (installing || state.ompInstallRun?.phase === "running") return;
 installing = true;
 state.set({ ompInstallRun: { phase: "running", lines: [], from: null, to: null, error: null, startedAt: Date.now() } });
 const channel = new Channel<OmpUpdateEvent>();
 channel.onmessage = (event) => {
  const s = useApp.getState();
  s.set({ ompInstallRun: reduceOmpUpdateRun(s.ompInstallRun, event) });
  if (event.type === "exit") {
   installing = false;
   if (event.outcome.phase === "done") void finishInstallSuccess();
  }
 };
 api.installOmp(channel).catch((e) => {
  // 命令本身失败（BUSY / 启动不了脚本）：任务落 failed，错误原样进日志区
  installing = false;
  const message = e instanceof Error ? e.message : String(e);
  const run = useApp.getState().ompInstallRun;
  useApp.getState().set({
   ompInstallRun: {
    ...(run ?? { phase: "failed", lines: [], from: null, to: null, error: null, startedAt: Date.now() }),
    phase: "failed",
    error: message,
   },
  });
 });
}

/** 取消进行中的安装（后端与更新共用一条取消命令；终局经 Channel 的 `exit` 到达）。 */
export async function cancelOmpInstall(): Promise<void> {
 try {
  await api.cancelOmpUpdate();
 } catch (e) {
  // 后端回「没有进行中的任务」= 前端这份 running 状态已经过期（任务刚结束、或应用重载过）：
  // 落成失败态并带上原因，别让界面卡在「正在安装…」上。`installing` 必须一起复位，
  // 否则后续点「重新安装」会被前端单飞闸门永久拦住。
  const message = e instanceof Error ? e.message : String(e);
  installing = false;
  const run = useApp.getState().ompInstallRun;
  if (run?.phase === "running") {
   useApp.getState().set({ ompInstallRun: { ...run, phase: "failed", error: message } });
  }
 }
}
