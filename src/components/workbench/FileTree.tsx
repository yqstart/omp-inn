import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, FolderOpen, Link, Refresh, Search, X } from "reicon-react";
import { api } from "@shared/api";
import type { ChangeFile, DirEntry, PathHit } from "@shared/types";
import { useApp } from "../../stores/app";
import { revealPath, useOpenPath } from "../../lib/openPath";
import { useText } from "../../lib/useText";
import { joinAbs, referenceLabel, referenceTarget } from "../../lib/workspaceFiles";
import { FileIcon } from "./FileIcon";

/** 每个目录一次渲染的条数：`node_modules` 那种大目录不做分片会把整棵树卡住。 */
const PAGE = 200;
/** 快速过滤的防抖：打字期间不发请求，停手才问一次后端。 */
const FILTER_DEBOUNCE = 180;
/** 过滤结果条数上限（后端硬上限 800，界面只铺前 200）。 */
const FILTER_LIMIT = 200;
/** 定位到某一行之后高亮的时长（够看清落在哪，不长期占着底色）。 */
const HIGHLIGHT_MS = 1600;

/** 变更状态 → 徽标文案与色调（`index` / `worktree` 的 XY 两位；`??` 未跟踪）。 */
function changeBadge(file: ChangeFile): { text: string; tone: string } {
 if (file.untracked) return { text: "?", tone: "text-faint" };
 const code = (file.index !== " " ? file.index : file.worktree).trim() || "M";
 switch (code) {
  case "A":
   return { text: code, tone: "text-ok" };
  case "D":
   return { text: code, tone: "text-danger" };
  case "R":
  case "C":
   return { text: code, tone: "text-accent" };
  default:
   return { text: code, tone: "text-warn" };
 }
}

/** 相对路径的父级部分（过滤结果行的次要文字；根下的条目没有父级）。 */
function parentOf(rel: string): string {
 const at = rel.lastIndexOf("/");
 return at < 0 ? "" : rel.slice(0, at);
}

/**
 * 右栏「文件」页签：当前会话工作目录的**只读**目录树。
 *
 * - 懒加载：只有展开的目录才向 `list_dir` 取内容（大仓库不做全量递归）；
 * - **类型图标**：Material Icon Theme 口径（`lib/fileIcons.ts`），按文件名 / 扩展名 / 目录名取图标；
 * - **快速过滤**（顶部输入框）：`search_paths` 递归搜文件与文件夹（带扫描预算），
 *   输入即出结果；点结果 → 清空过滤并在树里逐级展开定位（高亮一下）；
 * - 变更标色：`get_change_set` 一次拿到未提交改动，按「仓库根 + 相对路径」换算成绝对路径给文件加徽标；
 * - 点击文件 → 系统默认程序打开（失败退到「在访达中显示」）；行尾两键 = 引用到输入框 / 在访达中显示。
 *
 * 引用注入走 `referenceTarget`：会话目录内给**相对路径**（`@src/a.ts`），目录外才用绝对路径——
 * 一长串绝对路径不进输入框。
 *
 * 状态全在组件内（面板常驻挂载，右栏收起再展开不会丢展开位置 / 过滤词）；高频数据（目录内容）不进 store。
 */
export function FileTree({ root }: { root: string }) {
 const t = useText();
 const activeSessionId = useApp((s) => s.activeSessionId);
 const { notice, open } = useOpenPath(root);
 const [dirs, setDirs] = useState<Record<string, DirEntry[]>>({});
 const [expanded, setExpanded] = useState<Set<string>>(new Set());
 const [loading, setLoading] = useState<Set<string>>(new Set());
 const [errors, setErrors] = useState<Record<string, string>>({});
 const [truncated, setTruncated] = useState<Set<string>>(new Set());
 /** 目录 → 已显示条数（分片展开）。 */
 const [shown, setShown] = useState<Record<string, number>>({});
 /** 绝对路径 → 变更（标色查表）。 */
 const [changes, setChanges] = useState<Map<string, ChangeFile>>(new Map());
 const [refreshSeq, setRefreshSeq] = useState(0);
 /** 过滤词（非空 = 结果态；清空即回到树）。 */
 const [query, setQuery] = useState("");
 /** 过滤结果（key 对不上 = 还在搜，渲染「搜索中…」）。 */
 const [found, setFound] = useState<{ key: string; hits: PathHit[]; truncated: boolean } | null>(null);
 const [searchError, setSearchError] = useState<string | null>(null);
 /** 过滤结果的键盘光标（`key` 防重放：换词即回到第一条）。 */
 const [nav, setNav] = useState<{ key: string; idx: number }>({ key: "", idx: 0 });
 /** 定位后的高亮行（绝对路径）。 */
 const [highlight, setHighlight] = useState<string | null>(null);
 /** 目录内容的镜像：定位时按「最新已加载」判断要不要补一次 `list_dir`（state 在异步循环里读不到新值）。 */
 const dirsRef = useRef<Record<string, DirEntry[]>>({});
 /** 行元素表（定位后滚动到该行用）。 */
 const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
 /** 过滤结果的行元素表（键盘上下移动时把选中行带进视野）。 */
 const hitRefs = useRef<Record<string, HTMLDivElement | null>>({});
 /** 待滚动到的行（等这一轮渲染把行铺出来）。 */
 const scrollTo = useRef<string | null>(null);
 /** 引用注入的串行队列（标签要问后端，连点也不能乱序）。 */
 const refQueue = useRef<Promise<void>>(Promise.resolve());

 /** 取一层目录（`isRoot` 为真时顺带拿仓库根，由调用方使用）。 */
 const loadDir = useCallback(async (path: string, isRoot: boolean) => {
  setLoading((s) => new Set(s).add(path));
  try {
   const listing = await api.listDir(path, isRoot);
   dirsRef.current = { ...dirsRef.current, [path]: listing.entries };
   setDirs((d) => ({ ...d, [path]: listing.entries }));
   setTruncated((s) => {
    const n = new Set(s);
    if (listing.truncated) n.add(path);
    else n.delete(path);
    return n;
   });
   setErrors((e) => {
    if (!(path in e)) return e;
    const { [path]: _drop, ...rest } = e;
    return rest;
   });
   return listing;
  } catch (err) {
   setErrors((e) => ({ ...e, [path]: String(err) }));
   return null;
  } finally {
   setLoading((s) => {
    const n = new Set(s);
    n.delete(path);
    return n;
   });
  }
 }, []);

 /** 未提交改动（标色数据源）：`base` = 仓库根（拿不到就按会话 cwd 降级）。 */
 const loadChanges = useCallback(
  async (base: string | null) => {
   try {
    const set = await api.getChangeSet(root);
    if (!set.isRepo) {
     setChanges(new Map());
     return;
    }
    const anchor = base ?? root;
    const map = new Map<string, ChangeFile>();
    for (const f of set.files) map.set(joinAbs(anchor, f.path), f);
    setChanges(map);
   } catch {
    setChanges(new Map());
   }
  },
  [root],
 );

 // 树根（会话 cwd）变化 / 手动刷新：整棵树重来
 useEffect(() => {
  dirsRef.current = {};
  setDirs({});
  setExpanded(new Set());
  setErrors({});
  setTruncated(new Set());
  setShown({});
  setChanges(new Map());
  setHighlight(null);
  let alive = true;
  void (async () => {
   const listing = await loadDir(root, true);
   if (!alive || !listing) return;
   void loadChanges(listing.repoRoot);
  })();
  return () => {
   alive = false;
  };
 }, [root, refreshSeq, loadDir, loadChanges]);

 const trimmed = query.trim();
 const searchKey = `${root}\u0000${trimmed}`;
 const searching = trimmed.length > 0;
 const hits = searching && found?.key === searchKey ? found.hits : null;
 const activeIdx = hits && hits.length > 0 ? Math.min(nav.key === searchKey ? nav.idx : 0, hits.length - 1) : -1;

 // 快速过滤：防抖后问一次后端（`search_paths` 自带扫描预算，前端的 limit 只影响铺多少条）
 useEffect(() => {
  if (!searching) return;
  let alive = true;
  const timer = setTimeout(() => {
   api
    .searchPaths(root, trimmed, FILTER_LIMIT)
    .then((res) => {
     if (!alive) return;
     setFound({ key: searchKey, hits: res.hits, truncated: res.truncated });
     setSearchError(null);
    })
    .catch((err) => {
     if (alive) setSearchError(String(err));
    });
  }, FILTER_DEBOUNCE);
  return () => {
   alive = false;
   clearTimeout(timer);
  };
 }, [searchKey, trimmed, root, searching]);

 // 定位后滚动到目标行（行要在这一轮渲染里铺出来；滚一次就清标记）。
 // `highlight` 也在依赖里：目标已在展开的目录里时 `dirs` / `expanded` 不变，只靠它触发这一趟滚动。
 useEffect(() => {
  const path = scrollTo.current;
  if (!path) return;
  const el = rowRefs.current[path];
  if (!el) return;
  scrollTo.current = null;
  el.scrollIntoView({ block: "center" });
 }, [dirs, expanded, highlight]);

 // 键盘上下移动时把选中行带进视野（结果可能上百条，位置感不能只靠底色）
 useEffect(() => {
  if (activeIdx < 0 || !hits) return;
  const hit = hits[activeIdx];
  if (hit) hitRefs.current[hit.path]?.scrollIntoView({ block: "nearest" });
 }, [activeIdx, hits]);

 // 高亮一闪即散（不长期占底色）
 useEffect(() => {
  if (!highlight) return;
  const timer = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
  return () => clearTimeout(timer);
 }, [highlight]);

 const toggle = (entry: DirEntry) => {
  if (!entry.isDir) {
   void open(entry.path);
   return;
  }
  if (expanded.has(entry.path)) {
   setExpanded((prev) => {
    const n = new Set(prev);
    n.delete(entry.path);
    return n;
   });
   return;
  }
  setExpanded((prev) => new Set(prev).add(entry.path));
  if (!dirs[entry.path] && !loading.has(entry.path)) void loadDir(entry.path, false);
 };

 /**
  * 引用到输入框：投递一枚**引用芯片**（短标签 + 真路径），由 Composer 插进草稿编辑器。
  * 标签要问一次后端（最短唯一后缀），所以串一条队列——连点几个引用也按点击顺序落进草稿。
  */
 const insertRef = (path: string, isDir: boolean) => {
  const sid = activeSessionId;
  if (!sid) return;
  refQueue.current = refQueue.current.then(async () => {
   const label = await api.mentionLabel(root, path).catch(() => null);
   const target = referenceTarget(root, path);
   const s = useApp.getState();
   if (s.activeSessionId !== sid) return; // 会话已经切走：别把引用写进另一个会话
   s.insertDraftReference(sid, {
    path: target,
    label: label ?? referenceLabel(target, false),
    isDir,
   });
   s.set({ composerFocusSeq: s.composerFocusSeq + 1 });
  });
 };

 /** 过滤结果 → 树：退出过滤态，逐级展开到目标（文件则展开它的父目录）并高亮。 */
 const locate = async (hit: PathHit) => {
  setQuery("");
  setSearchError(null);
  const segments = hit.isDir ? hit.rel.split("/") : hit.rel.split("/").slice(0, -1);
  let path = root;
  for (const segment of segments) {
   path = `${path}/${segment}`;
   if (!dirsRef.current[path]) await loadDir(path, false);
   // 展开用的是**这一级**的路径：`path` 是循环变量，updater 惰性执行时会读到最后一轮的值
   const level = path;
   setExpanded((prev) => (prev.has(level) ? prev : new Set(prev).add(level)));
  }
  // 目标所在目录若还没铺到那一行（分片 200 条），把分片一次性加大到覆盖它——否则「定位」定了个看不见的行
  const parentDir = hit.path.slice(0, hit.path.lastIndexOf("/")) || root;
  const siblings = dirsRef.current[parentDir] ?? dirsRef.current[hit.path];
  const at = siblings?.findIndex((x) => x.path === hit.path) ?? -1;
  if (at >= 0) {
   setShown((prev) => {
    const current = prev[parentDir] ?? PAGE;
    return at < current ? prev : { ...prev, [parentDir]: at + 1 };
   });
  }
  scrollTo.current = hit.path;
  setHighlight(hit.path);
 };

 const renderLevel = (dir: string, depth: number): ReactNode => {
  const err = errors[dir];
  if (err) {
   return (
    <p className="px-3 py-1 text-[11px] text-danger" title={err}>
     {t.filesLoadFailed}
    </p>
   );
  }
  const entries = dirs[dir];
  if (!entries) {
   return loading.has(dir) ? <p className="px-3 py-1 text-[11px] text-faint">{t.filesLoading}</p> : null;
  }
  const limit = shown[dir] ?? PAGE;
  const visible = entries.slice(0, limit);
  return (
   <>
    {visible.map((e) => {
     const change = e.isDir ? undefined : changes.get(e.path);
     const badge = change ? changeBadge(change) : null;
     const isOpen = e.isDir && expanded.has(e.path);
     return (
      <div key={e.path}>
       <div
        ref={(el) => {
         rowRefs.current[e.path] = el;
        }}
        className={`group flex h-6 items-center gap-1 rounded-md pr-1 transition-colors duration-100 ${
         highlight === e.path ? "bg-active" : "hover:bg-hover"
        }`}
        style={{ paddingLeft: 6 + depth * 12 }}
       >
        <button
         onClick={() => toggle(e)}
         className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
         title={e.path}
         aria-expanded={e.isDir ? isOpen : undefined}
        >
         {e.isDir ? (
          <ChevronRight
           size={11}
           aria-hidden
           className={`shrink-0 text-faint transition-transform duration-100 ${isOpen ? "rotate-90" : ""}`}
          />
         ) : (
          <span className="w-[11px] shrink-0" aria-hidden />
         )}
         <FileIcon name={e.name} isDir={e.isDir} expanded={isOpen} size={14} />
         <span className="min-w-0 flex-1 truncate text-[12px]">{e.name}</span>
         {e.isSymlink && (
          <span className="shrink-0 text-[10px] text-faint" aria-hidden>
           ↗
          </span>
         )}
         {badge && (
          <span className={`shrink-0 font-mono text-[10px] ${badge.tone}`} title={t.filesChangedBadge}>
           {badge.text}
          </span>
         )}
        </button>
        {/* 行尾动作：hover 才露面（引用到输入框 / 在访达中显示） */}
        <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
         {activeSessionId && (
          <button
           onClick={() => insertRef(e.path, e.isDir)}
           className="flex size-5 cursor-pointer items-center justify-center rounded text-faint transition-colors duration-100 hover:bg-active hover:text-foreground"
           aria-label={t.filesInsertRef}
           title={t.filesInsertRef}
          >
           <Link size={11} aria-hidden />
          </button>
         )}
         <button
          onClick={() => void revealPath(e.path)}
          className="flex size-5 cursor-pointer items-center justify-center rounded text-faint transition-colors duration-100 hover:bg-active hover:text-foreground"
          aria-label={t.filesReveal}
          title={t.filesReveal}
         >
          <FolderOpen size={11} aria-hidden />
         </button>
        </span>
       </div>
       {isOpen && <div>{renderLevel(e.path, depth + 1)}</div>}
      </div>
     );
    })}
    {entries.length > limit && (
     <button
      onClick={() => setShown((s) => ({ ...s, [dir]: limit + PAGE }))}
      className="mt-0.5 cursor-pointer rounded-md px-2 py-0.5 text-[11px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
      style={{ marginLeft: 6 + depth * 12 }}
     >
      {t.filesShowMore}
     </button>
    )}
    {truncated.has(dir) && <p className="px-3 py-0.5 text-[10px] text-faint">{t.filesTruncated}</p>}
   </>
  );
 };

 /** 过滤结果行：图标 + 名字 + 父路径（次要），行尾两键与树里同款。 */
 const renderHit = (hit: PathHit, index: number) => {
  const parent = parentOf(hit.rel);
  const selected = index === activeIdx;
  return (
   <div
    key={hit.path}
    ref={(el) => {
     hitRefs.current[hit.path] = el;
    }}
    className={`group flex h-7 items-center gap-1.5 rounded-md pr-1 transition-colors duration-100 ${
     selected ? "bg-active" : "hover:bg-hover"
    }`}
    style={{ paddingLeft: 6 }}
   >
    <button
     onClick={() => void locate(hit)}
     className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-2 text-left"
     title={hit.rel}
    >
     <span className="flex min-w-0 items-center gap-1.5">
      <FileIcon name={hit.name} isDir={hit.isDir} size={14} />
      <span className="truncate text-[12px]">{hit.name}</span>
     </span>
     {parent && <span className="min-w-0 flex-1 truncate text-[10px] text-faint">{parent}</span>}
    </button>
    <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
     {activeSessionId && (
      <button
       onClick={() => insertRef(hit.path, hit.isDir)}
       className="flex size-5 cursor-pointer items-center justify-center rounded text-faint transition-colors duration-100 hover:bg-active hover:text-foreground"
       aria-label={t.filesInsertRef}
       title={t.filesInsertRef}
      >
       <Link size={11} aria-hidden />
      </button>
     )}
     <button
      onClick={() => void revealPath(hit.path)}
      className="flex size-5 cursor-pointer items-center justify-center rounded text-faint transition-colors duration-100 hover:bg-active hover:text-foreground"
      aria-label={t.filesReveal}
      title={t.filesReveal}
     >
      <FolderOpen size={11} aria-hidden />
     </button>
    </span>
   </div>
  );
 };

 const rootName = root.replace(/\/+$/, "").split("/").pop() || root;
 return (
  <div className="flex h-full min-h-0 flex-col">
   <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border-soft px-2">
    <div className="relative flex min-w-0 flex-1 items-center">
     <Search size={11} aria-hidden className="pointer-events-none absolute left-2 text-faint" />
     <input
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      onKeyDown={(e) => {
       if (e.nativeEvent.isComposing) return;
       if (e.key === "Escape") {
        setQuery("");
        return;
       }
       if (!hits || hits.length === 0) return;
       if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setNav({ key: searchKey, idx: (Math.max(0, activeIdx) + delta + hits.length) % hits.length });
       } else if (e.key === "Enter") {
        const hit = hits[Math.max(0, activeIdx)];
        if (hit) {
         e.preventDefault();
         void locate(hit);
        }
       }
      }}
      placeholder={t.filesFilterPlaceholder}
      aria-label={t.filesSearchAria}
      title={root}
      className="h-6 w-full rounded-md border border-transparent bg-hover pr-6 pl-6 text-[12px] outline-none transition-colors duration-100 placeholder:text-faint focus:border-accent/60 focus:bg-surface"
     />
     {searching && (
      <button
       onClick={() => setQuery("")}
       className="absolute right-1 flex size-4 cursor-pointer items-center justify-center rounded text-faint transition-colors duration-100 hover:bg-active hover:text-foreground"
       aria-label={t.filesSearchClear}
       title={t.filesSearchClear}
      >
       <X size={10} aria-hidden />
      </button>
     )}
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
   {searching ? (
    <div className="min-h-0 flex-1 overflow-y-auto py-1 pr-1" aria-busy={hits === null}>
     {hits === null && !searchError && <p className="px-3 py-1 text-[11px] text-faint">{t.filesSearching}</p>}
     {searchError && (
      <p className="px-3 py-1 text-[11px] text-danger" title={searchError}>
       {t.filesSearchFailed}
      </p>
     )}
     {hits !== null && hits.length === 0 && <p className="px-3 py-2 text-[12px] text-faint">{t.filesSearchEmpty}</p>}
     {hits?.map(renderHit)}
     {hits !== null && found?.truncated && (
      <p className="px-3 py-1 text-[10px] text-faint">{t.filesSearchTruncated}</p>
     )}
    </div>
   ) : (
    <div className="min-h-0 flex-1 overflow-y-auto py-1 pr-1">
     <p className="truncate px-3 py-0.5 text-[10px] text-faint" title={root}>
      {rootName}
     </p>
     {renderLevel(root, 0)}
    </div>
   )}
   {notice && <p className="shrink-0 border-t border-border-soft px-3 py-1 text-[11px] text-faint">{notice}</p>}
  </div>
 );
}
