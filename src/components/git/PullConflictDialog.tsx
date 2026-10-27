import { useEffect, useRef, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { AlertTriangle, FileText, X } from "reicon-react";
import { useApp } from "../../stores/app";
import { useDialogFocus } from "../../lib/useDropdown";
import { useText } from "../../lib/useText";
import { fmt } from "../../lib/locale";
import { abortMerge, closePullConflict, conflictLabel, continueMerge } from "../../lib/pull";

/**
 * 拉取冲突清单（V45）：`git pull` 的自动合并停在冲突处时弹出。
 *
 * - **不在壳里解决冲突**：壳只负责把用户送到编辑器（行内「打开」= 系统默认程序），
 *   冲突解决后点「继续合并」走 `continue_merge`（未标记解决的冲突文件先 add，再提交合并）；
 * - Esc / 点遮罩 = 只收起浮层——合并态仍在，左栏徽章继续提示冲突，可再点开；
 * - 放弃合并是**破坏性**的（丢弃已做的冲突解决）：文案说清，按钮用危险色。
 */
export function PullConflictDialog() {
 const cwd = useApp((s) => s.pullConflictCwd);
 if (!cwd) return null;
 // key：切到另一个工作区的冲突时重建（错误与忙碌态不复用）
 return <PullConflictCard key={cwd} cwd={cwd} />;
}

function PullConflictCard({ cwd }: { cwd: string }) {
 const t = useText();
 const state = useApp((s) => s.pullStates[cwd]);
 // 合并已在别处收尾（终端里 add + commit，等下一轮快照对账把冲突态清掉）：浮层自动退场
 useEffect(() => {
  if (!state) closePullConflict();
 }, [state]);
 const [busy, setBusy] = useState<null | "continue" | "abort">(null);
 const [opening, setOpening] = useState<string | null>(null);
 const [error, setError] = useState<string | null>(null);
 const cardRef = useRef<HTMLDivElement>(null);
 useDialogFocus(cardRef, true, closePullConflict);

 const conflicts = state?.conflicts ?? [];

 const openFile = async (path: string) => {
  setOpening(path);
  setError(null);
  try {
   await openPath(path);
  } catch {
   setError(fmt(t.gitPullOpenFailed, conflictLabel(cwd, path)));
  } finally {
   setOpening(null);
  }
 };

 const doContinue = async () => {
  setBusy("continue");
  setError(null);
  try {
   await continueMerge(cwd);
  } catch (err) {
   setError(err instanceof Error ? err.message : String(err));
  } finally {
   setBusy(null);
  }
 };

 const doAbort = async () => {
  setBusy("abort");
  setError(null);
  try {
   await abortMerge(cwd);
  } catch (err) {
   setError(err instanceof Error ? err.message : String(err));
  } finally {
   setBusy(null);
  }
 };

 const plainBtn =
  "cursor-pointer rounded-md border border-border px-3 py-1.5 text-[13px] transition-colors duration-100 hover:bg-hover disabled:cursor-default disabled:opacity-60";
 const primaryBtn =
  "cursor-pointer rounded-md border border-transparent bg-primary px-3.5 py-1.5 text-[13px] font-medium text-primary-foreground transition-colors duration-100 hover:opacity-90 disabled:cursor-default disabled:opacity-60";
 const dangerBtn =
  "cursor-pointer rounded-md border border-danger/25 bg-danger/10 px-3 py-1.5 text-[13px] text-danger transition-colors duration-100 hover:bg-danger/15 disabled:cursor-default disabled:opacity-60";

 return (
  <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" onClick={closePullConflict}>
   <div
    ref={cardRef}
    tabIndex={-1}
    role="dialog"
    aria-modal="true"
    aria-label={t.gitPullConflictTitle}
    className="w-full max-w-md rounded-xl border border-border bg-elevated p-6 shadow-dialog"
    onClick={(e) => e.stopPropagation()}
   >
    <div className="flex items-start justify-between gap-3">
     <div className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
      <AlertTriangle size={18} className="text-warn" aria-hidden />
      {t.gitPullConflictTitle}
     </div>
     <button
      type="button"
      onClick={closePullConflict}
      aria-label={t.close}
      className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted transition-colors duration-100 hover:bg-hover"
     >
      <X size={15} aria-hidden />
     </button>
    </div>
    <div className="mt-3 text-[13px] leading-6 text-muted">{t.gitPullConflictDetail}</div>
    <div className="mt-4 max-h-64 overflow-y-auto rounded-md border border-border-soft">
     {conflicts.map((path) => (
      <div key={path} className="flex items-center gap-3 border-b border-border-soft px-3 py-2 last:border-b-0">
       <FileText size={14} className="shrink-0 text-faint" aria-hidden />
       <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={path}>
        {conflictLabel(cwd, path)}
       </span>
       <button
        type="button"
        onClick={() => void openFile(path)}
        className="shrink-0 cursor-pointer rounded-sm px-2 py-0.5 text-[11px] text-accent transition-colors duration-100 hover:bg-hover"
       >
        {opening === path ? t.gitPullOpening : t.gitPullOpen}
       </button>
      </div>
     ))}
    </div>
    {error && <div className="mt-3 whitespace-pre-wrap break-words text-[12px] leading-5 text-danger">{error}</div>}
    <div className="mt-6 flex items-center justify-between gap-2 border-t border-border-soft pt-4">
     <button type="button" onClick={() => void doAbort()} disabled={busy !== null} className={dangerBtn}>
      {busy === "abort" ? t.gitPullAborting : t.gitPullAbort}
     </button>
     <div className="flex items-center gap-2">
      <button type="button" onClick={closePullConflict} className={plainBtn}>
       {t.gitPullLater}
      </button>
      <button type="button" onClick={() => void doContinue()} disabled={busy !== null} className={primaryBtn}>
       {busy === "continue" ? t.gitPullContinuing : t.gitPullContinue}
      </button>
     </div>
    </div>
   </div>
  </div>
 );
}
