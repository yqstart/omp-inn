import { Download, Loader } from "reicon-react";
import { useApp } from "../../stores/app";
import { openOmpUpdateDialog } from "../../lib/ompUpdate";
import { fmt } from "../../lib/locale";
import { useText } from "../../lib/useText";

/**
 * omp 运行时 chip（左栏字标行右端，V24）：显示当前 omp 版本 + 上次检查的结论，
 * 点击打开 `OmpUpdateDialog`。右端与 `AppUpdateChip`（本应用版本）并排，对齐由字标行的
 * 右端容器负责（这里不再自带 `ml-auto`）。
 *
 * - 状态色三档语义：有新版本 `accent`、已是最新 `ok`、检查失败 `warn`、
 *   还没查过 `faint`——**颜色不是唯一信号**，完整结论（版本 / 渠道 / 失败原因）在
 *   `title` 与弹窗里，`aria-label` 是同一条文案；
 * - **omp 未找到时同一个位置换成「安装 omp」chip**：点击打开 `OmpInstallDialog`，
 *   走 omp 官方安装脚本（`omp.sh/install`）。这样「没装 omp」不再是死路——入口就在
 *   版本 chip 本该在的地方，装完这里自动变回版本号（安装成功后重新 `getHealth`）；
 *   安装中 chip 转圈、失败带 warn 点（原因在弹窗里）。`health` 还没回来（null）时不渲染，
 *   避免启动瞬间闪一个「安装 omp」；
 * - 它是拖拽区（字标行）里的按钮：`<button>` 本身会挡住 Tauri 的拖拽（drag-region 只对
 *   直接落点生效、可点元素拦下），所以点 chip 不会误拖窗口。
 */
export function OmpUpdateChip() {
 const ompUpdate = useApp((s) => s.ompUpdate);
 const run = useApp((s) => s.ompUpdateRun);
 const installRun = useApp((s) => s.ompInstallRun);
 const health = useApp((s) => s.health);
 const set = useApp((s) => s.set);
 const t = useText();
 if (!health) return null;

 // omp 缺失 = 首次安装入口（本地识别由启动时的 getHealth 完成；手动装了可点弹窗里的「重新检测」）
 if (!health.omp.ompPath) {
  const installing = installRun?.phase === "running";
  const failed = installRun?.phase === "failed";
  const label = installing
   ? t.ompInstallChipRunningTip
   : failed
    ? t.ompInstallChipFailedTip
    : t.ompInstallChipTip;
  return (
   <button
    type="button"
    onClick={() => set({ ompInstallDialogOpen: true })}
    aria-label={label}
    title={label}
    className="flex h-6 min-w-0 cursor-pointer items-center gap-1 rounded-md border border-border bg-surface px-1.5 text-[11px] leading-none text-muted transition-colors duration-100 hover:border-accent/30 hover:bg-hover hover:text-foreground"
   >
    {installing ? (
     <Loader size={12} aria-hidden className="shrink-0 animate-spin" />
    ) : failed ? (
     <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn" />
    ) : (
     <Download size={12} aria-hidden className="shrink-0 text-accent" />
    )}
    <span className="min-w-0 max-w-[86px] truncate">{installing ? t.ompInstallChipRunning : t.ompInstallChipLabel}</span>
   </button>
  );
 }

 // 更新进行中优先：chip 转起来，点开就是进度（弹窗里有关不掉的日志区）
 const updating = run?.phase === "running";
 const checking = ompUpdate.status === "checking";
 const available = ompUpdate.status === "available";
 const error = ompUpdate.status === "error";
 // 版本优先取检查结果（它来自本次真正跑起来的那份 omp），其次健康检查的探测值
 const version = ompUpdate.current ?? health.omp.ompVersion ?? t.unknown;
 const label = updating
  ? t.ompUpdateChipRunningTip
  : checking
   ? t.ompUpdateChecking
   : error
    ? t.ompUpdateErrorTip
    : available
     ? fmt(t.ompUpdateAvailableTip, version, ompUpdate.latest ?? "")
     : ompUpdate.checkedAt === null
      ? t.ompUpdateEntryAria
      : fmt(t.ompUpdateLatestTip, version, ompUpdate.channel ?? t.unknown);
 const tone = updating || checking || ompUpdate.checkedAt === null
  ? "bg-faint"
  : available
   ? "bg-accent"
   : error
    ? "bg-warn"
    : "bg-ok";

 return (
  <button
   type="button"
   onClick={openOmpUpdateDialog}
   aria-label={label}
   title={label}
   className="flex h-6 min-w-0 cursor-pointer items-center gap-1 rounded-md border border-border bg-surface px-1.5 font-mono text-[11px] leading-none text-muted transition-colors duration-100 hover:border-accent/30 hover:bg-hover hover:text-foreground"
  >
   {updating || checking ? (
    <Loader size={12} aria-hidden className="shrink-0 animate-spin" />
   ) : (
    <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${tone}`} />
   )}
   <span className="min-w-0 max-w-[86px] truncate">{available && ompUpdate.latest ? ompUpdate.latest : version}</span>
  </button>
 );
}
