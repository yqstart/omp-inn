import { useEffect, useState } from "react";
import { Loader } from "reicon-react";
import { useApp } from "../../stores/app";
import { getAppVersion, openUpdateDialog } from "../../lib/appUpdate";
import { fmt } from "../../lib/locale";
import { useText } from "../../lib/useText";

/**
 * 本应用版本 chip（左栏字标行右端，V30）：显示当前版本 + 上次检查结论，
 * 点击打开 `UpdateDialog`（检查更新按钮在弹窗里——设置 ›「关于」的更新区块已迁到这里）。
 *
 * 与紧邻的 `OmpUpdateChip`（omp 运行时）同款视觉与状态色语义：有新版本 `accent`、
 * 已是最新 `ok`、检查失败 `warn`、还没查过 `faint`；下载 / 检查中是转轮。
 * **颜色不是唯一信号**——完整结论在 `title` / `aria-label` 与弹窗里。
 * 与 omp 链路的区别只是前缀：这里带 `v`（应用版本号），而 omp chip 是裸 semver。
 */
export function AppUpdateChip() {
 const update = useApp((s) => s.update);
 const t = useText();
 const [appVersion, setAppVersion] = useState<string | null>(null);

 useEffect(() => {
  void getAppVersion().then(setAppVersion);
 }, []);

 const status = update.status;
 const busy = status === "checking" || status === "downloading";
 // 有新版本 / 下载中 / 已就绪：显示目标版本（与 omp chip 同口径）；其余显示当前版本
 const upgrading = status === "available" || status === "downloading" || status === "ready";
 const shown = upgrading ? update.version : status === "latest" ? update.current : appVersion ?? t.unknown;
 const label =
  status === "checking"
   ? t.updateChecking
   : status === "available"
    ? fmt(t.updateChipAvailable, update.current, update.version)
    : status === "downloading"
     ? t.updateChipDownloading
     : status === "ready"
      ? fmt(t.updateChipReady, update.version)
      : status === "latest"
       ? fmt(t.updateChipLatest, update.current)
       : status === "error"
        ? t.updateChipError
        : fmt(t.updateChipIdle, appVersion ?? t.unknown);
 const tone =
  status === "available" || status === "ready"
   ? "bg-accent"
   : status === "error"
    ? "bg-warn"
    : status === "latest"
     ? "bg-ok"
     : "bg-faint";

 return (
  <button
   type="button"
   onClick={openUpdateDialog}
   aria-label={label}
   title={label}
   className="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border bg-surface px-1.5 font-mono text-[11px] leading-none text-muted transition-colors duration-100 hover:border-accent/30 hover:bg-hover hover:text-foreground"
  >
   {busy ? (
    <Loader size={12} aria-hidden className="shrink-0 animate-spin" />
   ) : (
    <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${tone}`} />
   )}
   <span className="min-w-0 truncate">v{shown}</span>
  </button>
 );
}
