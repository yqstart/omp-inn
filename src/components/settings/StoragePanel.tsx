import { useCallback, useEffect, useState } from "react";
import { Loader } from "reicon-react";
import { api } from "@shared/api";
import type { StorageCleanPlan, StoragePreview, StorageStats } from "@shared/types";
import { ConfirmDialog } from "../ConfirmDialog";
import { fmt, type Text } from "../../lib/locale";
import { fmtBytes } from "../../lib/formatBytes";
import { useText } from "../../lib/useText";

/**
 * 设置 ›「存储维护」（2026-10-22）。
 *
 * 长期使用后 omp 侧会累积三类可以安全回收的东西：
 * 1. `blobs` 里已无任何会话引用的图片（`omp gc --blobs` 扫引用，壳侧不猜）；
 * 2. `~/.omp/logs` 与应用的 `paste/` 临时文件（按天数阈值清，跳过最近文件）；
 * 3. 数据库 WAL（checkpoint 回收）。
 *
 * 深度优化把「归档冷会话 / 压缩空闲会话」交给 `omp gc`——它们会改变会话在磁盘上的
 * 组织方式，所以单列一组、默认不勾，确认框里再说明一次。
 *
 * 读数与执行分离：进页面只统计目录（快），点「预览」才跑 `omp gc` 的 dry-run
 * （要扫全部会话 jsonl，秒级）；执行前必须过确认框。
 */
export function StoragePanel() {
 const t = useText();
 const [stats, setStats] = useState<StorageStats | null>(null);
 const [preview, setPreview] = useState<StoragePreview | null>(null);
 const [plan, setPlan] = useState<StorageCleanPlan>({
  blobs: true,
  wal: true,
  logs: true,
  paste: true,
  backups: true,
  archive: false,
  compress: false,
  olderDays: 7,
 });
 const [previewing, setPreviewing] = useState(false);
 const [busy, setBusy] = useState(false);
 const [confirmOpen, setConfirmOpen] = useState(false);
 const [notice, setNotice] = useState<string | null>(null);
 const [error, setError] = useState<string | null>(null);

 const load = useCallback(async () => {
  try {
   setStats(await api.getStorageStats());
  } catch (e: unknown) {
   setError(e instanceof Error ? e.message : String(e));
  }
 }, []);

 const loadPreview = useCallback(async () => {
  setPreviewing(true);
  try {
   setPreview(await api.previewStorageCleanup(plan.olderDays ?? 7));
   setError(null);
  } catch (e: unknown) {
   setError(fmt(t.storagePreviewFailed, e instanceof Error ? e.message : String(e)));
  } finally {
   setPreviewing(false);
  }
 }, [plan.olderDays, t.storagePreviewFailed]);

 useEffect(() => {
  // 首读放进定时器回调：effect 体内同步 setState 会被 react-hooks/set-state-in-effect 拦下
  const id = window.setTimeout(() => {
   void load();
   void loadPreview();
  }, 0);
  return () => window.clearTimeout(id);
 }, [load, loadPreview]);

 // 结果提示 3s 自动消失
 useEffect(() => {
  if (!notice) return;
  const id = window.setTimeout(() => setNotice(null), 3000);
  return () => window.clearTimeout(id);
 }, [notice]);

 const toggle = (key: keyof StorageCleanPlan) => {
  setPlan((p) => ({ ...p, [key]: !p[key] }));
 };

 const reclaim = async () => {
  setBusy(true);
  setError(null);
  try {
   const n = await api.reclaimIdleSessions();
   setNotice(n > 0 ? fmt(t.storageReclaimed, n) : t.storageReclaimNone);
   await load();
  } catch (e: unknown) {
   setError(fmt(t.storageReclaimFailed, e instanceof Error ? e.message : String(e)));
  } finally {
   setBusy(false);
  }
 };

 const run = async () => {
  setConfirmOpen(false);
  setBusy(true);
  setNotice(null);
  setError(null);
  try {
   const r = await api.cleanStorage({ ...plan, dryRun: false });
   if (r.freedBytes === 0 && r.deletedFiles === 0 && r.archivedSessions === 0 && r.errors.length === 0) {
    setNotice(t.storageNoop);
   } else {
    setNotice(fmt(t.storageDone, fmtBytes(r.freedBytes), r.deletedFiles) + (r.archivedSessions > 0 ? fmt(t.storageDoneArchived, r.archivedSessions) : ""));
   }
   if (r.errors.length > 0) setError(r.errors.join("\n"));
   await load();
   await loadPreview();
  } catch (e: unknown) {
   setError(fmt(t.storageFailed, e instanceof Error ? e.message : String(e)));
  } finally {
   setBusy(false);
  }
 };

 const anyPicked = plan.blobs || plan.wal || plan.logs || plan.paste || plan.backups || plan.archive || plan.compress;
 const deep = plan.archive || plan.compress;
 const previewTotal = preview
  ? preview.blobBytes + preview.logsBytes + preview.pasteBytes + preview.backupBytes + preview.walBytes
  : null;

 const itemLabel: Record<string, keyof Text> = {
  ompImages: "storageItemOmpImages",
  ompSessions: "storageItemOmpSessions",
  ompLogs: "storageItemOmpLogs",
  ompDatabases: "storageItemOmpDatabases",
  shellPaste: "storageItemShellPaste",
  shellBackups: "storageItemShellBackups",
  shellLedger: "storageItemShellLedger",
 };

 const primary = "inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-[13px] text-accent transition-colors duration-100 hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50";
 const plain = "inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[13px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50";

 return (
  <div className="settings-panel flex flex-col gap-7">
   <p className="max-w-3xl text-[13px] leading-6 text-muted">{t.storageIntro}</p>

   <section className="flex flex-col gap-3">
    <h2 className="text-[11px] font-medium tracking-wide text-faint uppercase">{t.storageDiskTitle}</h2>
    {stats ? (
     <ul className="divide-y divide-border-soft rounded-lg border border-border-soft">
      {stats.items.map((it) => (
       <li key={it.key} className="flex items-center gap-4 px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
         <div className="text-[13px]">{t[itemLabel[it.key] ?? "storageDiskTitle"]}</div>
         <div className="truncate font-mono text-[10px] text-faint" title={it.path}>
          {it.path}
         </div>
        </div>
        <div className="shrink-0 text-right">
         <div className="font-mono text-[13px] tabular-nums">{fmtBytes(it.bytes)}</div>
         <div className="text-[10px] text-faint">{fmt(t.storageItemMeta, it.files)}</div>
        </div>
       </li>
      ))}
     </ul>
    ) : (
     <div className="text-[13px] text-faint">{t.storageEmpty}</div>
    )}
   </section>

   <section className="flex flex-col gap-3">
    <h2 className="text-[11px] font-medium tracking-wide text-faint uppercase">{t.storageRuntimeTitle}</h2>
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border-soft px-3.5 py-3">
     <p className="min-w-0 flex-1 text-[13px] leading-6 text-muted">{fmt(t.storageRuntimeDesc, stats?.runtimes ?? 0)}</p>
     <button type="button" onClick={reclaim} disabled={busy} className={plain}>
      {busy && <Loader size={13} aria-hidden className="animate-spin" />}
      {t.storageReclaim}
     </button>
    </div>
   </section>

   <section className="flex flex-col gap-3">
    <h2 className="text-[11px] font-medium tracking-wide text-faint uppercase">{t.storageCleanTitle}</h2>

    <div className="flex flex-col gap-2 rounded-lg border border-border-soft px-3.5 py-3">
     <div className="text-[13px] font-medium">{t.storageSafeTitle}</div>
     <p className="text-[12px] leading-5 text-muted">{t.storageSafeDesc}</p>
     <div className="mt-1 grid gap-1 sm:grid-cols-2">
      <CheckRow label={t.storageOptBlobs} checked={plan.blobs} onChange={() => toggle("blobs")} disabled={busy} />
      <CheckRow label={t.storageOptWal} checked={plan.wal} onChange={() => toggle("wal")} disabled={busy} />
      <CheckRow label={t.storageOptLogs} checked={plan.logs} onChange={() => toggle("logs")} disabled={busy} />
      <CheckRow label={t.storageOptPaste} checked={plan.paste} onChange={() => toggle("paste")} disabled={busy} />
      <CheckRow label={t.storageOptBackups} checked={plan.backups} onChange={() => toggle("backups")} disabled={busy} />
     </div>
    </div>

    <div className="flex flex-col gap-2 rounded-lg border border-warn/30 bg-warn/5 px-3.5 py-3">
     <div className="text-[13px] font-medium text-warn">{t.storageDeepTitle}</div>
     <p className="text-[12px] leading-5 text-muted">{t.storageDeepDesc}</p>
     <div className="mt-1 grid gap-1 sm:grid-cols-2">
      <CheckRow label={t.storageOptArchive} checked={plan.archive} onChange={() => toggle("archive")} disabled={busy} />
      <CheckRow label={t.storageOptCompress} checked={plan.compress} onChange={() => toggle("compress")} disabled={busy} />
     </div>
    </div>

    <div className="flex flex-wrap items-center gap-2">
     <span className="text-[12px] text-muted">{t.storageKeepDays}</span>
     {[7, 14, 30].map((days) => (
      <button
       key={days}
       type="button"
       onClick={() => setPlan((p) => ({ ...p, olderDays: days }))}
       aria-pressed={(plan.olderDays ?? 7) === days}
       className={`cursor-pointer rounded-md border px-2.5 py-1 text-[12px] transition-colors duration-100 ${
        (plan.olderDays ?? 7) === days ? "border-accent/40 bg-accent/10 text-accent" : "border-border text-muted hover:bg-hover"
       }`}
      >
       {fmt(t.storageDays, days)}
      </button>
     ))}
    </div>

    <div className="flex flex-col gap-2 rounded-lg border border-border-soft px-3.5 py-3">
     <div className="flex flex-wrap items-center gap-3">
      <button type="button" onClick={() => void loadPreview()} disabled={previewing || busy} className={plain}>
       {previewing && <Loader size={13} aria-hidden className="animate-spin" />}
       {previewing ? t.storagePreviewing : t.storagePreview}
      </button>
      <button type="button" onClick={() => setConfirmOpen(true)} disabled={busy || !anyPicked} className={primary}>
       {busy && <Loader size={13} aria-hidden className="animate-spin" />}
       {busy ? t.storageRunning : t.storageRun}
      </button>
      {previewTotal != null && (
       <span className="font-mono text-[13px] tabular-nums text-accent">{fmtBytes(previewTotal)}</span>
      )}
     </div>
     {preview && (
      <div className="flex flex-col gap-1 text-[11px] leading-5 text-muted">
       <span>
        {fmt(t.storagePreviewBlobs, fmtBytes(preview.blobBytes), preview.blobFiles)} · {fmt(t.storagePreviewWal, fmtBytes(preview.walBytes))}
       </span>
       <span>
        {fmt(t.storagePreviewLogs, fmtBytes(preview.logsBytes))} · {fmt(t.storagePreviewPaste, fmtBytes(preview.pasteBytes))} ·{" "}
        {fmt(t.storagePreviewBackup, fmtBytes(preview.backupBytes))}
       </span>
       {preview.archiveSessions > 0 && <span>{fmt(t.storagePreviewArchive, preview.archiveSessions)}</span>}
       {preview.errors.length > 0 && <span className="whitespace-pre-wrap text-warn">{preview.errors.join("\n")}</span>}
      </div>
     )}
    </div>
   </section>

   {notice && <div className="text-[12px] text-ok" aria-live="polite">{notice}</div>}
   {error && <div className="whitespace-pre-wrap text-[12px] text-warn" aria-live="polite">{error}</div>}

   <ConfirmDialog
    open={confirmOpen}
    title={t.storageConfirmTitle}
    detail={deep ? `${t.storageConfirmSafe}${t.storageConfirmDeep}` : t.storageConfirmSafe}
    confirmLabel={t.storageRun}
    danger={deep}
    onConfirm={() => void run()}
    onCancel={() => setConfirmOpen(false)}
   />
  </div>
 );
}

function CheckRow({
 label,
 checked,
 onChange,
 disabled,
}: {
 label: string;
 checked: boolean;
 onChange: () => void;
 disabled: boolean;
}) {
 return (
  <label className={`flex items-center gap-2 rounded-md px-1.5 py-1 text-[13px] transition-colors duration-100 ${disabled ? "opacity-50" : "cursor-pointer hover:bg-hover"}`}>
   <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} className="size-3.5 shrink-0 accent-accent" />
   <span className="min-w-0 flex-1">{label}</span>
  </label>
 );
}
