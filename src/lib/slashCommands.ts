import type { AvailableCommand, AvailableSubcommand } from "@shared/types";

/**
 * 输入框 `/` 补全的数据层：归一 omp 命令面 → 过滤打分 → 分组 → 插入文本。
 *
 * 数据只来自 omp 自己给的 `available_commands_update`（握手期就推，缓存进 `SessionMeta.commands`），
 * **壳侧不扫任何目录**：技能在 omp 里就是命令面的一部分（`skills.enableSkillCommands` 把它们发成
 * `skill:<名>`），自己扫 `~/.agents/skills/` 既要复刻 omp 的加载优先级（native 100 → 插件 90 →
 * claude 80 → agents/codex 70 → opencode 55），又必然与命令面重复。
 *
 * 子智能体（`~/.omp/agent/agents/*.md`）**不在这里**：RPC 命令面里没有它们，`/agents` hub 是终端
 * TUI 专属，壳侧发出去也调不动——列出来就是点了没用的假入口。
 */

/** 技能命令在命令面里的名字前缀（omp 发 `skill:<技能名>`）。 */
export const SKILL_PREFIX = "skill:";

export type SlashGroup = "local" | "command" | "skill";

export type SlashCandidate = {
 /** 完整命令名（插入用；技能含 `skill:` 前缀）。 */
 name: string;
 /** 行上显示的名字（技能去掉 `skill:` 前缀，对齐 ZCode 那种 `$技能名` 的观感）。 */
 display: string;
 description?: string;
 /** 参数提示（`input.hint`）。 */
 hint?: string;
 /** 别名（omp `aliases`，如 `model` 的 `models`）；参与过滤，插入时仍用 `name`。 */
 aliases: string[];
 group: SlashGroup;
};

function str(v: unknown): string | undefined {
 return typeof v === "string" && v.trim() ? v : undefined;
}

function subcommandsOf(v: unknown): AvailableSubcommand[] | undefined {
 if (!Array.isArray(v)) return undefined;
 const out: AvailableSubcommand[] = [];
 for (const item of v) {
  if (!item || typeof item !== "object") continue;
  const o = item as Record<string, unknown>;
  const name = str(o.name);
  if (!name) continue;
  out.push({ name, description: str(o.description), usage: str(o.usage) });
 }
 return out.length > 0 ? out : undefined;
}

/**
 * 归一 omp 命令面。线上是未知形状的 JSON（omp 大版本升级可能改字段），
 * 缺 `name` 的项一律丢弃——补全列表少一条好过整个列表崩掉。
 */
export function normalizeCommands(raw: unknown): AvailableCommand[] {
 if (!Array.isArray(raw)) return [];
 const out: AvailableCommand[] = [];
 for (const item of raw) {
  if (!item || typeof item !== "object") continue;
  const o = item as Record<string, unknown>;
  const name = str(o.name);
  if (!name) continue;
  // `input.hint` 是实测形状（rpc-memo §1）；扁平的 `hint` 留给上游万一改回平铺
  const input = o.input && typeof o.input === "object" ? (o.input as Record<string, unknown>) : null;
  const aliases = Array.isArray(o.aliases) ? o.aliases.filter((a): a is string => typeof a === "string" && !!a) : [];
  out.push({
   name,
   description: str(o.description),
   aliases: aliases.length > 0 ? aliases : undefined,
   hint: str(o.hint) ?? str(input?.hint),
   source: str(o.source),
   subcommands: subcommandsOf(o.subcommands),
  });
 }
 return out;
}

function toCandidate(cmd: AvailableCommand): SlashCandidate {
 // `source` 是权威判据；名字前缀兜底，防止上游漏发 source 时技能被混进命令组
 const isLocal = cmd.source === "local";
 const isSkill = cmd.source === "skill" || cmd.name.startsWith(SKILL_PREFIX);
 return {
  name: cmd.name,
  display: isSkill && cmd.name.startsWith(SKILL_PREFIX) ? cmd.name.slice(SKILL_PREFIX.length) : cmd.name,
  description: cmd.description,
  hint: cmd.hint,
  aliases: cmd.aliases ?? [],
  group: isLocal ? "local" : isSkill ? "skill" : "command",
 };
}

/**
 * 匹配打分：名字（含显示名与别名）前缀 0 → 名字子串 1 → 描述子串 2，未命中 -1。
 * 描述也进搜索面是有意的：omp 的描述是英文关键词（"compact"、"usage"），
 * 记不住命令名的人靠它找得到。
 */
function scoreOf(c: SlashCandidate, q: string): number {
 const fields = [c.name.toLowerCase(), c.display.toLowerCase(), ...c.aliases.map((a) => a.toLowerCase())];
 if (fields.some((f) => f.startsWith(q))) return 0;
 if (fields.some((f) => f.includes(q))) return 1;
 if (c.description?.toLowerCase().includes(q)) return 2;
 return -1;
}

/**
 * 过滤 + 排序：**先分组（命令 → 技能）、再按匹配质量、最后保持 omp 原序**。
 * 分组优先于分数是有意的——技能永远落在技能组里、命令永远落在命令组里，
 * 列表结构才不会随输入跳来跳去。空查询返回全部（原序），不做"常用置顶"：
 * 可预测的排序比猜用户习惯重要。
 */
export function filterCommands(cmds: AvailableCommand[], query: string): SlashCandidate[] {
 const q = query.trim().toLowerCase();
 const rankOf: Record<SlashGroup, number> = { local: 0, command: 1, skill: 2 };
 const scored: { cand: SlashCandidate; rank: number; score: number; order: number }[] = [];
 cmds.forEach((cmd, order) => {
  const cand = toCandidate(cmd);
  const score = q ? scoreOf(cand, q) : 0;
  if (score < 0) return;
  scored.push({ cand, rank: rankOf[cand.group], score, order });
 });
 scored.sort((a, b) => a.rank - b.rank || a.score - b.score || a.order - b.order);
 return scored.map((s) => s.cand);
}

/**
 * 草稿首个 token 是否已经是某个候选的完整命令名（含别名）。
 * 是的话 Enter 直接发送、补全不拦截——否则打全 `/usage` 再回车只会被补成 `/usage ` 停在原地，
 * 用户得按两次回车才能发一条命令。
 */
export function isCompleteCommand(cmds: AvailableCommand[], token: string): boolean {
 const t = token.trim().toLowerCase();
 if (!t) return false;
 return cmds.some((c) => c.name.toLowerCase() === t || (c.aliases ?? []).some((a) => a.toLowerCase() === t));
}

/** 选中一条候选后写回输入框的文本：完整命令名 + 一个空格（接着可以打参数）。 */
export function commandInsert(c: SlashCandidate): string {
 return `/${c.name} `;
}
