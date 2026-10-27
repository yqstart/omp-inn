import type { ProjectView } from "@shared/types";

/**
 * 设置页「范围」选择（插件页与技能页共用）：插件 / 技能的**可见范围**都是 cwd——
 * 项目级插件（项目 package.json 依赖、项目级市场安装）与项目级技能（`.omp/skills` 等）
 * 都由 omp 按目录发现，所以两个页面都要一个「全局 / 某个项目」的选择器。
 *
 * 选项直接喂给 `EnumSelect`（触发按钮显示的是 `value`，列表里显示 `label`）：
 * `value` 要能在按钮上认出来，所以默认就是项目名（同名项目才把路径并进去保证唯一）；
 * `label` 是列表里的完整说明。
 */

export type ScopeOption = {
 /** 展示与回传的稳定值（同名项目时含路径）。 */
 value: string;
 /** 列表里的完整说明（名字 · 路径）。 */
 label: string;
 /** 目标目录；`null` = 全局（用户级：插件钉 agentDir，技能钉家目录）。 */
 path: string | null;
};

/** 造范围选项：全局 + 每个可用项目（缺目录的项目不列——cd 不进去，问了也白问）。 */
export function scopeChoices(globalLabel: string, projects: ProjectView[]): ScopeOption[] {
 const usable = projects.filter((p) => !p.missing);
 // 与「全局」那一项的显示名撞车的项目名也算重名：value 是 EnumSelect 触发按钮上显示的文本，
 // 也是 onPick 回传的键——撞车会让那个项目永远选不中。
 const seen = new Map<string, number>();
 seen.set(globalLabel, 1);
 for (const p of usable) seen.set(p.name, (seen.get(p.name) ?? 0) + 1);
 const out: ScopeOption[] = [{ value: globalLabel, label: globalLabel, path: null }];
 for (const p of usable) {
  const dup = (seen.get(p.name) ?? 0) > 1;
  out.push({
   value: dup ? `${p.name} · ${p.path}` : p.name,
   label: `${p.name} · ${p.path}`,
   path: p.path,
  });
 }
 return out;
}

/** 选中的目录 → 选项 value；项目没了 / 改名了回退全局（不把界面留在不存在的范围上）。 */
export function scopeValue(options: ScopeOption[], path: string | null): string {
 if (path !== null) {
  const hit = options.find((o) => o.path === path);
  if (hit) return hit.value;
 }
 return options[0]?.value ?? "";
}
