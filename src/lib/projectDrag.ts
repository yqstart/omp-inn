import type { ProjectView } from "@shared/types";

/**
 * 左栏项目拖拽（排序 / 拖进拖出工作区）的纯逻辑：容器口径、落点判定、拖拽后的新顺序与归属。
 *
 * 全部是纯函数（不读 store、不碰 DOM、不发 IPC），单测锁着——组件只负责把 DOM 矩形喂进来、
 * 把落点画出来，判重与排序规则都在这里。
 *
 * 数据模型：**全局顺序唯一**（`overlay.projects` 的数组顺序 = 左栏顺序），容器
 * （工作区 / 未分组）只是这个全序上的**投影**——组内渲染顺序 = 全局顺序里 `workspaceId`
 * 命中该组的那些项目。拖进 / 拖出工作区 = 改被拖项目的 `workspaceId` + 把它挪到目标边界，
 * 一次写完。这样不引入第二份「组内顺序」状态，删组 / 改组成员都不会留下悬空顺序。
 */

/** 容器 id：工作区 id；`null` = 未分组（没有自定义工作区时，平铺的项目列表也是它）。 */
export type ProjectContainerId = string | null;

/** 拖拽落点：插到目标容器的某个位置。 */
export type ProjectDropTarget = {
 containerId: ProjectContainerId;
 /** 插到这个项目之前（必须是同一容器的成员）；`null` = 容器末尾。 */
 beforeId: string | null;
};

/**
 * 命中条目（组件按**视觉顺序**喂入：容器在前、它的行紧随其后；矩形用 client 坐标）。
 * 容器条目 = 组头 / 空组提示 / 组的空白区（落点 = 容器末尾）。
 */
export type ProjectDropHit =
 | { kind: "row"; projectId: string; containerId: ProjectContainerId; top: number; bottom: number }
 | { kind: "container"; containerId: ProjectContainerId; top: number; bottom: number };

/** 行内判「插在前 / 后」的中线：项目头 36px，取一半（18px）——块很高时也不会把上半段判成「之后」。 */
const ROW_MID_MAX = 18;

/** 同一容器里紧跟在 `projectId` 之后的那一行（跳过被拖拽的行）；没有则 `null`（= 容器末尾）。 */
function nextRowId(hits: readonly ProjectDropHit[], projectId: string, draggingId: string): string | null {
 const start = hits.findIndex((h) => h.kind === "row" && h.projectId === projectId);
 if (start < 0) return null;
 const containerId = (hits[start] as Extract<ProjectDropHit, { kind: "row" }>).containerId;
 for (let i = start + 1; i < hits.length; i++) {
  const h = hits[i];
  if (h.kind !== "row") continue;
  if (h.containerId !== containerId) return null; // 出了这个容器 → 容器末尾
  if (h.projectId === draggingId) continue; // 被拖的行还占着位置，不算下一个
  return h.projectId;
 }
 return null;
}

/**
 * 指针位置 → 拖拽落点（`null` = 不在任何可放置的位置，含「悬在被拖项目自己身上」）。
 *
 * 判定顺序：① 命中某一行 → 按行内中线判前 / 后；② 命中容器（组头 / 空组 / 组的空白）→ 容器末尾；
 * ③ 落在条与条之间的缝隙（组间距、列表底部留白）→ 归到**上方最近**的那一条。
 */
export function pickDropTarget(
 hits: readonly ProjectDropHit[],
 y: number,
 draggingId: string,
): ProjectDropTarget | null {
 for (const h of hits) {
  if (h.kind !== "row" || y < h.top || y > h.bottom) continue;
  // 悬在自己身上 = 原地不动：不画指示线，松开也不发请求
  if (h.projectId === draggingId) return null;
  const below = y > h.top + Math.min(ROW_MID_MAX, (h.bottom - h.top) / 2);
  return { containerId: h.containerId, beforeId: below ? nextRowId(hits, h.projectId, draggingId) : h.projectId };
 }
 for (const h of hits) {
  if (h.kind === "container" && y >= h.top && y <= h.bottom) return { containerId: h.containerId, beforeId: null };
 }
 let above: ProjectDropHit | null = null;
 for (const h of hits) if (h.top <= y) above = h;
 if (above === null) return null;
 return above.kind === "container"
  ? { containerId: above.containerId, beforeId: null }
  : { containerId: above.containerId, beforeId: nextRowId(hits, above.projectId, draggingId) };
}

/** 拖拽的落地计划：新全局顺序 + 新归属；`changed = false` 时调用方跳过请求。 */
export type ProjectMovePlan = {
 /** 全部项目 id 的新顺序（发给后端的 `order`）。 */
 order: string[];
 /** 被拖项目的新归属（发给后端的 `workspaceId`；`null` = 未分组）。 */
 containerId: ProjectContainerId;
 /** 顺序与归属都没变（原地松开）。 */
 changed: boolean;
};

/**
 * 落点 → 落地计划：把被拖项目从全局顺序里摘出来，插到目标边界（容器末尾 = 目标容器最后一个
 * 成员之后；容器里没有别的成员 = 数组末尾），归属改为目标容器。原顺序与归属都没变 → `changed: false`。
 */
export function planProjectMove(
 projects: readonly ProjectView[],
 movedId: string,
 target: ProjectDropTarget,
): ProjectMovePlan {
 const ids = projects.map((p) => p.id);
 const moved = projects.find((p) => p.id === movedId) ?? null;
 if (moved === null) return { order: ids, containerId: target.containerId, changed: false };
 const owner = new Map(projects.map((p) => [p.id, p.workspaceId] as const));
 const rest = ids.filter((id) => id !== movedId);
 let at: number;
 if (target.beforeId !== null && owner.get(target.beforeId) === target.containerId) {
  const i = rest.indexOf(target.beforeId);
  at = i < 0 ? rest.length : i;
 } else {
  // 容器末尾：目标容器最后一个成员之后；容器里没有别的成员 → 数组末尾
  let last = -1;
  for (let i = 0; i < rest.length; i++) if (owner.get(rest[i]) === target.containerId) last = i;
  at = last < 0 ? rest.length : last + 1;
 }
 const order = [...rest.slice(0, at), movedId, ...rest.slice(at)];
 const changed = moved.workspaceId !== target.containerId || order.some((id, i) => id !== ids[i]);
 return { order, containerId: target.containerId, changed };
}
