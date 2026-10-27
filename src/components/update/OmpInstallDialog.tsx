import { useEffect, useRef, useState } from "react";
import { Check, CheckCircle, Copy, Download, FolderError, Loader, MinusCircle, Refresh, TriangleWarning } from "reicon-react";
import { useApp } from "../../stores/app";
import { cancelOmpInstall, startOmpInstall } from "../../lib/ompInstall";
import { pickOmpExecutable, refreshOmpHealth, type DiagResult } from "../../lib/ompDiag";
import { fmt } from "../../lib/locale";
import { useText } from "../../lib/useText";
import { isWindows } from "../../lib/platform";
import { DialogShell } from "../settings/DialogShell";

/**
 * 「安装 omp」弹窗（左栏版本处 omp 缺失时的落点）。
 *
 * - 数据 = **omp 官方安装脚本**（`curl -fsSL https://omp.sh/install | sh`；Windows 走
 *   `install.ps1`）——壳侧不自己拼 brew / npm 命令，安装方式由官方脚本识别；
 * - 点击「安装 omp」直接开跑（这个弹窗就是确认层）：日志流式输出、可随时取消；
 * - 关闭弹窗**不会中断安装**（后端任务继续，chip 上转圈），重新打开还能看到日志与结果；
 * - 成功后自动重新识别 omp（路径 / 版本），chip 变回版本号；脚本成功但仍没识别到时
 *   就地给「重新检测 / 指定路径」两条路，不把「装完了」说成成功；
 * - 官方脚本的输出（含错误原文）原样透传，不翻译。
 */
export function OmpInstallDialog() {
 const run = useApp((s) => s.ompInstallRun);
 const health = useApp((s) => s.health);
 const set = useApp((s) => s.set);
 const t = useText();
 const [copied, setCopied] = useState(false);
 const [diagError, setDiagError] = useState<string | null>(null);
 const logRef = useRef<HTMLDivElement>(null);
 const close = () => set({ ompInstallDialogOpen: false });

 const running = run?.phase === "running";
 const done = run?.phase === "done";
 const failed = run?.phase === "failed";
 const canceled = run?.phase === "canceled";
 const found = Boolean(health?.omp.ompPath);
 /** 官方脚本按平台分叉（Windows 是 PowerShell）——展示与复制都用这一条。 */
 const command = isWindows() ? t.ompInstallCommandWin : t.ompInstallCommand;

 // 任务态优先；没发起过时讲「本机还没有 omp」
 const status = running
  ? { icon: <Loader size={16} aria-hidden className="shrink-0 animate-spin text-muted" />, text: t.ompInstallRunning, tone: "" }
  : done
   ? { icon: <CheckCircle size={16} aria-hidden className="shrink-0 text-ok" />, text: t.ompInstallDone, tone: "text-ok" }
   : failed
    ? { icon: <TriangleWarning size={16} aria-hidden className="shrink-0 text-warn" />, text: t.ompInstallFailed, tone: "text-warn" }
    : canceled
     ? { icon: <MinusCircle size={16} aria-hidden className="shrink-0 text-muted" />, text: t.ompInstallCanceled, tone: "" }
     : { icon: <Download size={16} aria-hidden className="shrink-0 text-accent" />, text: t.ompInstallIdle, tone: "" };

 // 日志自动滚底（与更新弹窗同口径：新行到达时看最后一行）
 const logLen = run?.lines.length ?? 0;
 useEffect(() => {
  const el = logRef.current;
  if (el) el.scrollTop = el.scrollHeight;
 }, [logLen]);

 // 慢网络下脚本的下载是静默的：「已用时」是唯一能证明它还在跑的读数
 const [now, setNow] = useState(() => Date.now());
 useEffect(() => {
  if (!running) return;
  const timer = window.setInterval(() => setNow(Date.now()), 1000);
  return () => window.clearInterval(timer);
 }, [running]);
 const elapsed = running && run?.startedAt
  ? fmt(t.ompUpdateElapsed, Math.floor((now - run.startedAt) / 60_000), Math.floor(((now - run.startedAt) % 60_000) / 1000))
  : null;

 const copy = async () => {
  try {
   await navigator.clipboard.writeText(command);
   setCopied(true);
   window.setTimeout(() => setCopied(false), 1500);
  } catch {
   // 剪贴板不可用（权限 / 非安全上下文）：命令本身就在旁边，可手动选中复制
   setDiagError(t.copyFailed);
  }
 };

 /** 诊断动作（重新检测 / 指定路径）的结果就地显示，不弹全局提示。 */
 const runDiag = async (fn: () => Promise<DiagResult | null>) => {
  const res = await fn();
  setDiagError(res && !res.ok ? (res.message ?? t.opFailed) : null);
 };

 return (
  <DialogShell title={t.ompInstallTitle} onClose={close} width="max-w-md">
   <div className="flex items-center gap-2 text-sm">
    {status.icon}
    <span className={`font-medium ${status.tone}`}>{status.text}</span>
    {elapsed && <span className="ml-auto shrink-0 font-mono text-[11px] text-faint">{elapsed}</span>}
   </div>

   {/* 安装方式（官方脚本）与影响面：安装前是说明，失败后仍能复制命令自己去终端跑 */}
   {!running && !done && (
    <div className="mt-3 rounded-md border border-border-soft bg-surface p-3">
     <div className="text-[13px] font-medium">{t.ompInstallCommandLabel}</div>
     <p className="mt-1 text-[12px] leading-relaxed text-muted">{t.ompInstallIntro}</p>
     <div className="mt-2 flex flex-wrap items-center gap-2">
      <code className="min-w-0 rounded-sm bg-code px-2 py-1 font-mono text-[12px] break-all">{command}</code>
      <button
       type="button"
       onClick={() => void copy()}
       className="flex min-h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-background px-2.5 py-1 text-[12px] transition-colors duration-100 hover:bg-hover"
      >
       {copied ? <Check size={12} aria-hidden className="text-ok" /> : <Copy size={12} aria-hidden />}
       {copied ? t.copied : t.ompUpdateCopyCommand}
      </button>
     </div>
     <p className="mt-2 text-[12px] leading-relaxed text-faint">{t.ompInstallFooter}</p>
     {isWindows() && <p className="mt-2 text-[12px] leading-relaxed text-warn">{t.ompInstallWslHint}</p>}
    </div>
   )}

   {done && (
    <div className="mt-3 rounded-md border border-ok/20 bg-ok/10 px-3 py-2 text-[12px] leading-relaxed text-ok">
     <p>{run?.to ? fmt(t.ompInstallDoneBody, run.to) : t.ompInstallDoneGeneric}</p>
     <p className="mt-1 opacity-80">{found ? t.ompInstallDoneHint : t.ompInstallDoneButMissing}</p>
    </div>
   )}

   {failed && (
    <div className="mt-3 rounded-md border border-warn/20 bg-warn/10 px-3 py-2 text-[12px] leading-relaxed text-warn">
     <p className="break-words whitespace-pre-line">{run.error}</p>
     <p className="mt-1 opacity-80">{t.ompInstallFailedHint}</p>
    </div>
   )}

   {canceled && (
    <p className="mt-3 rounded-md border border-border-soft bg-surface p-3 text-[12px] leading-relaxed text-muted">
     {t.ompInstallCanceledBody}
    </p>
   )}

   {run && run.lines.length > 0 && (
    <div
     ref={logRef}
     role="log"
     aria-label={t.ompInstallLogAria}
     className="mt-3 max-h-40 overflow-y-auto rounded-md bg-code p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all"
    >
     {run.lines.join("\n")}
    </div>
   )}

   {/* 识别状态 + 兜底两条路：脚本装到了 PATH 之外、或用户想用自己那份 omp */}
   {!running && (
    <div className="mt-3 rounded-md border border-border-soft bg-surface p-3">
     <div className="flex flex-wrap items-center gap-2">
      <span className="text-[13px] font-medium">{t.diagSection}</span>
      <span className={`rounded-sm px-2 py-0.5 font-mono text-[11px] ${found ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn"}`}>
       {found ? t.diagOk : t.diagBad}
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
     {found && health?.omp.ompPath && (
      <p className="mt-2 font-mono text-[12px] break-all text-muted">{health.omp.ompPath}</p>
     )}
     {diagError && (
      <p role="alert" className="mt-1 text-[12px] text-danger">
       {diagError}
      </p>
     )}
    </div>
   )}

   <div className="mt-4 flex items-center justify-end gap-2">
    {running ? (
     <button
      type="button"
      onClick={() => void cancelOmpInstall()}
      className="flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[13px] transition-colors duration-100 hover:bg-hover"
     >
      <MinusCircle size={12} aria-hidden />
      {t.ompInstallCancel}
     </button>
    ) : (
     <>
      {(!done || !found) && (
       <button
        type="button"
        onClick={startOmpInstall}
        className="flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition-opacity duration-100 hover:opacity-90"
       >
        <Download size={12} aria-hidden />
        {failed || canceled || done ? t.ompInstallRetry : t.ompInstallRun}
       </button>
      )}
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
 );
}
