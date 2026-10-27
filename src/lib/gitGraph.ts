import type { GitGraphCommit } from "@shared/types";

/**
 * Git 图谱的 lane 布局（纯函数，右栏「Git 图谱」页签共用）。
 *
 * 输入是后端按 `git log --topo-order` 给的提交（新的在前，子提交一定在父提交之前）。
 * 输出每行的节点 lane 与需要画的线：
 *
 * - `from` = 本行顶边的 lane（`null` = 从本行节点出发）；
 * - `to` = 本行底边的 lane（`null` = 终止于本行节点）。
 *
 * 规则：
 * - 一个提交在**唯一** lane 里等待被画；子提交把父提交登记到自己的 lane（第一个父提交）
 *   或第一条空 lane（其余父提交）；
 * - 已被别的分支登记过的父提交直接并入那条 lane（画一条斜线），不复制节点；
 * - 只连接**当前可见集合里存在**的父提交：筛选 / 分页边界不会挂出无意义的悬空线。
 *
 * 着色 / 列宽 / 曲线都由组件决定，这里只给拓扑。
 */
export type GraphEdge = {
  from: number | null;
  to: number | null;
};

export type GraphRow = {
  commit: GitGraphCommit;
  /** 本行节点所在的 lane。 */
  lane: number;
  edges: GraphEdge[];
};

export type GraphLayout = {
  rows: GraphRow[];
  /** 所有行里出现过的最大 lane 数（至少 1）；组件据此算列宽。 */
  lanes: number;
};

export function layoutGraph(commits: readonly GitGraphCommit[]): GraphLayout {
  const known = new Set(commits.map((c) => c.hash));
  const seen = new Set<string>();
  /** 每个 lane 正在等待的提交；`null` = 空槽，可被新分支复用。 */
  const active: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let lanes = 1;

  const takeFreeLane = () => {
    const free = active.indexOf(null);
    if (free >= 0) return free;
    active.push(null);
    return active.length - 1;
  };

  for (const commit of commits) {
    let lane = active.indexOf(commit.hash);
    const incoming = lane >= 0;
    if (lane < 0) {
      lane = takeFreeLane();
      active[lane] = commit.hash;
    }

    const edges: GraphEdge[] = [];
    // 其他 lane 的线穿过本行；本行节点所在的 lane 单独处理（可能从本行开始）
    for (let i = 0; i < active.length; i++) {
      if (i !== lane && active[i] !== null) edges.push({ from: i, to: i });
    }
    if (incoming) edges.push({ from: lane, to: null });

    // 节点画完，本 lane 空出来；第一个父提交优先继续这条线
    active[lane] = null;
    const parents = [...new Set(commit.parents)].filter((p) => known.has(p) && !seen.has(p));
    parents.forEach((parent, index) => {
      const existing = active.indexOf(parent);
      if (existing >= 0) {
        // 父提交已经在别的 lane 里等着：分支在这里并入（不是新 lane）
        edges.push({ from: null, to: existing });
        return;
      }
      const target = index === 0 && active[lane] === null ? lane : takeFreeLane();
      active[target] = parent;
      edges.push({ from: null, to: target });
    });

    seen.add(commit.hash);
    lanes = Math.max(lanes, lane + 1);
    for (const edge of edges) {
      lanes = Math.max(lanes, (edge.from ?? lane) + 1, (edge.to ?? lane) + 1);
    }
    rows.push({ commit, lane, edges });
  }

  return { rows, lanes };
}

/**
 * lane 0 的横坐标（未提交改动行 / 空态占位用；与 `GraphSvg` 共用同一套几何）。
 * `lanes <= 1` 时落在列中间，多 lane 时两端留 `pad`。
 */
export function laneX(lane: number, lanes: number, width: number, pad: number): number {
  if (lanes <= 1) return width / 2;
  const usable = Math.max(0, width - pad * 2);
  return pad + (usable * Math.min(lane, lanes - 1)) / (lanes - 1);
}

/** 图谱列宽：lane 越多越宽，但有上限（右栏最窄 260px 时还要给提交信息留位置）。 */
export function graphColumnWidth(lanes: number): number {
  return Math.min(120, Math.max(28, 16 + lanes * 12));
}
