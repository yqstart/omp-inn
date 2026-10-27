import type { SkillItem } from "@shared/types";
import { fmt, type Text, type TextKey } from "./locale";

/**
 * 技能页的纯逻辑（设置 ›「技能」）：把 omp 的 `source`（`<provider>:<level>`）
 * 与发现结果整理成界面要的分组。发现本身在 omp 里做（`omp skill list`），
 * 壳侧不自己扫目录、不猜优先级。
 */

/** 已知的 provider id（`omp skill list --json` 的 `source` 前缀；未知值原样显示）。 */
export const SKILL_PROVIDERS = [
 "native",
 "agents",
 "claude",
 "codex",
 "omp-plugins",
 "omp-managed",
 "custom",
 "opencode",
 "github",
] as const;
export type SkillProvider = (typeof SKILL_PROVIDERS)[number];

/** 已知 provider → 字典键（界面把 provider id 翻成「omp 原生目录」这类说明）。 */
const PROVIDER_KEYS: Record<SkillProvider, TextKey> = {
 native: "skillProvNative",
 agents: "skillProvAgents",
 claude: "skillProvClaude",
 codex: "skillProvCodex",
 "omp-plugins": "skillProvOmpPlugins",
 "omp-managed": "skillProvOmpManaged",
 custom: "skillProvCustom",
 opencode: "skillProvOpencode",
 github: "skillProvGithub",
};

/** provider 的字典键；未知 provider 返回 null，界面退回显示原样字符串（不猜）。 */
export function skillProviderLabelKey(provider: string): TextKey | null {
 return (SKILL_PROVIDERS as readonly string[]).includes(provider)
  ? PROVIDER_KEYS[provider as SkillProvider]
  : null;
}

/** `source` → 界面说明（`用户级 · Agents 目录`）：已知 provider 走字典，未知原样拼接。 */
export function skillSourceLabel(source: string, t: Text): string {
 const { provider, level } = parseSkillSource(source);
 const key = skillProviderLabelKey(provider);
 const prov = key ? t[key] : provider;
 const lvl = level === "project" ? t.skillLevelProject : level === "user" ? t.skillLevelUser : level;
 return lvl ? fmt(t.skillsSourceFmt, lvl, prov) : prov;
}

/** 拆 `「provider:level」`；没有冒号时整串当 provider、level 为空。 */
export function parseSkillSource(source: string): { provider: string; level: string } {
 const i = source.indexOf(":");
 if (i < 0) return { provider: source, level: "" };
 return { provider: source.slice(0, i), level: source.slice(i + 1) };
}

export type SkillGroupId = "project" | "user" | "other";

/** 名字序（不依赖 locale，测试稳定）。 */
function byName(a: SkillItem, b: SkillItem): number {
 return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * 按作用域分组：**项目级**（本范围发现到的项目技能，只在这个目录树里生效）→
 * **用户级**（所有项目可用）→ **其它**（provider 没给 level 的情况，原样列出）。
 * 组内按名字序；空组不出现。
 */
export function groupSkills(skills: SkillItem[]): { id: SkillGroupId; items: SkillItem[] }[] {
 const buckets: Record<SkillGroupId, SkillItem[]> = { project: [], user: [], other: [] };
 for (const s of skills) {
  const { level } = parseSkillSource(s.source);
  if (level === "project") buckets.project.push(s);
  else if (level === "user") buckets.user.push(s);
  else buckets.other.push(s);
 }
 return (["project", "user", "other"] as const)
  .filter((id) => buckets[id].length > 0)
  .map((id) => ({ id, items: [...buckets[id]].sort(byName) }));
}

/** 停用名单的展示序（后端给的是配置里的顺序，按名字排一遍更稳）。 */
export function sortDisabled(names: string[]): string[] {
 return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
