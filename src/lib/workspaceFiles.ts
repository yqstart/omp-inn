import type { CheckoutView, ProjectFiles, ProjectView, WorkspaceView } from "@shared/types";
import { projectIdForPath } from "./workspaceGroups";

/**
 * 引用浮层（V22）的纯逻辑：范围解析、候选构建、模糊排序、目录树构建、命中高亮、注入文本。
 *
 * 范围口径：当前会话 cwd 所属项目**不列**——本项目文件在输入框里用 omp 原生 `@`
 * 直接可补全；浮层只解决「另一个项目」的挑选问题（工作区成员项目主目录，与自动
 * `--add-dir` 协作根一致）。
 */

/** 引用浮层的范围：`primary` = cwd 所属项目（找不到 / 目录丢失时为 null）；`others` = 可引用的其他成员项目。 */
export type RefScope = {
 primary: ProjectView | null;
 others: ProjectView[];
};

/**
 * cwd → 可引用的项目集合：
 * - `primary` 找不到 / 目录丢失 → 两个字段都空（调用方提示「找不到所属项目」）；
 * - 工作区里的其他有效成员（存在且未丢失）→ `others`（保持左栏顺序，**不含 worktree**）；
 * - 未分组 / 单成员工作区 → `others` 为空（调用方提示「没有可引用的其他项目」）。
 */
export function referenceScope(
 cwd: string,
 workspaceGroups: readonly WorkspaceView[],
 checkouts: readonly CheckoutView[],
 projects: readonly ProjectView[],
): RefScope {
 const projectId = projectIdForPath(cwd, checkouts, projects);
 const primary = (projectId === null ? undefined : projects.find((p) => p.id === projectId)) ?? null;
 if (!primary || primary.missing) return { primary: null, others: [] };
 const group = workspaceGroups.find((w) => w.id === primary.workspaceId);
 const members = group ? projects.filter((p) => p.workspaceId === group.id && !p.missing) : [];
 return { primary, others: members.filter((p) => p.id !== primary.id) };
}

/**
 * 当前目录能不能引用「工作区文件」：口径 = `referenceScope` 里有可引用的其他成员项目。
 * 未进入工作区的项目（未分组）/ 单成员工作区 / 目录不属于任何项目 → false，
 * 引用入口（`+` 与 `/` 面板、`@` 浮层、⌘⇧P）一律不出现——没有工作区就没有跨项目可引用。
 */
export function hasWorkspaceRefs(
 cwd: string,
 workspaceGroups: readonly WorkspaceView[],
 checkouts: readonly CheckoutView[],
 projects: readonly ProjectView[],
): boolean {
 return referenceScope(cwd, workspaceGroups, checkouts, projects).others.length > 0;
}

/** 浮层候选（一个文件一行）：按项目展开。 */
export type RefItem = {
 projectId: string;
 projectName: string;
 /** 仓库相对路径（POSIX；`git ls-files` 原样）。 */
 rel: string;
 /** 绝对路径（joinAbs 拼，注入用）。 */
 abs: string;
};

/** 把批量文件列表摊平成候选：`error` 组跳过；项目名按路径回查（找不到用目录名兜底）。 */
export function buildRefItems(
 groups: readonly ProjectFiles[],
 projects: readonly ProjectView[],
): RefItem[] {
 const items: RefItem[] = [];
 for (const group of groups) {
  if (group.error !== null) continue;
  const project = projects.find((p) => p.path === group.path);
  const projectId = project?.id ?? group.path;
  const projectName = project?.name ?? group.path.split("/").filter(Boolean).pop() ?? group.path;
  for (const rel of group.files) {
   items.push({ projectId, projectName, rel, abs: joinAbs(group.path, rel) });
  }
 }
 return items;
}

/** 词边界：位置 0、分隔符（`-_./ `）之后、或小驼峰边界（`mainLayout` 的 `L`）。 */
function isWordStart(text: string, index: number): boolean {
 if (index <= 0) return true;
 const prev = text[index - 1] ?? "";
 const cur = text[index] ?? "";
 if ("-_./ ".includes(prev)) return true;
 return prev !== prev.toUpperCase() && cur !== cur.toLowerCase();
}

/**
 * 单个查询词打分（越大越好；0 = 不匹配）。判据从强到弱：
 * 1. 末段（文件名）精确 1000 / 前缀 900；
 * 2. 词边界处包含 860（`api-client.ts` 的 `api`）、路径段首 800（`src/api/…`）、
 *    整串路径前缀 800（`api/x.ts`）；
 * 3. 文件名内任意位置包含 700（`capitalize.ts` 的 `api`——真包含但不在词边界）；
 * 4. 文件名内的**紧凑子序列**（如 `mts` → `main.ts`）：跨度 ≤ `词长 × 2 + 2`，
 *    且「起点在文件名开头 / 词边界」与「紧凑度」给加成——`main.ts` 会排在 `format.ts` 前。
 *    跨目录散布的假匹配（`main` 命中 `approval-menu/approval-mine-selected.svg`）直接丢弃。
 */
function scoreTerm(term: string, rel: string): number {
 const r = rel.toLowerCase();
 const b = r.slice(r.lastIndexOf("/") + 1);
 const rawBase = rel.slice(rel.lastIndexOf("/") + 1);
 if (term === b) return 1000;
 if (b.startsWith(term)) return 900;
 let best = 0;
 const at = b.indexOf(term);
 if (at > 0) best = isWordStart(rawBase, at) ? 860 : 700;
 if (r.startsWith(term)) best = Math.max(best, 800);
 if (r.includes(`/${term}`)) best = Math.max(best, 800);
 if (best > 0) return best;
 let i = 0;
 let first = -1;
 let last = -1;
 for (let j = 0; j < b.length && i < term.length; j += 1) {
  if (b[j] === term[i]) {
   if (first < 0) first = j;
   last = j;
   i += 1;
  }
 }
 if (i !== term.length) return 0;
 const span = last - first + 1;
 if (span > term.length * 2 + 2) return 0;
 const startBonus = first === 0 ? 120 : isWordStart(rawBase, first) ? 60 : 0;
 return 300 + startBonus + Math.max(0, 80 - 2 * (span - term.length));
}

/** 查询分词（空白分隔，全部小写）：多词 = **全部命中**（AND），分数相加——`src api` 这类输入才有结果。 */
export function refQueryTerms(query: string): string[] {
 return query.trim().toLowerCase().split(/\s+/).filter((s) => s.length > 0);
}

/**
 * 过滤 + 排序，取前 `limit` 条：
 * 空 query = 原序前 `limit` 条；同分按 rel 短者先、再字典序（结果稳定，光标不跳）。
 */
export function rankRefItems(query: string, items: readonly RefItem[], limit: number): RefItem[] {
 const terms = refQueryTerms(query);
 if (terms.length === 0) return items.slice(0, limit);
 const scored: { item: RefItem; score: number }[] = [];
 for (const item of items) {
  let total = 0;
  let matched = true;
  for (const term of terms) {
   const score = scoreTerm(term, item.rel);
   if (score === 0) {
    matched = false;
    break;
   }
   total += score;
  }
  if (matched) scored.push({ item, score: total });
 }
 scored.sort(
  (a, b) =>
   b.score - a.score ||
   a.item.rel.length - b.item.rel.length ||
   (a.item.rel < b.item.rel ? -1 : a.item.rel > b.item.rel ? 1 : 0),
 );
 return scored.slice(0, limit).map((s) => s.item);
}

/** 目录树节点：目录（含子节点）或文件（叶子 = 候选）；`rank` = 在候选序列里的名次（用于搜索态排序）。 */
export type RefTreeNode =
 | { kind: "dir"; name: string; rel: string; rank: number; children: RefTreeNode[] }
 | { kind: "file"; name: string; item: RefItem; rank: number };

/**
 * 渲染行：目录行（chevron 折叠，行尾 hover 出「引用整个文件夹」）或文件行（叶子 = 候选）。
 * `index` = **行序号**（↑↓ 光标序列，与渲染顺序严格一致）——目录行也参与，所以停在目录行按 Enter
 * 就是引用这个文件夹。
 */
export type RefRow =
 | { kind: "dir"; name: string; rel: string; depth: number; index: number }
 | { kind: "file"; name: string; item: RefItem; depth: number; index: number };

function isDirNode(node: RefTreeNode): node is Extract<RefTreeNode, { kind: "dir" }> {
 return node.kind === "dir";
}

/**
 * 树内排序：
 * - `byRank`（搜索态，query 非空）：按 `rank` 升序——目录的 rank = 其子树最佳名次，
 *   所以「最佳匹配」所在的目录/文件自然浮到同级最前；同 rank 时目录在前、按名字。
 * - 浏览态（空 query）：目录在前、同级按名字（资源管理器的默认观感）。
 */
function sortRefTree(nodes: RefTreeNode[], byRank: boolean): void {
 for (const node of nodes) {
  if (isDirNode(node)) {
   sortRefTree(node.children, byRank);
   node.rank = node.children.reduce((min, child) => Math.min(min, child.rank), Number.MAX_SAFE_INTEGER);
  }
 }
 nodes.sort((a, b) => {
  if (byRank && a.rank !== b.rank) return a.rank - b.rank;
  return a.kind === b.kind ? a.name.localeCompare(b.name) : isDirNode(a) ? -1 : 1;
 });
}

/**
 * 把候选按 `rel` 的 `/` 分段插入目录树（同名目录合并；空段忽略）。
 * `items` 的顺序就是「匹配名次」（调用方传入已按分数降序的列表）；`byRank` = 用该名次排序（搜索态）。
 */
export function buildRefTree(items: readonly RefItem[], byRank = false): RefTreeNode[] {
 const root: RefTreeNode[] = [];
 items.forEach((item, itemRank) => {
  const segments = item.rel.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return;
  let level = root;
  let prefix = "";
  for (let i = 0; i < segments.length; i += 1) {
   const name = segments[i] ?? "";
   prefix = prefix.length === 0 ? name : `${prefix}/${name}`;
   if (i === segments.length - 1) {
    level.push({ kind: "file", name, item, rank: itemRank });
    break;
   }
   const existing = level.find((node): node is Extract<RefTreeNode, { kind: "dir" }> =>
    node.kind === "dir" && node.name === name,
   );
   if (existing) {
    level = existing.children;
   } else {
    const created: Extract<RefTreeNode, { kind: "dir" }> = {
     kind: "dir",
     name,
     rel: prefix,
     rank: Number.MAX_SAFE_INTEGER,
     children: [],
    };
    level.push(created);
    level = created.children;
   }
  }
 });
 sortRefTree(root, byRank);
 return root;
}

/**
 * 前序遍历成渲染序列，并给**每一行**（目录行 + 文件行）编上连续的光标序号——
 * ↑↓ 既能停在文件上（Enter = 引用文件），也能停在目录行上（Enter = 引用整个文件夹）。
 * `isCollapsed(rel)` 命中的目录：目录行本身保留，整棵子树跳过（资源管理器树的折叠语义）。
 */
export function flattenRefTree(
 nodes: readonly RefTreeNode[],
 isCollapsed?: (rel: string) => boolean,
): RefRow[] {
 const rows: RefRow[] = [];
 let index = 0;
 const walk = (list: readonly RefTreeNode[], depth: number): void => {
  for (const node of list) {
   if (isDirNode(node)) {
    rows.push({ kind: "dir", name: node.name, rel: node.rel, depth, index: index++ });
    if (isCollapsed?.(node.rel)) continue;
    walk(node.children, depth + 1);
   } else {
    rows.push({ kind: "file", name: node.name, item: node.item, depth, index: index++ });
   }
  }
 };
 walk(nodes, 0);
 return rows;
}

/** 文件行类型守卫（渲染与光标序列共用）。 */
export function isFileRow(row: RefRow): row is Extract<RefRow, { kind: "file" }> {
 return row.kind === "file";
}

/**
 * 命中高亮：把文件名切成片段（`hit` = 命中的字符）。
 * 词在名字里连续出现 → 整段命中；否则做子序列逐字符命中（没有命中就返回单段）。
 */
export function highlightName(name: string, terms: readonly string[]): { text: string; hit: boolean }[] {
 const lower = name.toLowerCase();
 const marks: boolean[] = new Array<boolean>(name.length).fill(false);
 for (const term of terms) {
  if (term.length === 0 || name.length === 0) continue;
  let idx = lower.indexOf(term);
  if (idx >= 0) {
   while (idx >= 0) {
    for (let k = idx; k < Math.min(idx + term.length, name.length); k += 1) marks[k] = true;
    idx = lower.indexOf(term, idx + term.length);
   }
   continue;
  }
  let i = 0;
  const hits: number[] = [];
  for (let j = 0; j < lower.length && i < term.length; j += 1) {
   if (lower[j] === term[i]) {
    hits.push(j);
    i += 1;
   }
  }
  if (i === term.length) {
   for (const h of hits) marks[h] = true;
  }
 }
 const parts: { text: string; hit: boolean }[] = [];
 for (let i = 0; i < name.length; i += 1) {
  const hit = marks[i] === true;
  const last = parts[parts.length - 1];
  const char = name[i] ?? "";
  if (last && last.hit === hit) last.text += char;
  else parts.push({ text: char, hit });
 }
 return parts.length > 0 ? parts : [{ text: name, hit: false }];
}

/** 项目根 + 仓库相对路径 → 绝对路径（POSIX；壳目标平台 macOS/Linux）。 */
export function joinAbs(root: string, rel: string): string {
 return `${root.replace(/\/+$/, "")}/${rel}`;
}

/** 去掉末尾斜杠（比较 / 展示用；根 `/` 保留）。 */
function trimTail(path: string): string {
 const t = path.replace(/\/+$/, "");
 return t.length > 0 ? t : "/";
}

/**
 * 绝对路径 → 相对 `cwd` 的路径（POSIX 词法计算，不碰文件系统）。
 * **只在条目确实在 `cwd` 之内时给值**（算出来带 `..` / 越界一律返回 null）——
 * 会话目录之外的引用仍走绝对路径，绝不用 `../` 把用户带到别的目录去解析。
 */
export function relativeToCwd(cwd: string, abs: string): string | null {
 if (!cwd || !abs) return null;
 const base = trimTail(cwd);
 const target = trimTail(abs);
 if (target === base) return null;
 if (!target.startsWith(`${base}/`)) return null;
 const rel = target.slice(base.length + 1);
 return rel.length > 0 && !rel.split("/").includes("..") ? rel : null;
}

/**
 * 引用注入用的路径（唯一口径，右栏文件树与 ⌘⇧P 引用浮层共用）：
 * 会话目录内的条目给**相对路径**（`src/components/FileTree.tsx`），目录外的给绝对路径。
 */
export function referenceTarget(cwd: string, abs: string): string {
 return relativeToCwd(cwd, abs) ?? abs;
}

/**
 * 芯片上的短名（`@` 后面那一段）：目录补尾斜杠，好和文件区分开。
 * 完整路径仍在 `title` 里，读屏与悬停都拿得到。
 */
export function referenceLabel(path: string, isDir: boolean): string {
 const name = trimTail(path).split("/").pop() || path;
 return isDir ? `${name}/` : name;
}
