import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Loader, Refresh, Search, X } from "reicon-react";
import { api } from "@shared/api";
import type {
 ChangeFile,
 ChangeSet,
 GitCommitDetail,
 GitGraphBranch,
 GitGraphCommit,
 GitGraphPage,
 GitGraphRef,
} from "@shared/types";
import { useApp } from "../../stores/app";
import { fmt } from "../../lib/locale";
import { graphColumnWidth, laneX, layoutGraph, type GraphRow } from "../../lib/gitGraph";
import { formatSessionFullTime, formatSessionTime } from "../../lib/sessionTime";
import { useText } from "../../lib/useText";
import { joinAbs } from "../../lib/workspaceFiles";
import { EnumSelect } from "../settings/EnumSelect";
import { GitGraphDiffDialog, type GitGraphDiffTarget } from "./GitGraphDiffDialog";

/** 一页提交数：再多只是白占内存；「加载更多」继续取。 */
const PAGE = 200;
/** 已加载提交上限：图谱每行一个 SVG，长历史不做虚拟化时必须有天花板。 */
const MAX_LOADED = 2000;
/** 行高：带引用（分支 / 标签 chip）的行多一条；正文与元信息用固定行高。 */
const ROW_PLAIN = 40;
const ROW_REFS = 60;
/** 图谱列左右留白与 lane 配色（中调色，亮 / 暗主题都可读）。 */
const GRAPH_PAD = 10;
const LANE_COLORS = [
 "#4f9cf9",
 "#e8a33d",
 "#56c271",
 "#d16bd8",
 "#e05f5f",
 "#42b8b0",
 "#8b7ef8",
 "#d4b840",
 "#6c8fe0",
 "#c97b4a",
];
const EMPTY_COMMITS: GitGraphCommit[] = [];
const EMPTY_BRANCHES: GitGraphBranch[] = [];

type Selection =
 | { cwd: string; kind: "commit"; hash: string }
 | { cwd: string; kind: "working" };

type LoadState = {
 /** `${cwd}\0${rev}\0${refreshSeq}`：换了目录 / 分支 / 刷新序号就重新取。 */
 key: string;
 page: GitGraphPage | null;
 changes: ChangeSet | null;
 error: string | null;
};

type DetailState = {
 key: string;
 data: GitCommitDetail | null;
 error: string | null;
};

/**
 * 右栏「Git 图谱」页签（形态参照 VS Code Git Graph）。
 *
 * - **提交图**：后端 `git_graph` 按 `--topo-order` 取跨分支提交（含 HEAD / 分支 / 远程 / 标签），
 *   前端 `lib/gitGraph.ts` 算 lane 布局并用 SVG 画节点 / 连线；
 * - **未提交改动行**：`get_change_set` 的读数，点开列文件，文件点开走工作区 diff；
 * - **提交详情**：点提交行取 `git_commit_detail`（合并提交按第一个父提交），文件点开取
 *   `git_commit_diff`；diff 只读，不做 checkout / reset / cherry-pick；
 * - **筛选**：分支下拉走后端（`rev` 完整引用），文本搜索只筛**已加载**的提交（图按筛选后的
 *   可见集合重算，不挂悬空线）；分页用 `skip` + 「加载更多」。
 *
 * 面板常驻挂载：`visible` 只在页签真的显示时拉数据，切走再回来重读一次（提交可能在别处变化）。
 */
export function GitGraphPanel({ cwd, visible }: { cwd: string; visible: boolean }) {
 const t = useText();
 const locale = useApp((s) => s.locale);
 const [refreshSeq, setRefreshSeq] = useState(0);
 const [loadState, setLoadState] = useState<LoadState | null>(null);
 const [revChoice, setRevChoice] = useState<{ cwd: string; ref: string } | null>(null);
 /** 文本筛选也绑定目录：切会话后旧过滤词不能把新仓库的提交全筛掉。 */
 const [queryChoice, setQueryChoice] = useState<{ cwd: string; text: string } | null>(null);
 const [selection, setSelection] = useState<Selection | null>(null);
 const [detail, setDetail] = useState<DetailState | null>(null);
 const [diffTarget, setDiffTarget] = useState<GitGraphDiffTarget | null>(null);
 const [loadingMore, setLoadingMore] = useState(false);
 /** 加载更多的错误只对当时那次请求有效（换目录 / 分支 / 刷新后自动作废）。 */
 const [notice, setNotice] = useState<{ key: string; text: string } | null>(null);
 const [copied, setCopied] = useState<string | null>(null);
 const copyTimer = useRef<number | null>(null);

 /** 分支选择绑定目录：切会话后旧引用作废（新仓库不一定有同名分支）。 */
 const rev = revChoice?.cwd === cwd ? revChoice.ref : "";
 const query = queryChoice?.cwd === cwd ? queryChoice.text : "";
 const loadKey = `${cwd}\0${rev}\0${refreshSeq}`;
 // 旧目录 / 旧分支 / 刷新前的数据不算数；「加载中」由它派生，不在 effect 里同步清状态
 const load = loadState?.key === loadKey ? loadState : null;
 const page = load?.page ?? null;
 const changes = load?.changes ?? null;
 const error = load?.error ?? null;
 const loading = visible && !load;

 const activeSelection = selection?.cwd === cwd ? selection : null;
 const selectedHash = activeSelection?.kind === "commit" ? activeSelection.hash : null;
 // 未提交改动可能在刷新后消失：行的可见性与选中态都以当前读数为准（不留下空详情）
 const hasWorkingChanges = !!changes?.isRepo && changes.files.length > 0;
 const workingSelected = activeSelection?.kind === "working" && hasWorkingChanges;

 // 取一页：图谱与未提交改动一起拉（后者失败不拖垮图谱）
 useEffect(() => {
  if (!visible) return;
  let alive = true;
  const key = loadKey;
  void Promise.allSettled([api.gitGraph(cwd, rev || null, PAGE, 0), api.getChangeSet(cwd)]).then(
   ([graph, change]) => {
    if (!alive) return;
    const set = change.status === "fulfilled" ? change.value : null;
    if (graph.status === "fulfilled") {
     setLoadState({ key, page: graph.value, changes: set, error: null });
    } else {
     setLoadState({ key, page: null, changes: set, error: String(graph.reason) });
    }
   },
  );
  return () => {
   alive = false;
  };
 // loadKey 已包含 cwd / rev / refreshSeq；visible 决定要不要取
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [visible, loadKey]);

 // 提交详情：只对当前目录的选中提交取；切目录后旧选中自然失效
 useEffect(() => {
  if (!visible || !selectedHash) return;
  let alive = true;
  const key = `${cwd}\0${selectedHash}`;
  void api.gitCommitDetail(cwd, selectedHash).then(
   (data) => {
    if (alive) setDetail({ key, data, error: null });
   },
   (err: unknown) => {
    if (alive) setDetail({ key, data: null, error: String(err) });
   },
  );
  return () => {
   alive = false;
  };
 }, [visible, cwd, selectedHash]);

 useEffect(
  () => () => {
   if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  },
  [],
 );

 const branches = page?.branches ?? EMPTY_BRANCHES;
 const branchChoices = useMemo(
  () => [
   { value: "", label: t.graphBranchAll },
   ...branches.map((b) => ({
    value: b.ref,
    label: b.kind === "branch" && b.name === page?.branch ? fmt(t.graphBranchCurrent, b.name) : b.name,
   })),
  ],
  [branches, page?.branch, t],
 );
 const revLabel = rev
  ? (branches.find((b) => b.ref === rev)?.name ?? rev.split("/").pop() ?? rev)
  : t.graphBranchAll;

 // 搜索只筛已加载的提交；图谱按可见集合重算（不可见父提交不占 lane）
 const filtered = useMemo(() => {
  const commits = page?.commits ?? EMPTY_COMMITS;
  const q = query.trim().toLowerCase();
  if (!q) return commits;
  return commits.filter(
   (c) =>
    c.hash.toLowerCase().includes(q) ||
    c.subject.toLowerCase().includes(q) ||
    c.author.toLowerCase().includes(q) ||
    c.refs.some((r) => r.name.toLowerCase().includes(q)),
  );
 }, [page, query]);
 const layout = useMemo(() => layoutGraph(filtered), [filtered]);
 const columnWidth = graphColumnWidth(layout.lanes);
 const selectedCommit = selectedHash ? (page?.commits.find((c) => c.hash === selectedHash) ?? null) : null;

 const pickRev = (next: string) => {
  setRevChoice({ cwd, ref: next });
  setSelection(null);
  setQueryChoice({ cwd, text: "" });
 };

 const pick = (next: Selection) => {
  setSelection(next);
  if (next.kind === "working") setDetail(null);
 };

 const canLoadMore = !!page?.hasMore && page.commits.length < MAX_LOADED;

 const loadMore = () => {
  if (!page || !canLoadMore || loadingMore) return;
  const key = loadKey;
  setLoadingMore(true);
  void api.gitGraph(cwd, rev || null, PAGE, page.commits.length).then(
   (next) => {
    setLoadState((prev) => {
     if (!prev || prev.key !== key || !prev.page) return prev;
     const seen = new Set(prev.page.commits.map((c) => c.hash));
     const commits = [...prev.page.commits, ...next.commits.filter((c) => !seen.has(c.hash))];
     return { ...prev, page: { ...prev.page, commits, hasMore: next.hasMore } };
    });
   },
   (err: unknown) => setNotice({ key, text: `${t.graphLoadMoreFailed}: ${String(err)}` }),
  ).finally(() => setLoadingMore(false));
 };

 const copyHash = (hash: string) => {
  void navigator.clipboard
   ?.writeText(hash)
   .then(() => {
    setCopied(hash);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(null), 1500);
   })
   .catch(() => {
    // 剪贴板不可用时保持原样（不假装复制成功）
   });
 };

 const detailFor = selectedHash && detail?.key === `${cwd}\0${selectedHash}` ? detail : null;
 const root = page?.root ?? null;
 const activeNotice = notice?.key === loadKey ? notice.text : null;
 // 展开 / 收起页签时隐藏弹窗；回到同一页签仍保留（diff 是用户主动打开的）
 const activeDiff = visible && diffTarget?.cwd === cwd ? diffTarget : null;

 return (
  <div className="flex h-full min-h-0 flex-col">
   {/* 工具行：分支筛选 / 文本筛选 / 刷新 */}
   <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border-soft px-2">
    <EnumSelect
     label={t.graphBranchFilter}
     value={rev}
     display={revLabel}
     choices={branchChoices}
     triggerTitle={rev || t.graphBranchAll}
     triggerClassName="flex h-6 min-w-0 max-w-[46%] shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border px-1.5 text-[11px] text-muted transition-colors duration-100 hover:bg-hover"
     itemClassName="block w-full cursor-pointer rounded px-2 py-1 text-left text-[12px] break-words transition-colors duration-100 hover:bg-hover"
     onPick={pickRev}
    />
    <div className="relative min-w-0 flex-1">
     <Search
      size={11}
      aria-hidden
      className="pointer-events-none absolute top-1/2 left-1.5 -translate-y-1/2 text-faint"
     />
     <input
      value={query}
      onChange={(e) => setQueryChoice({ cwd, text: e.target.value })}
      placeholder={t.graphFilterPlaceholder}
      aria-label={t.graphFilterPlaceholder}
      spellCheck={false}
      className="h-6 w-full rounded-md border border-border bg-surface pr-1.5 pl-6 text-[11px] text-foreground outline-none placeholder:text-faint focus:border-accent"
     />
    </div>
    <button
     onClick={() => setRefreshSeq((n) => n + 1)}
     className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-faint transition-colors duration-100 hover:bg-hover hover:text-foreground"
     aria-label={t.filesRefresh}
     title={t.filesRefresh}
    >
     <Refresh size={11} aria-hidden />
    </button>
   </div>

   {/* 提交列表 */}
   <div className="min-h-0 flex-1 overflow-y-auto">
    {loading ? (
     <p className="px-3.5 py-4 text-[12px] text-faint">{t.graphLoading}</p>
    ) : error ? (
     <div className="px-3.5 py-4">
      <p className="text-[12px] text-danger">{t.graphLoadFailed}</p>
      <p className="mt-1 font-mono text-[10px] break-words text-faint">{error}</p>
     </div>
    ) : !page ? null : !page.isRepo ? (
     <p className="px-3.5 py-4 text-[12px] text-faint">{t.graphNotRepo}</p>
    ) : (
     <>
      {hasWorkingChanges && changes && (
       <button
        onClick={() => pick({ cwd, kind: "working" })}
        aria-pressed={workingSelected}
        className={`flex w-full min-w-0 items-center gap-2 py-1.5 pr-2 text-left transition-colors duration-100 ${
         workingSelected ? "bg-active" : "hover:bg-hover"
        }`}
       >
        <span className="flex shrink-0 justify-center" style={{ width: columnWidth }}>
         <span className="size-2.5 rounded-full border border-dashed border-warn" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{t.graphUncommitted}</span>
        <span className="shrink-0 rounded-full bg-surface px-1.5 text-[10px] text-muted">
         {changes.files.length}
        </span>
       </button>
      )}

      {page.commits.length === 0 ? (
       <p className="px-3.5 py-4 text-[12px] text-faint">{t.graphEmpty}</p>
      ) : layout.rows.length === 0 ? (
       <p className="px-3.5 py-4 text-[12px] text-faint">{t.graphNoMatch}</p>
      ) : (
       layout.rows.map((row) => (
        <GraphRowButton
         key={row.commit.hash}
         row={row}
         lanes={layout.lanes}
         columnWidth={columnWidth}
         locale={locale}
         selected={selectedHash === row.commit.hash}
         onPick={() => pick({ cwd, kind: "commit", hash: row.commit.hash })}
        />
       ))
      )}

      {canLoadMore && (
       <button
        onClick={loadMore}
        disabled={loadingMore}
        className="flex w-full cursor-pointer items-center justify-center gap-1.5 py-2 text-[11px] text-accent transition-colors duration-100 hover:bg-hover disabled:opacity-50"
       >
        {loadingMore && <Loader size={10} className="animate-spin" aria-hidden />}
        {loadingMore ? t.graphLoadingMore : t.graphLoadMore}
       </button>
      )}
      {page.hasMore && !canLoadMore && (
       <p className="px-3.5 py-2 text-[10px] leading-relaxed text-faint">{fmt(t.graphLimitReached, MAX_LOADED)}</p>
      )}
      {activeNotice && <p className="px-3.5 pb-2 text-[10px] break-words text-danger">{activeNotice}</p>}
     </>
    )}
   </div>

   {/* 详情：选中提交或未提交改动时贴在列表下方（右栏窄，不另开弹窗） */}
   {(workingSelected || selectedHash) && (
    <div className="flex max-h-[48%] min-h-0 shrink-0 flex-col border-t border-border bg-surface">
     <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border-soft px-2">
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
       {workingSelected
        ? t.graphUncommitted
        : (detailFor?.data?.subject ?? selectedCommit?.subject ?? t.graphLoading)}
      </span>
      {selectedHash && (
       <button
        onClick={() => copyHash(selectedHash)}
        className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-faint transition-colors duration-100 hover:bg-hover hover:text-foreground"
        aria-label={t.graphCopyHash}
        title={copied === selectedHash ? t.graphCopied : t.graphCopyHash}
       >
        {copied === selectedHash ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
       </button>
      )}
      <button
       onClick={() => setSelection(null)}
       className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-faint transition-colors duration-100 hover:bg-hover hover:text-foreground"
       aria-label={t.graphCloseDetail}
       title={t.graphCloseDetail}
      >
       <X size={11} aria-hidden />
      </button>
     </div>

     <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
      {workingSelected ? (
       <WorkingDetail
        changes={changes}
        root={root}
        onDiff={(file) => {
         if (!root) return;
         setDiffTarget({ kind: "working", cwd, path: file.path, absPath: joinAbs(root, file.path) });
        }}
       />
      ) : selectedHash ? (
       <CommitDetail
        data={detailFor?.data ?? null}
        error={detailFor?.error ?? null}
        hash={selectedHash}
        onDiff={(path) => setDiffTarget({ kind: "commit", cwd, hash: selectedHash, path })}
       />
      ) : null}
     </div>
    </div>
   )}

   {activeDiff && <GitGraphDiffDialog target={activeDiff} onClose={() => setDiffTarget(null)} />}
  </div>
 );
}

/** 一行提交：图谱列 + 引用 chip + 标题 + hash / 作者 / 时间。 */
function GraphRowButton({
 row,
 lanes,
 columnWidth,
 locale,
 selected,
 onPick,
}: {
 row: GraphRow;
 lanes: number;
 columnWidth: number;
 locale: string;
 selected: boolean;
 onPick: () => void;
}) {
 const t = useText();
 const height = row.commit.refs.length > 0 ? ROW_REFS : ROW_PLAIN;
 const at = row.commit.at * 1000;
 return (
  <button
   onClick={onPick}
   aria-pressed={selected}
   data-commit={row.commit.hash}
   className={`flex w-full min-w-0 items-stretch text-left transition-colors duration-100 ${
    selected ? "bg-active" : "hover:bg-hover"
   }`}
   style={{ height }}
  >
   <GraphSvg row={row} lanes={lanes} width={columnWidth} height={height} />
   <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 py-1 pr-2">
    {row.commit.refs.length > 0 && <RefChips refs={row.commit.refs} />}
    <div className="min-w-0 truncate text-[12px] leading-4 text-foreground" title={row.commit.subject}>
     {row.commit.subject || t.graphNoSubject}
    </div>
    <div className="flex min-w-0 items-center gap-1.5 text-[10px] leading-3 text-faint">
     <span className="shrink-0 font-mono">{row.commit.hash.slice(0, 7)}</span>
     <span className="min-w-0 truncate" title={row.commit.email}>
      {row.commit.author}
     </span>
     <span className="ml-auto shrink-0" title={formatSessionFullTime(at, locale)}>
      {formatSessionTime(at, t)}
     </span>
    </div>
   </div>
  </button>
 );
}

/** 提交引用 chip：HEAD / 本地分支 / 远程 / 标签，最多两枚 + 其余计数。 */
function RefChips({ refs }: { refs: GitGraphRef[] }) {
 const shown = refs.slice(0, 2);
 const rest = refs.length - shown.length;
 const all = refs.map((r) => r.name).join(", ");
 return (
  <div className="flex min-w-0 items-center gap-1 overflow-hidden" title={all}>
   {shown.map((ref) => (
    <span
     key={`${ref.kind}:${ref.name}`}
     className={`max-w-[96px] shrink-0 truncate rounded border px-1 py-px text-[9.5px] leading-4 ${
      REF_CHIP_CLASS[ref.kind]
     }`}
     title={all}
    >
     {ref.name}
    </span>
   ))}
   {rest > 0 && (
    <span className="shrink-0 rounded border border-border px-1 py-px text-[9.5px] leading-4 text-faint">
     +{rest}
    </span>
   )}
  </div>
 );
}

const REF_CHIP_CLASS: Record<GitGraphRef["kind"], string> = {
 head: "border-accent/40 bg-accent/10 text-accent",
 branch: "border-border bg-surface text-foreground",
 remote: "border-border bg-transparent text-muted",
 tag: "border-warn/40 bg-warn/10 text-warn",
};

/** 本行的连线 + 节点。坐标系只关心 lane / 行高，颜色按 lane 循环。 */
function GraphSvg({ row, lanes, width, height }: { row: GraphRow; lanes: number; width: number; height: number }) {
 const colorOf = (lane: number) => LANE_COLORS[Math.abs(lane) % LANE_COLORS.length];
 const x = (lane: number) => laneX(lane, lanes, width, GRAPH_PAD);
 const mid = height / 2;
 const merge = row.commit.parents.length > 1;
 return (
  <svg width={width} height={height} className="shrink-0" aria-hidden>
   {row.edges.map((edge, i) => {
    const from = edge.from ?? row.lane;
    const to = edge.to ?? row.lane;
    const x1 = x(from);
    const x2 = x(to);
    const y1 = edge.from === null ? mid : 0;
    const y2 = edge.to === null ? mid : height;
    const d =
     Math.abs(x1 - x2) < 0.01
      ? `M ${x1} ${y1} L ${x2} ${y2}`
      : `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
    return (
     <path key={i} d={d} fill="none" stroke={colorOf(to)} strokeWidth={1.5} strokeLinecap="round" />
    );
   })}
   {merge ? (
    <circle cx={x(row.lane)} cy={mid} r={3.2} fill="none" stroke={colorOf(row.lane)} strokeWidth={1.8} />
   ) : (
    <circle cx={x(row.lane)} cy={mid} r={3.4} fill={colorOf(row.lane)} />
   )}
  </svg>
 );
}

/** 提交详情：元信息 + 正文 + 文件清单。 */
function CommitDetail({
 data,
 error,
 hash,
 onDiff,
}: {
 data: GitCommitDetail | null;
 error: string | null;
 hash: string;
 onDiff: (path: string) => void;
}) {
 const t = useText();
 const locale = useApp((s) => s.locale);
 if (error) {
  return (
   <div className="space-y-1 px-1 py-1 text-[12px]">
    <div className="text-danger">{t.graphDetailFailed}</div>
    <div className="font-mono text-[10px] break-words text-faint">{error}</div>
  </div>
  );
 }
 if (!data) return <p className="px-1 py-1 text-[12px] text-faint">{t.graphDetailLoading}</p>;

 const merge = data.parents.length > 1;
 return (
  <div className="space-y-2">
   <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-muted">
    <span className="shrink-0 rounded bg-code px-1.5 py-px font-mono text-[10px]">{hash.slice(0, 7)}</span>
    {merge && <span className="rounded border border-border px-1.5 py-px text-[10px] text-accent">{t.graphMerge}</span>}
    <span className="min-w-0 truncate">
     {data.author} &lt;{data.authorEmail}&gt;
    </span>
    <span className="shrink-0 text-faint" title={formatSessionFullTime(data.at * 1000, locale)}>
     {formatSessionTime(data.at * 1000, t)}
    </span>
   </div>
   {merge && <p className="text-[10px] text-faint">{t.graphMergeHint}</p>}
   {data.body && (
    <div className="max-h-32 overflow-y-auto rounded-md bg-code px-2 py-1.5 text-[11px] leading-relaxed whitespace-pre-wrap text-muted">
     {data.body}
    </div>
   )}
   {data.bodyTruncated && <p className="text-[10px] text-warn">{t.graphBodyTruncated}</p>}
   <div className="flex items-center gap-1.5 text-[10px] text-faint">
    <span>{fmt(t.graphFilesCount, data.files.length)}</span>
    {data.filesTruncated && <span className="text-warn">{t.graphFilesTruncated}</span>}
   </div>
   {data.files.length === 0 ? (
    <p className="text-[11px] text-faint">{t.graphNoFiles}</p>
   ) : (
    <div className="space-y-0.5">
     {data.files.map((file) => (
      <FileRow
       key={`${file.origPath ?? ""}:${file.path}`}
       status={file.status}
       path={file.path}
       title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
       add={file.add}
       del={file.del}
       binary={file.binary}
       onClick={() => onDiff(file.path)}
      />
     ))}
    </div>
   )}
  </div>
 );
}

/** 未提交改动详情：文件清单直接走工作区 diff（`get_change_set` 的读数）。 */
function WorkingDetail({
 changes,
 root,
 onDiff,
}: {
 changes: ChangeSet | null;
 root: string | null;
 onDiff: (file: ChangeFile) => void;
}) {
 const t = useText();
 if (!changes) return <p className="px-1 py-1 text-[12px] text-faint">{t.graphWorkingFailed}</p>;
 if (changes.files.length === 0) return <p className="px-1 py-1 text-[12px] text-faint">{t.gitPanelNoFiles}</p>;
 return (
  <div className="space-y-2">
   {changes.branch && (
    <div className="truncate text-[10px] text-muted" title={changes.branch}>
     {changes.branch}
    </div>
   )}
   <div className="text-[10px] text-faint">{fmt(t.graphFilesCount, changes.files.length)}</div>
   <div className="space-y-0.5">
    {changes.files.map((file) => {
     const code = file.untracked ? "??" : (file.index !== " " ? file.index : file.worktree).trim() || "M";
     return (
      <FileRow
       key={file.path}
       status={code}
       path={file.path}
       title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
       add={file.add}
       del={file.del}
       binary={false}
       disabled={!root}
       onClick={() => onDiff(file)}
      />
     );
    })}
   </div>
  </div>
 );
}

/** 详情里的一个文件行：状态 / 路径 / 增删行数。 */
function FileRow({
 status,
 path,
 title,
 add,
 del,
 binary,
 disabled = false,
 onClick,
}: {
 status: string;
 path: string;
 title: string;
 add: number;
 del: number;
 binary: boolean;
 disabled?: boolean;
 onClick: () => void;
}) {
 const tone =
  status === "A" ? "text-ok" : status === "D" ? "text-danger" : status === "R" || status === "C" ? "text-accent" : "text-warn";
 return (
  <button
   onClick={onClick}
   disabled={disabled}
   title={title}
   data-diff-path={path}
   className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-left transition-colors duration-100 hover:bg-hover disabled:cursor-default disabled:opacity-60"
  >
   <span className={`w-3 shrink-0 font-mono text-[10px] ${tone}`}>{status}</span>
   <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">{path}</span>
   {binary ? (
    <span className="shrink-0 text-[9px] text-faint">bin</span>
   ) : (
    <span className="shrink-0 font-mono text-[10px]">
     <span className="text-ok">+{add}</span> <span className="text-danger">-{del}</span>
    </span>
   )}
  </button>
 );
}
