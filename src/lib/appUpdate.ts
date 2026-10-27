import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { useApp } from "../stores/app";
import { TEXT } from "./locale";
import type { UpdateState } from "@shared/types";

/**
 * 应用内更新：直接面向 GitHub Release `latest.json`（Tauri updater 标准链路）。
 * 入口 = 左栏字标行的版本 chip（V30，`components/sidebar/AppUpdateChip.tsx`）→ `UpdateDialog`；
 * 检查更新的按钮也在弹窗里（设置 ›「关于」的更新区块已随 V30 迁走）。
 * 检查结论一律落在 chip 上（与 omp 链路 `lib/ompUpdate.ts` 同款语义）：`checking` 转轮 →
 * `latest` 绿点 / `available` accent / `error` warn——**auto 与 manual 共用同一套落库**，
 * 区别只在「有新版本时是否自动弹窗」。
 * - auto（启动静默检查）：有新版本弹窗提醒（本轮已「稍后」过则只留 chip 上的状态），不打断用户。
 * - manual（chip / 弹窗里点检查）：有更新弹窗；无更新 / 失败在弹窗里给明确反馈。
 * - 稍后：关闭弹窗但保留 chip 上的状态，下次启动重新检查。
 * - 安装完成：询问「立即重启 / 稍后」（稍后则下次启动生效）。
 */

let pending: Update | null = null;
let checking = false;
let installing = false;

function isTauri(): boolean {
 return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function setUpdate(p: { update?: UpdateState; updateDismissedVersion?: string | null; updateDialogOpen?: boolean }) {
 useApp.setState(p as never);
}

let versionPromise: Promise<string> | null = null;

/** 本应用版本（非 Tauri 环境或取不到时给 "dev"）。单飞缓存——一次运行里版本不变。 */
export function getAppVersion(): Promise<string> {
 versionPromise ??= (async () => {
  if (!isTauri()) return "dev";
  try {
   return await getVersion();
  } catch {
   return "dev";
  }
 })();
 return versionPromise;
}

/** 启动时调用一次：静默检查，结论落在版本 chip 上（转轮 → 绿点 / accent / warn）。 */
export async function autoCheckOnBoot(): Promise<void> {
 if (!isTauri() || import.meta.env.DEV) return;
 // 稍后过的版本本轮不再打扰（重启后重置）
 await checkForUpdate("auto").catch(() => undefined);
}

export async function checkForUpdate(
 mode: "auto" | "manual",
): Promise<"available" | "latest" | "skipped" | "error"> {
 const st = useApp.getState();
 if (!isTauri()) return "skipped";
 if (import.meta.env.DEV) {
  if (mode === "manual") setUpdate({ update: { status: "error", message: TEXT[useApp.getState().locale].devNoUpdateCheck } });
  return "skipped";
 }
 if (checking || installing) return "skipped";
 checking = true;
 // auto 与 manual 都写 checking：chip 立刻转轮，不停在「还没查」的灰点上（与 omp 链路同款）
 setUpdate({ update: { status: "checking" } });
 try {
  const update = await check();
  if (!update) {
   if (pending) {
    await pending.close().catch(() => undefined);
    pending = null;
   }
   const current = await getAppVersion();
   // 已是最新：auto 与 manual 同一结论（chip 绿点）——旧口径 auto 写 idle，chip 会一直灰
   setUpdate({ update: { status: "latest", current } });
   return "latest";
  }
  pending = update;
  setUpdate({
   update: {
    status: "available",
    version: update.version,
    current: update.currentVersion,
    body: update.body ?? null,
   },
   // auto 且本轮已稍后：只留 chip 上的状态不弹窗；否则弹窗
   updateDialogOpen: mode === "manual" ? true : st.updateDismissedVersion !== update.version,
  });
  return "available";
 } catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  // 失败落 error（auto 也一样）：chip 黄点、原因在弹窗里——「还没查」与「查失败」不给同一种灰
  setUpdate({ update: { status: "error", message } });
  return "error";
 } finally {
  checking = false;
 }
}

/** 稍后：关闭弹窗，chip 上的状态保留；本轮 auto 不再弹窗打扰。 */
export function deferUpdate(): void {
 const st = useApp.getState();
 if (st.update.status === "available") {
  setUpdate({ updateDismissedVersion: st.update.version, updateDialogOpen: false });
 } else {
  setUpdate({ updateDialogOpen: false });
 }
 // available 状态本身保留（入口常亮），只关弹窗
}

export function openUpdateDialog(): void {
 setUpdate({ updateDialogOpen: true });
}

/** 立即更新：下载 → 安装 → 询问重启。取消重启则下次启动生效。 */
export async function installUpdate(): Promise<"updated" | "deferred" | "error" | "skipped"> {
 if (!pending) return "skipped";
 if (installing) return "skipped";
 installing = true;
 const update = pending;
 const st = useApp.getState();
 if (st.update.status !== "downloading") {
  setUpdate({
   update: { status: "downloading", version: update.version, downloaded: 0, total: null },
  });
 }
 try {
  await update.downloadAndInstall((event: DownloadEvent) => {
   if (event.event === "Started") {
    setUpdate({
     update: {
      status: "downloading",
      version: update.version,
      downloaded: 0,
      total: event.data.contentLength ?? null,
     },
    });
   } else if (event.event === "Progress") {
    const cur = useApp.getState().update;
    if (cur.status === "downloading") {
     setUpdate({
      update: { ...cur, downloaded: cur.downloaded + event.data.chunkLength },
     });
    }
   }
  });
  setUpdate({ update: { status: "ready", version: update.version } });
  return "deferred";
 } catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  setUpdate({ update: { status: "error", message } });
  return "error";
 } finally {
  installing = false;
 }
}

/** 用户确认重启：关闭更新句柄后 relaunch。 */
export async function relaunchToApply(): Promise<void> {
 if (pending) {
  await pending.close().catch(() => undefined);
  pending = null;
 }
 await relaunch();
}
