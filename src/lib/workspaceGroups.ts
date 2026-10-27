import type { CheckoutView, ProjectView } from "@shared/types";

/**
 * 工作区（V21 多项目容器）的前端逻辑：`cwd → 项目 / 工作区` 的映射（纯函数，不读 store、
 * 不发 IPC，单测锁着）。左栏分组、引用浮层的范围、提交面板的目录名都从这里取同一份口径。
 */

/** cwd → 项目 id：先按目录行精确匹配，再退回项目主目录前缀（最长优先）。 */
export function projectIdForPath(
 cwd: string,
 checkouts: readonly CheckoutView[],
 projects: readonly ProjectView[],
): string | null {
 const exact = checkouts.find((c) => c.path === cwd);
 if (exact) return exact.projectId;
 let best: string | null = null;
 let bestLen = -1;
 for (const p of projects) {
  const prefix = p.path.endsWith("/") ? p.path : `${p.path}/`;
  if ((cwd === p.path || cwd.startsWith(prefix)) && p.path.length > bestLen) {
   best = p.id;
   bestLen = p.path.length;
  }
 }
 return best;
}
