import { useEffect, useRef, useState } from "react";
import { ArrowUpCircle, Check, CheckCircle, Copy, FolderError, Loader, MinusCircle, Refresh, TriangleWarning } from "reicon-react";
import { useApp } from "../../stores/app";
import { cancelOmpUpdate, checkOmpUpdate, startOmpUpdate } from "../../lib/ompUpdate";
import { pickOmpExecutable, refreshOmpHealth, type DiagResult } from "../../lib/ompDiag";
import { fmt } from "../../lib/locale";
import { useText } from "../../lib/useText";
import { ConfirmDialog } from "../ConfirmDialog";
import { DialogShell } from "../settings/DialogShell";

/**
 * omp 运行时弹窗（V24）——左栏字标行的 omp 版本 chip 点开的落点：**检查与更新都在这**。
 *
 * - 数据 = `omp update --check`（只检查）与 `omp update`（真安装）；安装由**上游**选路
 *   （它自己识别 brew / npm / bun / mise / nix / 独立二进制），壳侧不替它拼命令；
 * - 更新走二次确认（`ConfirmDialog`）→ 日志区流式输出（后端已去 ANSI，行数有上限）→
 *   成功刷新健康 + 重查版本，失败 / 取消保留日志与原因、可一键再次更新；
 * - **关闭弹窗不会中断更新**（后端任务继续，chip 上转圈）；重新打开还能看到日志与结果；
 * - 上游错误原文（`message` / `run.error`）原样透传，不翻译；
 * - **安装信息（V31：原设置 ›「关于」的诊断区搬来这里）**：omp 路径 / agentDir 的展示与复制、
 *   重新检测、手动指定可执行文件——omp 找不到（chip 不渲染、这个弹窗开不出来）时由顶部
 *   `HealthBanner` 兜底。
 */
export function OmpUpdateDialog() {
 const ompUpdate = useApp((s) => s.ompUpdate);
 const run = useApp((s) => s.ompUpdateRun);
 const health = useApp((s) => s.health);
 const locale = useApp((s) => s.locale);
 const set = useApp((s) => s.set);
 const t = useText();
 /** 哪个复制按钮刚复制过（命令 / omp 路径 / agentDir）。 */
 const [copiedKey, setCopiedKey] = useState<"command" | "path" | "agentDir" | null>(null);
 const [diagError, setDiagError] = useState<string | null>(null);
 const [confirming, setConfirming] = useState(false);
 const logRef = useRef<HTMLDivElement>(null);
 const close = () => set({ ompUpdateDialogOpen: false });

 const running = run?.phase === "running";
 const retry = run?.phase === "failed" || run?.phase === "canceled";
 const available = ompUpdate.status === "available";
 const version = ompUpdate.current ?? health?.omp.ompVersion ?? t.unknown;
 const checkedAt = ompUpdate.checkedAt === null
  ? t.ompUpdateNeverChecked
  : new Date(ompUpdate.checkedAt).toLocaleString(locale === "zh-CN" ? "zh-CN" : "en-US", {
   month: "numeric",
   day: "numeric",
   hour: "2-digit",
   minute: "2-digit",
  });

 // 任务态优先于检查态：更新跑起来之后，这个弹窗讲的就是「这次更新」
 const status = running
  ? { icon: <Loader size={16} aria-hidden className="shrink-0 animate-spin text-muted" />, text: t.ompUpdateRunning, tone: "" }
  : run?.phase === "done"
   ? { icon: <CheckCircle size={16} aria-hidden className="shrink-0 text-ok" />, text: t.ompUpdateDone, tone: "text-ok" }
   : run?.phase === "failed"
    ? { icon: <TriangleWarning size={16} aria-hidden className="shrink-0 text-warn" />, text: t.ompUpdateFailed, tone: "text-warn" }
    : run?.phase === "canceled"
     ? { icon: <MinusCircle size={16} aria-hidden className="shrink-0 text-muted" />, text: t.ompUpdateCanceled, tone: "" }
     : ompUpdate.status === "checking"
      ? { icon: <Loader size={16} aria-hidden className="shrink-0 animate-spin text-muted" />, text: t.ompUpdateChecking, tone: "" }
      : available
       ? { icon: <ArrowUpCircle size={16} aria-hidden className="shrink-0 text-accent" />, text: t.ompUpdateStatusAvailable, tone: "text-accent" }
       : ompUpdate.status === "error"
        ? { icon: <TriangleWarning size={16} aria-hidden className="shrink-0 text-warn" />, text: t.ompUpdateStatusError, tone: "text-warn" }
        : { icon: <CheckCircle size={16} aria-hidden className="shrink-0 text-ok" />, text: t.ompUpdateStatusLatest, tone: "text-ok" };

 // 日志自动滚底（新行到达时看最后一行；用户手动上滚也会被下一次到达拉回底——这是「跟随」语义）
 const logLen = run?.lines.length ?? 0;
 useEffect(() => {
  const el = logRef.current;
  if (el) el.scrollTop = el.scrollHeight;
 }, [logLen]);

 // 慢网络下 brew 的下载是静默的（非 TTY 没有进度条）：「已用时」是唯一能证明它还在跑的读数
 const [now, setNow] = useState(() => Date.now());
 useEffect(() => {
  if (!running) return;
  const timer = window.setInterval(() => setNow(Date.now()), 1000);
  return () => window.clearInterval(timer);
 }, [running]);
 const elapsed = running && run?.startedAt
  ? fmt(t.ompUpdateElapsed, Math.floor((now - run.startedAt) / 60_000), Math.floor(((now - run.startedAt) % 60_000) / 1000))
  : null;

 const copy = async (key: "command" | "path" | "agentDir", text: string) => {
  try {
   await navigator.clipboard.writeText(text);
   setCopiedKey(key);
   window.setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
  } catch {
   // 剪贴板不可用（权限 / 非安全上下文）：文本本身就在旁边，可手动选中复制
   setDiagError(t.copyFailed);
  }
 };

 /** 诊断动作（重新检测 / 指定路径）的结果就地显示，不弹全局提示。 */
 const runDiag = async (fn: () => Promise<DiagResult | null>) => {
  const res = await fn();
  setDiagError(res && !res.ok ? (res.message ?? t.opFailed) : null);
 };

 return (
  <>
   <DialogShell title={t.ompUpdateTitle} onClose={close} width="max-w-md">
    <div className="flex items-center gap-2 text-sm">
     {status.icon}
     <span className={`font-medium ${status.tone}`}>{status.text}</span>
     {elapsed && <span className="ml-auto shrink-0 font-mono text-[11px] text-faint">{elapsed}</span>}
    </div>

    <dl className="mt-3 space-y-2 rounded-md bg-background p-3 text-[13px]">
     <div className="flex gap-2">
      <dt className="w-24 shrink-0 whitespace-nowrap text-muted">{t.ompUpdateCurrent}</dt>
      <dd className="min-w-0 flex-1 font-mono break-all">{version}</dd>
     </div>
     <div className="flex gap-2">
      <dt className="w-24 shrink-0 whitespace-nowrap text-muted">{t.ompUpdateLatest}</dt>
      <dd className="min-w-0 flex-1 font-mono break-all">
       {ompUpdate.latest ?? (ompUpdate.status === "latest" ? version : t.unknown)}
      </dd>
     </div>
     <div className="flex gap-2">
      <dt className="w-24 shrink-0 whitespace-nowrap text-muted">{t.ompUpdateChannel}</dt>
      <dd className="min-w-0 flex-1 font-mono break-all">{ompUpdate.channel ?? t.unknown}</dd>
     </div>
     <div className="flex gap-2">
      <dt className="w-24 shrink-0 whitespace-nowrap text-muted">{t.ompUpdateCheckedAt}</dt>
      <dd className="min-w-0 flex-1">{checkedAt}</dd>
     </div>
    </dl>

    {/* 安装信息（V31：原设置 ›「关于」的诊断区搬来这里）：omp 装在哪、agentDir 在哪；
        重新检测 / 指定路径也在这——omp 找不到时这个弹窗开不出来（chip 不渲染），由
        顶部 `HealthBanner` 兜底 */}
    {health && (
     <div className="mt-3 rounded-md border border-border-soft bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
       <span className="text-[13px] font-medium">{t.diagSection}</span>
       <span className={`rounded-sm px-2 py-0.5 font-mono text-[11px] ${health.ok ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn"}`}>
        {health.ok ? t.diagOk : t.diagBad}
       </span>
       <button
        type="button"
        onClick={() => void runDiag(refreshOmpHealth)}
        className="ml-auto flex min-h-7 cursor-pointer items-center gap-1.5 rounded-md bg-background px-2.5 py-1 text-[12px] transition-colors duration-100 hover:bg-hover"
        aria-label={t.recheck}
       >
        <Refresh size={12} aria-hidden />
        {t.recheck}
       </button>
       <button
        type="button"
        onClick={() => void runDiag(pickOmpExecutable)}
        className="flex min-h-7 cursor-pointer items-center gap-1.5 rounded-md bg-background px-2.5 py-1 text-[12px] transition-colors duration-100 hover:bg-hover"
        aria-label={t.pickPath}
        title={t.pickPathTitle}
       >
        <FolderError size={12} aria-hidden />
        {t.pickPath}
       </button>
      </div>
      <dl className="mt-2 space-y-2 text-[13px]">
       <div className="flex gap-2">
        <dt className="w-24 shrink-0 whitespace-nowrap text-muted">{t.ompPath}</dt>
        <dd className="flex min-w-0 flex-1 items-start gap-1.5">
         <span className="min-w-0 flex-1 font-mono break-all">{health.omp.ompPath ?? t.notFound}</span>
         {health.omp.ompPath && (
          <button
           type="button"
           onClick={() => void copy("path", health.omp.ompPath ?? "")}
           className="shrink-0 cursor-pointer rounded-md border border-border p-1 text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
           aria-label={t.copyPath}
           title={t.copyPath}
          >
           {copiedKey === "path" ? <Check size={11} aria-hidden className="text-ok" /> : <Copy size={11} aria-hidden />}
          </button>
         )}
        </dd>
       </div>
       <div className="flex gap-2">
        <dt className="w-24 shrink-0 whitespace-nowrap text-muted">agentDir</dt>
        <dd className="flex min-w-0 flex-1 items-start gap-1.5">
         <span className="min-w-0 flex-1 font-mono break-all">{health.omp.agentDir || t.unknown}</span>
         {health.omp.agentDir && (
          <button
           type="button"
           onClick={() => void copy("agentDir", health.omp.agentDir)}
           className="shrink-0 cursor-pointer rounded-md border border-border p-1 text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
           aria-label={t.copyAgentDir}
           title={t.copyPath}
          >
           {copiedKey === "agentDir" ? <Check size={11} aria-hidden className="text-ok" /> : <Copy size={11} aria-hidden />}
          </button>
         )}
        </dd>
       </div>
      </dl>
      {health.omp.errors.length > 0 && (
       <ul className="mt-2 space-y-0.5 text-[12px] text-warn">
        {health.omp.errors.map((e) => (
         <li key={e}>{e}</li>
        ))}
       </ul>
      )}
      {health.modelsError && <p className="mt-1 text-[12px] text-warn">{health.modelsError}</p>}
      {diagError && (
       <p role="alert" className="mt-1 text-[12px] text-danger">
        {diagError}
       </p>
      )}
      <p className="mt-2 text-[12px] leading-relaxed text-faint">{t.diagFoot}</p>
     </div>
    )}

    {!run && ompUpdate.status === "error" && (
     <div className="mt-3 rounded-md border border-warn/20 bg-warn/10 px-3 py-2 text-[12px] leading-relaxed text-warn">
      <p className="break-words whitespace-pre-line">{ompUpdate.message}</p>
      <p className="mt-1 opacity-80">{t.ompUpdateErrorHint}</p>
     </div>
    )}

    {run?.phase === "done" && (
     <div className="mt-3 rounded-md border border-ok/20 bg-ok/10 px-3 py-2 text-[12px] leading-relaxed text-ok">
      <p>{run.to ? fmt(t.ompUpdateDoneBody, run.to) : t.ompUpdateDoneGeneric}</p>
      <p className="mt-1 opacity-80">{t.ompUpdateDoneHint}</p>
     </div>
    )}

    {run?.phase === "failed" && (
     <div className="mt-3 rounded-md border border-warn/20 bg-warn/10 px-3 py-2 text-[12px] leading-relaxed text-warn">
      <p className="break-words whitespace-pre-line">{run.error}</p>
      <p className="mt-1 opacity-80">{t.ompUpdateFailedHint}</p>
     </div>
    )}

    {run?.phase === "canceled" && (
     <p className="mt-3 rounded-md border border-border-soft bg-surface p-3 text-[12px] leading-relaxed text-muted">
      {t.ompUpdateCanceledBody}
     </p>
    )}

    {run && run.lines.length > 0 && (
     <div
      ref={logRef}
      role="log"
      aria-label={t.ompUpdateLogAria}
      className="mt-3 max-h-40 overflow-y-auto rounded-md bg-code p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all"
     >
      {run.lines.join("\n")}
     </div>
    )}

    {available && !running && (
     <div className="mt-3 rounded-md border border-border-soft bg-surface p-3">
      <div className="text-[13px] font-medium">{t.ompUpdateHowTo}</div>
      <p className="mt-1 text-[12px] leading-relaxed text-muted">{t.ompUpdateHowToBody}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
       <code className="rounded-sm bg-code px-2 py-1 font-mono text-[12px]">{t.ompUpdateCommand}</code>
       <button
        type="button"
        onClick={() => void copy("command", t.ompUpdateCommand)}
        className="flex min-h-7 cursor-pointer items-center gap-1.5 rounded-md bg-background px-2.5 py-1 text-[12px] transition-colors duration-100 hover:bg-hover"
       >
        {copiedKey === "command" ? <Check size={12} aria-hidden className="text-ok" /> : <Copy size={12} aria-hidden />}
        {copiedKey === "command" ? t.copied : t.ompUpdateCopyCommand}
       </button>
      </div>
     </div>
    )}

    <div className="mt-4 flex items-center justify-end gap-2">
     {running ? (
      <button
       type="button"
       onClick={() => void cancelOmpUpdate()}
       className="flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[13px] transition-colors duration-100 hover:bg-hover"
      >
       <MinusCircle size={12} aria-hidden />
       {t.ompUpdateCancel}
      </button>
     ) : (
      <>
       {(available || retry) && (
        <button
         type="button"
         onClick={() => setConfirming(true)}
         className="flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition-opacity duration-100 hover:opacity-90"
        >
         <ArrowUpCircle size={12} aria-hidden />
         {retry ? t.ompUpdateRetry : t.ompUpdateRun}
        </button>
       )}
       <button
        type="button"
        onClick={() => void checkOmpUpdate()}
        className="flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md bg-background px-3 py-1.5 text-[13px] transition-colors duration-100 hover:bg-hover"
       >
        <Refresh size={12} aria-hidden />
        {t.ompUpdateRecheck}
       </button>
       <button
        type="button"
        onClick={close}
        className="flex min-h-8 cursor-pointer items-center rounded-md border border-border px-3 py-1.5 text-[13px] transition-colors duration-100 hover:bg-hover"
       >
        {t.close}
       </button>
      </>
     )}
    </div>
   </DialogShell>

   {/* 更新是不可逆的机器级动作（换掉全局安装）：二次确认里写清「做什么、影响谁、要不要等」 */}
   <ConfirmDialog
    open={confirming}
    title={fmt(t.ompUpdateConfirmTitle, ompUpdate.latest ?? version)}
    detail={t.ompUpdateConfirmBody}
    confirmLabel={t.ompUpdateRun}
    onConfirm={() => {
     setConfirming(false);
     startOmpUpdate();
    }}
    onCancel={() => setConfirming(false)}
   />
  </>
 );
}
