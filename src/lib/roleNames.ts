import type { Text } from "./locale";

/**
 * 内置角色的可读名（上游 role id → 本应用文案）；自定义角色原样显示 id。
 *
 * 设置 ›「模型」的角色列表与失败转移链的角色候选共用这一份映射——
 * 两处各写一遍会漂（同一个角色在两地显示不同名字）。
 */
export function roleLabel(role: string, t: Text): string {
  const map: Record<string, string | undefined> = {
    default: t.roleDefault,
    smol: t.roleSmol,
    slow: t.roleSlow,
    vision: t.roleVision,
    plan: t.rolePlan,
    commit: t.roleCommit,
    tiny: t.roleTiny,
    task: t.roleTask,
    advisor: t.roleAdvisor,
  };
  return map[role] ?? role;
}
