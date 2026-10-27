import { useEffect, useState } from "react";
import { CheckCircle, Download, Loader, Refresh, TriangleWarning, X } from "reicon-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useApp } from "../../stores/app";
import { checkForUpdate, deferUpdate, getAppVersion, installUpdate, relaunchToApply } from "../../lib/appUpdate";
import { fmt } from "../../lib/locale";
import { useText } from "../../lib/useText";
import { MarkdownLink } from "../MarkdownLink";

/**
 * 应用更新弹窗（App 常驻挂载、`updateDialogOpen` 控制显隐）：入口 = 左栏字标行的版本 chip
 * （V30；「应用更新」区块已从设置 ›「关于」迁到这里，检查更新按钮也在弹窗里）。
 * **所有状态都渲染**（idle / checking / latest 也开得出东西）——chip 点开永远有内容，
 * 图标与颜色只是补充，完整结论在文案里。
 */
function Progress({ downloaded, total }: { downloaded: number; total: number | null }) {
 const t = useText();
 if (total == null || total <= 0) return <div className="text-[13px] text-muted">{fmt(t.updateDownloadedKb, (downloaded / 1024).toFixed(0))}</div>;
 const pct = Math.min(100, Math.round((downloaded / total) * 100));
 return (
  <div>
   <div className="h-1.5 overflow-hidden rounded bg-border" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t.updateProgressAria}>
    <div className="h-full bg-accent transition-[width] duration-100" style={{ width: `${pct}%` }} />
   </div>
   <div className="mt-1 text-[11px] text-faint">{pct}%</div>
  </div>
 );
}

export function UpdateDialog() {
 const { update, set } = useApp();
 const t = useText();
 const [version, setVersion] = useState<string | null>(null);

 useEffect(() => {
  void getAppVersion().then(setVersion);
 }, []);

 const close = () => set({ updateDialogOpen: false });
 const checking = update.status === "checking";
 const available = update.status === "available";
 const latest = update.status === "latest";
 /** 关闭弹窗 = X 键同一口径：有可用更新时「稍后提醒」（入口常亮），其余直接关。 */
 const dismiss = () => (available ? deferUpdate() : close());
 // 检查结果里有当前版本就用它（权威），否则用 app 版本（idle / checking 还没有结果）
 const current = available || latest ? update.current : version ?? t.unknown;
 // idle / checking / latest 是「没事可做」的三种状态：同一个版式，区别只在状态行
 const idleLayout = update.status === "idle" || checking || latest;
 const status =
  checking
   ? { icon: <Loader size={16} aria-hidden className="shrink-0 animate-spin text-muted" />, title: t.updateChecking }
   : latest
    ? { icon: <CheckCircle size={16} aria-hidden className="shrink-0 text-ok" />, title: fmt(t.updateLatest, update.current) }
    : available
     ? { icon: <Download size={16} aria-hidden className="shrink-0 text-accent" />, title: fmt(t.updateAvailable, update.version) }
     : update.status === "downloading"
      ? { icon: <Loader size={16} aria-hidden className="shrink-0 animate-spin text-muted" />, title: t.updateDownloading }
      : update.status === "ready"
       ? { icon: <CheckCircle size={16} aria-hidden className="shrink-0 text-ok" />, title: t.updateReadyTitle }
       : update.status === "error"
        ? { icon: <TriangleWarning size={16} aria-hidden className="shrink-0 text-warn" />, title: t.updateFailedTitle }
        : { icon: <Download size={16} aria-hidden className="shrink-0 text-muted" />, title: t.updateSection };

 return (
  <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={t.updateDialogAria} onClick={dismiss}>
   <div className="w-[420px] max-w-full rounded-xl border border-border bg-elevated p-6 shadow-dialog" onClick={(e) => e.stopPropagation()}>
    <div className="flex items-center gap-2">
     {status.icon}
     <h2 className="text-[15px] font-semibold">{status.title}</h2>
     <button onClick={available ? deferUpdate : close} className="ml-auto cursor-pointer rounded p-1.5 transition-colors duration-100 hover:bg-hover" aria-label={available ? t.updateDeferAria : t.close}>
      <X size={14} aria-hidden />
     </button>
    </div>

    {idleLayout && (
     <>
      {update.status === "idle" && (
       <p className="mt-2 text-sm text-muted">
        {t.current} <span className="font-mono">v{current}</span>
       </p>
      )}
      <p className="mt-3 text-[13px] leading-relaxed text-faint">{t.updateFoot}</p>
      {!checking && (
       <div className="mt-3 flex justify-end gap-2">
        <button onClick={close} className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[13px] transition-colors duration-100 hover:bg-hover">
         {t.close}
        </button>
        <button
         onClick={() => void checkForUpdate("manual")}
         className="flex cursor-pointer items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-[13px] text-primary-foreground transition-opacity duration-100 hover:opacity-90"
        >
         <Refresh size={14} aria-hidden /> {t.checkUpdate}
        </button>
       </div>
      )}
     </>
    )}

    {available && (
     <>
      <p className="mt-2 text-sm text-muted">{fmt(t.updateCurrentTo, update.current, update.version)}</p>
      {update.body && (
       <>
        <p className="mt-3 text-[11px] text-faint">{t.updateNotes}</p>
        {/* 更新说明 = Release 里 CHANGELOG 本版本整节（Markdown）。按不可信输入处理：
            react-markdown 默认不渲染原始 HTML；链接一律交给系统浏览器，不给 webview 自行导航的机会。 */}
        <div className="md-body mt-1 max-h-64 overflow-auto rounded-md bg-code p-3 text-[13px]">
         <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>
          {update.body}
         </ReactMarkdown>
        </div>
       </>
      )}
      <div className="mt-3 flex justify-end gap-2">
       <button onClick={deferUpdate} className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[13px] transition-colors duration-100 hover:bg-hover">
        {t.updateLater}
       </button>
       <button
        onClick={() => void installUpdate()}
        className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-[13px] text-primary-foreground transition-opacity duration-100 hover:opacity-90"
       >
        {t.updateNow}
       </button>
      </div>
     </>
    )}

    {update.status === "downloading" && (
     <div className="mt-3">
      <Progress downloaded={update.downloaded} total={update.total} />
      <p className="mt-2 text-[13px] text-muted">{t.updateWait}</p>
     </div>
    )}

    {update.status === "ready" && (
     <>
      <p className="mt-2 text-sm">{t.updateRestartAsk}</p>
      <div className="mt-3 flex justify-end gap-2">
       <button onClick={close} className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[13px] transition-colors duration-100 hover:bg-hover">
        {t.updateRestartLater}
       </button>
       <button
        onClick={() => void relaunchToApply()}
        className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-[13px] text-primary-foreground transition-opacity duration-100 hover:opacity-90"
       >
        {t.updateRestartNow}
       </button>
      </div>
     </>
    )}

    {update.status === "error" && (
     <>
      <p className="mt-2 text-sm text-danger">{update.message}</p>
      <div className="mt-3 flex justify-end gap-2">
       <button onClick={close} className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[13px] transition-colors duration-100 hover:bg-hover">
        {t.close}
       </button>
       <button
        onClick={() => void checkForUpdate("manual")}
        className="flex cursor-pointer items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-[13px] text-primary-foreground transition-opacity duration-100 hover:opacity-90"
       >
        <Loader size={14} aria-hidden /> {t.retry}
       </button>
      </div>
     </>
    )}
   </div>
  </div>
 );
}
