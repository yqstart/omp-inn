import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Link } from "reicon-react";
import { api } from "@shared/api";
import type { ProjectFiles } from "@shared/types";
import { useApp } from "../stores/app";
import { useText } from "../lib/useText";
import { fmt } from "../lib/locale";
import {
 buildRefItems,
 buildRefTree,
 flattenRefTree,
 highlightName,
 isFileRow,
 joinAbs,
 rankRefItems,
 refQueryTerms,
 referenceLabel,
 referenceScope,
 referenceTarget,
 type RefItem,
 type RefRow,
} from "../lib/workspaceFiles";
import { DialogShell } from "./settings/DialogShell";
import { FileIcon } from "./workbench/FileIcon";

/** 每个项目的结果上限（文件基数可能上万，只渲染前这么多条；后端另有 5万/项目的硬上限）。 */
const MAX_RESULTS = 200;
/** 目录树每层缩进（像素）。 */
const INDENT = 14;

/** 折叠 key（跨项目同名 `rel` 不能相撞）。 */
function collapseKey(projectPath: string, rel: string): string {
 return `${projectPath}\u0000${rel}`;
}

const EMPTY_COLLAPSED: ReadonlySet<string> = new Set<string>();

type LoadState =
 | { state: "loading" }
 | { state: "ready"; groups: ProjectFiles[] }
 | { state: "failed"; message: string };

type Section = { key: string; name: string; count: number; rows: RefRow[] };

/**
 * 引用工作区文件（V22）：⌘⇧P 打开；搜索**其他**成员项目的文件（当前项目不列——本项目文件在
 * 输入框里用 omp 原生 `@` 直接可补全）；Enter（或点文件行）把引用注入**引用目标**：
 * 该会话的 Composer 草稿（追加进草稿并把焦点交还输入框——omp 在 prompt 时会把 `@<路径>`
 * 展开成 fileMention 消息，含 cwd 之外的绝对路径，2026-10-09 真机实测），跨项目文件因此照样进上下文。
 * **文件夹同样可引用**（条目树里的目录行尾悬停出链接键，与右栏文件树同一口径）——注入 `@<目录>/`，
 * 语义 = omp 的目录提及（整个目录进上下文）。
 * 结果按项目分组、以资源管理器式目录树展示（chevron 折叠 / 目录与文件类型图标 / ↑↓ 走每一行）；
 * **刚打开（浏览态）不预选任何行**——↑↓ 或点击才出现高亮（2026-10-20 用户口径：打开就高亮一条
 * 文件容易让人以为已经选好了），搜索态仍默认停在第一条文件行（打字后 Enter 直接引用最佳匹配）；
 * 要引用文件夹就 ↑↓ 停到目录行。
 * **浏览态目录默认折叠**（只铺顶层，点着往下展开），**搜索态默认展开**（命中的深层文件必须可见）。
 *
 * 数据只在打开时拉一次（后端 60s 缓存）——输入不触发 IPC。
 */
export function ReferencePicker(): React.JSX.Element | null {
 const t = useText();
 const target = useApp((s) => s.refPickerTarget);
 const chatSessions = useApp((s) => s.sessions);
 const checkouts = useApp((s) => s.checkouts);
 const projects = useApp((s) => s.projects);
 const workspaceGroups = useApp((s) => s.workspaceGroups);
 const inputRef = useRef<HTMLInputElement>(null);
 /** 渲染行的元素表（行序号 → 元素）：键盘移动时把选中行滚进视野。 */
 const rowRefs = useRef<Record<number, HTMLElement | null>>({});
 const listId = useId();
 const [query, setQuery] = useState("");
 const terms = useMemo(() => refQueryTerms(query), [query]);
 const [cursor, setCursor] = useState<number | null>(null);
 const [reloadSeq, setReloadSeq] = useState(0);
 const [loaded, setLoaded] = useState<{ key: string; groups: ProjectFiles[]; error: string | null } | null>(null);
 /** 目录开合：`keys` = 用户点过的**例外**目录（浏览态记「展开的」、搜索态记「折叠的」；null = 全是默认态），随查询作废。 */
 const [collapseState, setCollapseState] = useState<{ query: string; keys: ReadonlySet<string> | null }>({
  query: "",
  keys: null,
 });

 /** 引用来源目录：该会话的 cwd（据此解析「当前项目」）。 */
 const cwd = target ? chatSessions.find((s) => s.id === target.sessionId)?.cwd ?? null : null;
 const scope = useMemo(
  () => (cwd
   ? referenceScope(cwd, workspaceGroups, checkouts, projects)
   : { primary: null, others: [] }),
  [cwd, workspaceGroups, checkouts, projects],
 );

 const paths = useMemo(() => scope.others.map((p) => p.path), [scope]);
 /** 请求标识：范围变化 / 手动重试 → 新 key；与 `loaded.key` 不一致 = 还在加载（渲染期派生，effect 不写同步 state）。 */
 const loadKey = `${paths.join("\n")}#${reloadSeq}`;

 // 打开（或重试）时拉一次文件列表；只有异步回调里才写 state。
 useEffect(() => {
  if (cwd === null || paths.length === 0) return;
  let active = true;
  api
   .listProjectFiles(paths)
   .then((groups) => {
    if (active) setLoaded({ key: loadKey, groups, error: null });
   })
   .catch((error) => {
    if (active) {
     setLoaded({ key: loadKey, groups: [], error: error instanceof Error ? error.message : String(error) });
    }
   });
  return () => {
   active = false;
  };
 }, [cwd, paths, loadKey]);

 const load = useMemo<LoadState>(
  () => (paths.length === 0
   ? { state: "ready", groups: [] }
   : loaded && loaded.key === loadKey
    ? loaded.error !== null
     ? { state: "failed", message: loaded.error }
     : { state: "ready", groups: loaded.groups }
    : { state: "loading" }),
  [paths, loaded, loadKey],
 );

 // 引用目标没了（会话被删 / 被移除）：浮层没有目标，直接收掉。
 useEffect(() => {
  if (cwd === null) useApp.getState().set({ refPickerTarget: null });
 }, [cwd]);

 /**
  * 目录开合口径：
  * - **浏览态（没打字）默认折叠**——打开只铺顶层，想看哪层点哪层，不被几百条淹掉；
  * - **搜索态默认展开**——命中的深层文件必须看得见（把命中藏进折叠里就等于没搜到）；
  * - 用户点过的目录记成「与默认相反的例外」（`flipped`），**查询一变即作废**——不需要 effect。
  */
 const browsing = terms.length === 0;
 const flipped = collapseState.query === query ? collapseState.keys : null;
 const dirCollapsed = useCallback(
  (key: string): boolean => {
   const hit = flipped?.has(key) ?? false;
   return browsing ? !hit : hit;
  },
  [browsing, flipped],
 );
 const toggleDir = (key: string) => {
  const next = new Set(flipped ?? EMPTY_COLLAPSED);
  // 点一下 = 取反；例外集合存的是「与默认相反」的那些（浏览态存展开的、搜索态存折叠的）
  const willCollapse = !dirCollapsed(key);
  const isException = browsing ? !willCollapse : willCollapse;
  if (isException) next.add(key);
  else next.delete(key);
  setCollapseState({ query, keys: next });
 };

 /**
  * 每个项目一段：过滤 → 目录树（按折叠状态剪枝）→ 前序遍历成渲染行；
  * 行序号在段间连续，与渲染顺序严格一致（不会跳）。
  */
 const sections = useMemo<Section[]>(() => {
  if (load.state !== "ready") return [];
  const searching = !browsing;
  const out: Section[] = [];
  for (const group of load.groups) {
   if (group.error !== null) continue;
   const matched = rankRefItems(query, buildRefItems([group], projects), MAX_RESULTS);
   const rows = flattenRefTree(
    buildRefTree(matched, searching),
    (rel) => dirCollapsed(collapseKey(group.path, rel)),
   );
   const project = projects.find((p) => p.path === group.path);
   out.push({
    key: group.path,
    name: project?.name ?? group.path.split("/").filter(Boolean).pop() ?? group.path,
    count: matched.length,
    rows,
   });
  }
  return out;
 }, [load, projects, query, browsing, dirCollapsed]);
 /** ↑↓ 的导航序列（目录行与文件行都在里面）：同时记住该行属于哪个项目（目录引用要用项目根算绝对路径）。 */
 const entries = useMemo(
  () => sections.flatMap((section) => section.rows.map((row) => ({ row, projectRoot: section.key }))),
  [sections],
 );
 const total = entries.length;
 /** 键盘锚点 = 第一条**文件**行：浏览态第一次 ↓ 落在这里、↑ 落在它上面一行（通常是目录）。 */
 const anchorIndex = useMemo(() => {
  const at = entries.findIndex((entry) => isFileRow(entry.row));
  return at >= 0 ? at : 0;
 }, [entries]);
 /**
  * 渲染用的选中行：
  * - 按过方向键（`cursor` 有效）→ 跟随它；
  * - **浏览态（刚打开 / 清空查询）不预选任何行**（`-1`）——打开就高亮一条文件会被误当成
  *   已经选好（2026-10-20 用户口径：要手动选）；
  * - 搜索态默认停在锚点（用户已明确在找东西，Enter 直接引用最佳匹配）。
  */
 const activeIndex =
  total === 0 ? -1 : cursor !== null && cursor < total ? cursor : browsing ? -1 : anchorIndex;
 const active = activeIndex >= 0 ? entries[activeIndex] ?? null : null;

 /**
  * 光标移动时把选中行带进视野：列表可能有上百行，没有跟随就不知道高亮落到哪了
  * （↑ 从第一条文件行往上找文件夹时尤其需要）。
  */
 useEffect(() => {
  if (activeIndex < 0) return;
  rowRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
 }, [activeIndex]);

 const close = () => useApp.getState().set({ refPickerTarget: null });
 /**
  * 投递一枚引用芯片（跨项目 → 绝对路径；目录的尾斜杠由芯片序列化时补），由 Composer
  * 插进草稿编辑器、焦点交还输入框。**文件行与目录行共用这一条投递口径**。
  */
 const deliver = (abs: string, isDir: boolean) => {
  const s = useApp.getState();
  const sid = target?.sessionId ?? null;
  if (!sid || !s.sessions.some((x) => x.id === sid)) {
   close();
   return;
  }
  s.insertDraftReference(sid, {
   path: referenceTarget(cwd ?? "", abs),
   label: referenceLabel(abs, isDir),
   isDir,
  });
  s.set({ refPickerTarget: null, composerFocusSeq: s.composerFocusSeq + 1 });
 };
 const choose = (item: RefItem) => deliver(item.abs, false);
 /** 引用整个文件夹：项目根 + 树里的相对目录路径 → 绝对路径。 */
 const chooseDir = (projectRoot: string, rel: string) => deliver(joinAbs(projectRoot, rel), true);

 if (!target || cwd === null) return null;

 const failed = load.state === "failed";
 const truncated = load.state === "ready" && load.groups.some((group) => group.truncated);
 const limited = sections.some((section) => section.count >= MAX_RESULTS);
 const projectErrors = load.state === "ready" ? load.groups.filter((group) => group.error !== null) : [];

 return (
  <DialogShell title={t.refPickTitle} width="max-w-2xl" onClose={close} initialFocusRef={inputRef}>
   <div className="flex flex-col gap-3">
    <input
     ref={inputRef}
     value={query}
     onChange={(e) => {
      setQuery(e.target.value);
      setCursor(null);
     }}
     onKeyDown={(e) => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
       if (total === 0) return;
       e.preventDefault();
       const delta = e.key === "ArrowDown" ? 1 : -1;
       // 还没选中（浏览态刚打开）：第一次 ↓ 落在第一条文件行、↑ 落在它上面一行（通常是目录）
       const next =
        activeIndex >= 0
         ? (activeIndex + delta + total) % total
         : delta > 0
          ? anchorIndex
          : (anchorIndex - 1 + total) % total;
       setCursor(next);
      } else if (e.key === "Enter") {
       if (active) {
        e.preventDefault();
        // 停在文件行 = 引用这个文件；停在目录行 = 引用整个文件夹
        if (isFileRow(active.row)) choose(active.row.item);
        else chooseDir(active.projectRoot, active.row.rel);
       }
      }
     }}
     role="combobox"
     aria-expanded
     aria-controls={listId}
     aria-activedescendant={
      activeIndex >= 0 && active !== null && isFileRow(active.row) ? `${listId}-${activeIndex}` : undefined
     }
     aria-autocomplete="list"
     placeholder={t.refPickSearchPlaceholder}
     aria-label={t.refPickSearchPlaceholder}
     className="h-9 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] outline-none focus:border-accent"
    />
    {scope.primary === null && (
     <p className="py-6 text-center text-[13px] text-muted">{t.refPickNoProject}</p>
    )}
    {scope.primary !== null && scope.others.length === 0 && (
     <p className="rounded-md border border-border-soft bg-surface px-3 py-2 text-[12px] text-faint">
      {t.refPickScopeHint}
     </p>
    )}
    {truncated && <p className="text-[12px] text-faint">{t.refPickTruncated}</p>}
    {limited && <p className="text-[12px] text-faint">{fmt(t.refPickLimitHint, String(MAX_RESULTS))}</p>}
    {projectErrors.map((group) => {
     const name = projects.find((p) => p.path === group.path)?.name
      ?? group.path.split("/").filter(Boolean).pop()
      ?? group.path;
     return (
      <p key={group.path} className="rounded-md border border-border-soft bg-surface px-3 py-2 text-[12px] text-faint">
       {fmt(t.refPickProjectError, name, group.error ?? "")}
      </p>
     );
    })}
    {load.state === "loading" && <p className="py-6 text-center text-[13px] text-muted">{t.refPickLoading}</p>}
    {failed && (
     <div className="flex flex-col items-center gap-2 py-6 text-center">
      <p role="alert" className="text-[13px] text-danger">{t.refPickLoadFailed}</p>
      <p className="font-mono text-[11px] break-words text-faint">{load.message}</p>
      <button
       type="button"
       onClick={() => setReloadSeq((n) => n + 1)}
       className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[13px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
      >
       {t.refPickRetry}
      </button>
     </div>
    )}
    {scope.others.length > 0 && total === 0 && load.state === "ready" && (
     <p className="py-6 text-center text-[13px] text-muted">{t.refPickEmpty}</p>
    )}
    {total > 0 && (
     <div role="listbox" id={listId} aria-label={t.refPickTitle} className="max-h-[28rem] overflow-y-auto">
      {sections.map((section) => (
       <div key={section.key}>
        <p className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-faint">
         {fmt(t.refPickGroupCount, section.name, String(section.count))}
        </p>
        {section.rows.map((row) => {
         if (row.kind === "dir") {
          const key = collapseKey(section.key, row.rel);
          const collapsed = dirCollapsed(key);
          return (
           <div
            key={`d:${row.rel}`}
            ref={(el) => {
             rowRefs.current[row.index] = el;
            }}
            className={`group flex h-6 items-center gap-1 rounded-md pr-1 transition-colors duration-100 ${activeIndex === row.index ? "bg-active" : "hover:bg-hover"}`}
            style={{ paddingLeft: 6 + row.depth * INDENT }}
           >
            <button
             type="button"
             onClick={() => toggleDir(key)}
             aria-expanded={!collapsed}
             title={joinAbs(section.key, row.rel)}
             className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-[12px] text-muted"
            >
             {collapsed
              ? <ChevronRight size={12} className="shrink-0 text-faint" aria-hidden />
              : <ChevronDown size={12} className="shrink-0 text-faint" aria-hidden />}
             <FileIcon name={row.name} isDir expanded={!collapsed} size={14} />
             <span className="min-w-0 flex-1 truncate">
              {highlightName(row.name, terms).map((part, partIndex) => (
               part.hit
                ? <span key={partIndex} className="font-medium text-accent">{part.text}</span>
                : <span key={partIndex}>{part.text}</span>
              ))}
             </span>
            </button>
            {/* 行尾动作：引用整个文件夹（hover 才露面，与右栏文件树同一口径）。
                用 `invisible` 而非 `hidden`：按钮**始终占位**，hover 只切可见性——
                否则 20px 的按钮会把 24px 行撑高，鼠标扫过时整列上下跳。 */}
            <button
             type="button"
             onClick={() => chooseDir(section.key, row.rel)}
             className="invisible flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-faint transition-colors duration-100 group-hover:visible hover:bg-active hover:text-foreground"
             aria-label={t.refPickDirRef}
             title={t.refPickDirRef}
            >
             <Link size={11} aria-hidden />
            </button>
           </div>
          );
         }
         return (
          <button
           key={`f:${row.item.abs}`}
           id={`${listId}-${row.index}`}
           ref={(el) => {
            rowRefs.current[row.index] = el;
           }}
           type="button"
           role="option"
           aria-selected={activeIndex === row.index}
           onClick={() => choose(row.item)}
           title={row.item.abs}
           style={{ paddingLeft: 6 + row.depth * INDENT }}
           className={`flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-md pr-2 text-left transition-colors duration-100 ${activeIndex === row.index ? "bg-active" : "hover:bg-hover"}`}
          >
           <span className="w-3 shrink-0" aria-hidden />
           <FileIcon name={row.name} isDir={false} size={14} />
           <span className="min-w-0 flex-1 truncate text-[12px]">
            {highlightName(row.name, terms).map((part, partIndex) => (
             part.hit
              ? <span key={partIndex} className="font-medium text-accent">{part.text}</span>
              : <span key={partIndex}>{part.text}</span>
            ))}
           </span>
          </button>
         );
        })}
       </div>
      ))}
     </div>
    )}
    <p className="text-[11px] text-faint">{t.refPickInsertHint}</p>
    <p className="text-[11px] text-faint">{t.refPickDirHint}</p>
   </div>
  </DialogShell>
 );
}
