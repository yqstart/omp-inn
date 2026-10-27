import { useCallback, useEffect, useRef, useState } from "react";
import { Accessibility, ArrowUpRight, CheckCircle, HardDrive, Loader, Monitor, Refresh } from "reicon-react";
import { api } from "@shared/api";
import type { SystemPermissionKind, SystemPermissions } from "@shared/types";
import { fmt } from "../../lib/locale";
import { useText } from "../../lib/useText";
import { useVisibleRefresh } from "../../lib/useVisibleRefresh";

const ROW_ICONS = {
 disk: HardDrive,
 accessibility: Accessibility,
 screenCapture: Monitor,
 automation: ArrowUpRight,
} as const;

/**
 * 设置 ›「系统授权」：macOS 四项 TCC 授权的**实际生效状态**与授权入口。
 *
 * 为什么要有这一页：系统设置里那个开关不等于真的生效——ad-hoc 签名 / 证书轮换会让 TCC
 * 库里的记录与当前签名身份对不上，条目在、开关开着，`AXIsProcessTrusted()` 与
 * `CGPreflightScreenCaptureAccess()` 却是 false（computer use 因此报「没有权限」）。
 * 这里直接读 API 的真实返回值（后端 `system_permissions.rs`），不再看开关。
 *
 * 刷新口径：**面板挂载期间每 2 秒回读一次**（纯本地查询，开销可忽略）——用户去系统设置
 * 勾完回来，读数自己就变了；窗口重新获得焦点时另走一次 `useVisibleRefresh` 立刻读，不等下一拍。
 * 屏幕录制在 macOS 上要**重启应用**才对新进程生效，所以未授权时始终挂着那条提示。
 */
export function SystemPermissionsPanel() {
 const t = useText();
 const [state, setState] = useState<SystemPermissions | null>(null);
 const [readError, setReadError] = useState<string | null>(null);
 const [actionError, setActionError] = useState<string | null>(null);
 /** 正在请求的授权类型（操作完成之前不接第二次点击）。 */
 const [opening, setOpening] = useState<SystemPermissionKind | null>(null);
 /** 单飞：2 秒一拍不许叠请求（上一次还没回来就跳过这一拍）。 */
 const inFlight = useRef(false);

 const load = useCallback(async () => {
  if (inFlight.current) return;
  inFlight.current = true;
  try {
   setState(await api.getSystemPermissions());
   setReadError(null);
  } catch (e: unknown) {
   setReadError(fmt(t.systemPermCheckFailed, e instanceof Error ? e.message : String(e)));
  } finally {
   inFlight.current = false;
  }
 }, [t.systemPermCheckFailed]);

 useEffect(() => {
  // 首读放进定时器回调：effect 体内直接 `void load()` 会被
  // `react-hooks/set-state-in-effect` 判成同步 setState（它不区分 await 之后）。
  const first = window.setTimeout(() => void load(), 0);
  const timer = window.setInterval(() => void load(), 2000);
  return () => {
   window.clearTimeout(first);
   window.clearInterval(timer);
  };
 }, [load]);

 useVisibleRefresh(() => void load());

 const open = async (kind: SystemPermissionKind) => {
  setOpening(kind);
  setActionError(null);
  try {
   await api.openSystemPermission(kind);
  } catch (e: unknown) {
   setActionError(fmt(t.systemPermOpenFailed, e instanceof Error ? e.message : String(e)));
  } finally {
   setOpening(null);
  }
 };

 const rows: {
  kind: SystemPermissionKind;
  label: string;
  desc: string;
  granted: boolean;
 }[] = state
  ? [
     { kind: "disk", label: t.systemPermDisk, desc: t.systemPermDiskDesc, granted: state.diskAccess },
     {
      kind: "accessibility",
      label: t.systemPermAccessibility,
      desc: t.systemPermAccessibilityDesc,
      granted: state.accessibility,
     },
     {
      kind: "screenCapture",
      label: t.systemPermScreenCapture,
      desc: t.systemPermScreenCaptureDesc,
      granted: state.screenCapture,
     },
     { kind: "automation", label: t.systemPermAutomation, desc: t.systemPermAutomationDesc, granted: state.automation },
    ]
  : [];

 return (
  <section aria-label={t.tabSystem} className="settings-panel shrink-0">
   <div className="flex items-start justify-between gap-4">
    <div>
     <h1 className="text-[19px] font-semibold tracking-tight">{t.tabSystem}</h1>
     <p className="mt-1 max-w-xl text-[13px] leading-6 text-muted">{t.systemPermissionsIntro}</p>
    </div>
    <button
     type="button"
     onClick={() => void load()}
     className="shrink-0 cursor-pointer rounded-md p-1.5 text-faint transition-colors hover:bg-hover hover:text-foreground"
     aria-label={t.systemPermRefresh}
     title={t.systemPermRefresh}
    >
     <Refresh size={14} aria-hidden />
    </button>
   </div>

   {[
    { kind: "read", message: readError },
    { kind: "action", message: actionError },
   ].map(({ kind, message }) => message && (
    <div
     key={kind}
     role="alert"
     className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger"
    >
     {message}
    </div>
   ))}

   {state === null && !readError && (
    <p className="mt-6 flex items-center gap-2 text-[13px] text-faint">
     <Loader size={14} className="animate-spin" aria-hidden />
     {t.systemPermLoading}
    </p>
   )}

   {state && !state.supported && <p className="mt-6 text-[13px] text-faint">{t.systemPermUnsupported}</p>}

   {state?.supported && (
    <>
     <div className="mt-4 divide-y divide-border-soft border-t border-border-soft">
      {rows.map(({ kind, label, desc, granted }) => {
       const Icon = ROW_ICONS[kind];
       return (
        <div key={kind} data-kind={kind} className="flex min-h-11 items-center gap-3 py-3">
         <Icon size={16} className="shrink-0 text-faint" aria-hidden />
         <div className="min-w-0 flex-1">
          <p className="text-[13px]">{label}</p>
          <p className="mt-0.5 max-w-xl text-[12px] leading-5 text-faint">{desc}</p>
         </div>
         {granted ? (
          <span className="flex shrink-0 items-center gap-1 text-[12px] text-ok">
           <CheckCircle size={13} aria-hidden />
           {t.systemPermGranted}
          </span>
         ) : (
          <button
           type="button"
           disabled={opening === kind}
           onClick={() => void open(kind)}
           className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[12px] text-muted transition-colors hover:bg-hover hover:text-foreground disabled:cursor-wait disabled:opacity-50"
          >
           {t.systemPermGrant}
           <ArrowUpRight size={12} aria-hidden />
          </button>
         )}
        </div>
       );
      })}
     </div>

     {!state.screenCapture && (
      <p className="mt-3 text-[12px] leading-5 text-warn">{t.systemPermRestart}</p>
     )}
    </>
   )}
  </section>
 );
}
