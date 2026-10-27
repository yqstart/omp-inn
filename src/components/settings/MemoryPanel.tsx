import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { ChevronRight, FolderError, Notebook, Trash2 } from "reicon-react";
import { api } from "@shared/api";
import { useApp } from "../../stores/app";
import { fmt } from "../../lib/locale";
import { useText } from "../../lib/useText";
import { useVisibleRefresh } from "../../lib/useVisibleRefresh";
import { ConfirmDialog } from "../ConfirmDialog";
import { MarkdownLink } from "../MarkdownLink";
import type { MemoryFileContent, MemoryFileKind, MemoryFileView, MemoryProjectView } from "@shared/types";

/** 待确认的删除：文件级与项目级共用一个浮层实例（一次只确认一件事）。 */
type PendingDelete = {
 kind: "file" | "project";
 dir: string;
 file: string;
 title: string;
 detail: string;
 confirmLabel: string;
};

/** 预览状态：`key` = `${dir}\u0000${file}`，一次只展开一个文件。 */
type Preview =
 | { key: string; state: "loading" }
 | { key: string; state: "ok"; content: MemoryFileContent }
 | { key: string; state: "error"; message: string };

const previewKey = (dir: string, file: string) => `${dir}\u0000${file}`;

/** 文件大小：B / KB / MB（一位小数）。 */
function fmtBytes(n: number): string {
 if (n < 1024) return `${n} B`;
 if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
 return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 记忆目录内的文件分组：核心文件平铺，会话摘要与技能包各自收成一组。 */
type MemorySection = "core" | "rollouts" | "skills";

/**
 * `rollout_summaries/<uuid>-<slug>.md` → 可读的两段。
 * omp 每个被整理过的会话落一份，uuid 是完整会话 id，slug 是标题派生的短名；
 * 列表里铺全路径（uuid 36 位）既长又难分辨，标题位只留 slug、uuid 取末 8 位做区分。
 */
function rolloutTitle(path: string): { slug: string; id: string } {
 const name = path.startsWith("rollout_summaries/")
  ? path.slice("rollout_summaries/".length).replace(/\.md$/, "")
  : path;
 const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-*(.*)$/.exec(name);
 if (!m) return { slug: name, id: "" };
 return { slug: m[2] || name.slice(0, 8), id: m[1].slice(-8) };
}

/**
 * 设置 ›「记忆」：omp 项目记忆（`~/.omp/agent/memories/` 下按 cwd 一目录一份）的唯一管理面。
 *
 * 上游没有 `omp memory` 这类 CLI——记忆由 agent 工具与启动时的后台流水线写出，
 * 所以这一页**只做查看与删除**（写入是 omp 的事，壳侧不碰）：按项目分组列出记忆目录，
 * 点文件行内展开 Markdown 预览（设置页是可滚动容器，浮层会被裁掉），
 * 行级「删除」删单个文件、组头「清空记忆」删整个记忆目录，两者都走 `ConfirmDialog`
 * 二次确认（不可撤销）。相对路径由后端校验（拒绝越界），前端只负责回传。
 */
export function MemoryPanel() {
 const { locale } = useApp();
 const t = useText();
 const [rows, setRows] = useState<MemoryProjectView[] | null>(null);
 const [error, setError] = useState<string | null>(null);
 const [loadError, setLoadError] = useState<string | null>(null);
 const [busy, setBusy] = useState(false);
 /** 自增即重拉：挂载、点「刷新」、以及每次删除之后都走它。 */
 const [reloadKey, setReloadKey] = useState(0);
 /** 项目分组折叠态：key 缺席 = 展开，只有用户点过折叠的才收起。 */
 const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
 /** 目录内「会话摘要 / 技能包」分组的展开态：缺省收起——omp 每个会话一份摘要，铺开会盖住核心文件。 */
 const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
 const [preview, setPreview] = useState<Preview | null>(null);
 const [pending, setPending] = useState<PendingDelete | null>(null);

 useEffect(() => {
  let alive = true;
  void api
   .listMemories()
   .then((list) => {
    if (!alive) return;
    setRows(list);
    setLoadError(null);
   })
   .catch((e: unknown) => {
    if (!alive) return;
    const message = e instanceof Error ? e.message : t.memoryLoadFailed;
    setRows((prev) => {
     if (!prev) setLoadError(message);
     else setError(`${t.listRefreshFailed}：${message}`);
     return prev;
    });
   });
  return () => {
   alive = false;
  };
 }, [reloadKey, t]);

 // 页头刷新钮退场后（2026-10-19）：窗口重新获得焦点 / 转回可见时重拉一次——omp 的后台整理
 // 会在会话跑完后写出新记忆，那时页面可能一直开着。
 useVisibleRefresh(() => setReloadKey((k) => k + 1));

 /** 点文件行：展开预览（懒加载），已展开的再点一次收起。 */
 const togglePreview = async (dir: string, file: string) => {
  const key = previewKey(dir, file);
  if (preview?.key === key && preview.state === "ok") {
   setPreview(null);
   return;
  }
  setPreview({ key, state: "loading" });
  try {
   const content = await api.readMemoryFile(dir, file);
   setPreview((cur) => (cur?.key === key ? { key, state: "ok", content } : cur));
  } catch (e: unknown) {
   const message = e instanceof Error ? e.message : String(e);
   setPreview((cur) => (cur?.key === key ? { key, state: "error", message } : cur));
  }
 };

 /** 删除：只清掉真正被删掉的那个文件的预览，然后重拉列表。 */
 const act = async (job: PendingDelete) => {
  setBusy(true);
  setError(null);
  try {
   if (job.kind === "file") {
    await api.deleteMemoryFile(job.dir, job.file);
    setPreview((cur) => (cur?.key === previewKey(job.dir, job.file) ? null : cur));
   } else {
    await api.deleteMemoryProject(job.dir);
    setPreview((cur) => (cur && cur.key.startsWith(`${job.dir}\u0000`) ? null : cur));
   }
   setReloadKey((k) => k + 1);
  } catch (e: unknown) {
   setError(e instanceof Error ? e.message : t.memoryLoadFailed);
  } finally {
   setBusy(false);
  }
 };

 const kindLabel = (kind: MemoryFileKind): string =>
  ({
   memory: t.memoryKindMemory,
   summary: t.memoryKindSummary,
   raw: t.memoryKindRaw,
   learned: t.memoryKindLearned,
   rollout: t.memoryKindRollout,
   skill: t.memoryKindSkill,
   other: t.memoryKindOther,
  })[kind];

 const fmtDate = (ms: number): string =>
  ms > 0
   ? new Date(ms).toLocaleString(locale === "zh-CN" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
   })
   : "";

 const total = rows?.length ?? 0;

 /** 一个文件行 + 它的行内预览（预览是设置页里唯一的展开面，不开浮层）。 */
 const renderFile = (
  group: MemoryProjectView,
  f: MemoryFileView,
  display?: { title: string; subtitle?: string; hideKind?: boolean },
 ) => {
  const key = previewKey(group.dir, f.path);
  const open = preview?.key === key;
  return (
   <div key={f.path}>
    <div className="flex min-h-11 flex-wrap items-center gap-2 rounded-md py-2.5 transition-colors duration-100 hover:bg-hover">
     <button
      onClick={() => void togglePreview(group.dir, f.path)}
      aria-expanded={open}
      aria-label={`${open ? t.memoryHide : t.memoryView} ${f.path}`}
      className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 text-left"
     >
      <span
       title={f.path}
       className="min-w-0 basis-full truncate font-mono text-[12px] @min-[600px]/panel:flex-1 @min-[600px]/panel:basis-0"
      >
       {display?.title ?? f.path}
       {display?.subtitle && <span className="ml-1.5 text-faint">{display.subtitle}</span>}
      </span>
      {!display?.hideKind && (
       <span className="shrink-0 rounded-sm bg-background px-1.5 py-0.5 text-[11px] text-faint">
        {kindLabel(f.kind)}
       </span>
      )}
      <span className="shrink-0 font-mono text-[11px] text-faint">
       {f.size === 0 ? t.memoryEmptyFile : fmtBytes(f.size)}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-faint">{fmtDate(f.modified)}</span>
     </button>
     <button
      onClick={() =>
       setPending({
        kind: "file",
        dir: group.dir,
        file: f.path,
        title: fmt(t.memoryDeleteConfirm, f.path),
        detail: t.memoryDeleteDetail,
        confirmLabel: t.memoryDelete,
       })
      }
      disabled={busy}
      aria-label={`${t.memoryDelete} ${f.path}`}
      className="flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted transition-colors duration-100 hover:bg-hover hover:text-danger disabled:opacity-40"
     >
      <Trash2 size={12} aria-hidden />
      {t.memoryDelete}
     </button>
    </div>
    {open && (
     <div className="mt-1 mb-3 rounded-md bg-surface p-3">
      {preview && preview.state === "loading" && (
       <p className="text-[13px] text-muted">{t.memoryLoading}</p>
      )}
      {preview && preview.state === "error" && (
       <p role="alert" className="text-[13px] text-danger">
        {fmt(t.memoryPreviewFailed, preview.message)}
       </p>
      )}
      {preview && preview.state === "ok" && (
       <>
        {preview.content.truncated && (
         <p className="mb-2 text-[12px] text-warn">
          {fmt(t.memoryTruncated, fmtBytes(preview.content.bytes))}
         </p>
        )}
        {/* 正文按不可信输入处理：react-markdown 默认不渲染原始 HTML */}
        <div className="md-body min-w-0 max-h-96 overflow-auto">
         <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
          components={{ a: MarkdownLink }}
         >
          {preview.content.text}
         </ReactMarkdown>
        </div>
       </>
      )}
     </div>
    )}
   </div>
  );
 };

 /** 会话摘要 / 技能包分组行（缺省收起）；组内条目沿用文件行，摘要标题只留 slug + 短 id。 */
 const renderSection = (
  group: MemoryProjectView,
  section: "rollouts" | "skills",
  files: MemoryFileView[],
 ) => {
  if (files.length === 0) return null;
  const key = `${group.dir}\u0000${section}`;
  const open = openSections[key] === true;
  return (
   <div key={section}>
    <button
     onClick={() => setOpenSections((m) => ({ ...m, [key]: !open }))}
     aria-expanded={open}
     className="flex min-h-9 w-full cursor-pointer items-center gap-1.5 rounded-md px-1 text-left transition-colors duration-100 hover:bg-hover"
    >
     <ChevronRight
      size={12}
      aria-hidden
      className={`shrink-0 text-muted transition-transform duration-100 ${open ? "rotate-90" : ""}`}
     />
     <span className="shrink-0 text-xs font-medium text-muted">
      {section === "rollouts" ? t.memoryKindRollout : t.memoryKindSkill}
     </span>
     <span className="shrink-0 font-mono text-[11px] text-faint">
      {section === "rollouts" ? fmt(t.memorySectionRolloutCount, files.length) : fmt(t.memoryFileCount, files.length)}
      {" · "}
      {fmtBytes(files.reduce((n, f) => n + f.size, 0))}
     </span>
    </button>
    {open && (
     <div className="divide-y divide-border-soft pl-3">
      {files.map((f) => {
       if (section !== "rollouts") return renderFile(group, f);
       const { slug, id } = rolloutTitle(f.path);
       return renderFile(group, f, { title: slug, subtitle: id ? `#${id}` : undefined, hideKind: true });
      })}
     </div>
    )}
   </div>
  );
 };

 return (
  <section aria-label={t.tabMemories} className="settings-panel shrink-0">
   {/* 页头整行已按用户口径退场（2026-10-19）：说明 / 计数 / 刷新钮都不再上界面；
       外部改动（omp 后台整理写了新记忆）靠焦点回读与重挂补上 */}
   {error && (
    <p role="alert" className="mt-2 text-[13px] text-danger">
     {error}
    </p>
   )}

   {rows === null ? (
    loadError ? (
     <div className="mt-3 flex flex-col items-start gap-2">
      <p role="alert" className="text-[13px] text-danger">{loadError}</p>
      <button
       onClick={() => setReloadKey((k) => k + 1)}
       disabled={busy}
       className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[13px] transition-colors duration-100 hover:bg-hover disabled:opacity-50"
      >
       {t.retry}
      </button>
     </div>
    ) : (
     <p role="status" className="mt-3 text-[13px] text-muted">{t.memoryLoading}</p>
    )
   ) : total === 0 ? (
    <p className="mt-6 rounded-md bg-surface px-4 py-8 text-center text-[13px] leading-relaxed text-muted">
     {t.memoryEmpty}
    </p>
   ) : (
    <div className="mt-6 space-y-6">
     {rows.map((g) => {
      const folded = collapsed[g.dir] === true;
      const buckets: Record<MemorySection, MemoryFileView[]> = { core: [], rollouts: [], skills: [] };
      for (const f of g.files) {
       const section: MemorySection = f.path.startsWith("rollout_summaries/")
        ? "rollouts"
        : f.path.startsWith("skills/")
         ? "skills"
         : "core";
       buckets[section].push(f);
      }
      const statsText =
       [
        buckets.core.length > 0 ? fmt(t.memoryStatsCore, buckets.core.length) : "",
        buckets.rollouts.length > 0 ? fmt(t.memorySectionRolloutCount, buckets.rollouts.length) : "",
        buckets.skills.length > 0 ? fmt(t.memoryStatsSkill, buckets.skills.length) : "",
       ]
        .filter(Boolean)
        .join(" · ") || fmt(t.memoryFileCount, 0);
      return (
       <div key={g.dir}>
        <div className="flex flex-wrap items-center gap-2">
         <button
          onClick={() => setCollapsed((m) => ({ ...m, [g.dir]: !m[g.dir] }))}
          aria-expanded={!folded}
          aria-label={g.name}
          className="flex min-h-8 min-w-0 basis-full cursor-pointer items-center gap-1.5 rounded-md text-left transition-colors duration-100 hover:bg-hover @min-[600px]/panel:flex-1 @min-[600px]/panel:basis-0"
         >
          <ChevronRight
           size={12}
           aria-hidden
           className={`shrink-0 text-muted transition-transform duration-100 ${folded ? "" : "rotate-90"}`}
          />
          {g.path === null ? (
           <FolderError size={12} aria-hidden className="shrink-0 text-warn" />
          ) : (
           <Notebook size={12} aria-hidden className="shrink-0 text-faint" />
          )}
          <span className="min-w-0 shrink-0 max-w-[40%] truncate text-xs font-medium text-muted">{g.name}</span>
          <span className={`min-w-0 flex-1 truncate font-mono text-[11px] ${g.path === null ? "text-warn" : "text-faint"}`}>
           {g.path ?? t.memoryOrphanPath}
          </span>
         </button>
         <span className="shrink-0 font-mono text-[11px] text-faint">
          {statsText} · {fmtBytes(g.totalBytes)}
         </span>
         <button
          onClick={() =>
           setPending({
            kind: "project",
            dir: g.dir,
            file: "",
            title: fmt(t.memoryClearConfirm, g.name),
            detail: t.memoryClearDetail,
            confirmLabel: t.memoryClear,
           })
          }
          disabled={busy}
          className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-danger transition-colors duration-100 hover:bg-danger/10 disabled:opacity-40"
          aria-label={`${t.memoryClear} ${g.name}`}
         >
          <Trash2 size={11} aria-hidden />
          {t.memoryClear}
         </button>
        </div>
        {!folded &&
         (g.files.length === 0 ? (
          <p className="mt-1.5 text-[12px] text-faint">{t.memoryDirEmpty}</p>
         ) : (
          <div className="mt-1.5 divide-y divide-border-soft">
           {buckets.core.map((f) => renderFile(g, f))}
           {renderSection(g, "rollouts", buckets.rollouts)}
           {renderSection(g, "skills", buckets.skills)}
          </div>
         ))}
       </div>
      );
     })}
    </div>
   )}

   <ConfirmDialog
    open={pending !== null}
    title={pending?.title ?? ""}
    detail={pending?.detail}
    confirmLabel={pending?.confirmLabel ?? t.memoryDelete}
    danger
    onCancel={() => setPending(null)}
    onConfirm={() => {
     const job = pending;
     setPending(null);
     if (job) void act(job);
    }}
   />
  </section>
 );
}
