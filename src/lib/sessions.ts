import type { ProjectView, SessionView } from "@shared/types";

export type ProjectSessionGroup = {
  project: ProjectView;
  active: SessionView[];
  archived: SessionView[];
};

/**
 * 左侧会话按项目分组：每个项目一组（组内再分进行中/已归档），
 * projectId 为空或对不上任何项目的进 LHCW“未归属”组。
 * 输入顺序即输出顺序（后端已按 timestamp 倒序）。
 */
export function groupSessionsByProject(
  projects: ProjectView[],
  sessions: SessionView[],
): { groups: ProjectSessionGroup[]; orphanActive: SessionView[]; orphanArchived: SessionView[] } {
  const buckets = new Map<string, SessionView[]>();
  for (const p of projects) buckets.set(p.id, []);
  const orphan: SessionView[] = [];
  for (const s of sessions) {
    if (s.projectId && buckets.has(s.projectId)) {
      buckets.get(s.projectId)!.push(s);
    } else {
      orphan.push(s);
    }
  }
  const groups = projects.map((project) => {
    const all = buckets.get(project.id) ?? [];
    return {
      project,
      active: all.filter((s) => !s.archived),
      archived: all.filter((s) => s.archived),
    };
  });
  return {
    groups,
    orphanActive: orphan.filter((s) => !s.archived),
    orphanArchived: orphan.filter((s) => s.archived),
  };
}
