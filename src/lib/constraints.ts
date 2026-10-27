import { isMap, parseDocument } from "yaml";

/**
 * 设置 ›「omp 约束」的数据层：**只做只读解析**——把一份全局约束 / 规则文件的文本拆成
 * frontmatter（结构化字段）+ 正文，供列表摘要、类型标签与保存前校验使用。
 *
 * 界面上所有文件都是**直接编辑整份 Markdown**（2026-10-19 用户口径：去掉表单），
 * 所以这里没有「字段 → 文本」的写回路径，用户写什么就保存什么。
 *
 * 上游事实（omp 18.11.1，`docs/context-files.md` / `docs/rulebook-matching-pipeline.md`）：
 * - `AGENTS.md` 是普通 Markdown（每次会话注入上下文），**不解析 frontmatter**；
 * - `RULES.md` 是 sticky 规则（始终 always-apply，frontmatter 不能关掉它）；
 * - `rules/*.{md,mdc}` 的 frontmatter 支持 `description` / `globs` / `alwaysApply` /
 *   `condition` / `astCondition` / `question` / `scope` / `agents` / `interruptMode` /
 *   `enabled`；`enabled: false` 在 omp 发现阶段就被排除；
 * - 文件名（去扩展名）就是规则名。
 *
 * 解析只在读侧：列表摘要与类型标签看 frontmatter（解析不了就不下结论），保存前校验
 * frontmatter 的结构（上游读不懂的 frontmatter 等于坏规则）。文本本身**原样保存**。
 */

/** `interruptMode` 的合法值（上游 `Rule` 类型的联合）。 */
export const INTERRUPT_MODES = ["never", "prose-only", "tool-only", "always"] as const;
export type InterruptMode = (typeof INTERRUPT_MODES)[number];

/** 规则 frontmatter 的已知字段（读侧解析结果；没有 frontmatter 时全部取默认值）。 */
export type RuleFields = {
  description: string;
  /** 默认开；`enabled: false` 时 omp 在发现阶段就把这份规则排除掉。 */
  enabled: boolean;
  alwaysApply: boolean;
  globs: string[];
  condition: string[];
  astCondition: string[];
  question: string;
  scope: string[];
  agents: string[];
  interruptMode: InterruptMode | "";
};

/** 已知字段集合：之外的键界面提示「未识别」（omp 同样只读已知字段）。 */
export const KNOWN_RULE_FIELDS = [
  "description",
  "enabled",
  "alwaysApply",
  "globs",
  "condition",
  "astCondition",
  "question",
  "scope",
  "agents",
  "interruptMode",
] as const;

/** 规则类型（界面上的摘要标签）。 */
export type RuleKind = "always" | "ttsr" | "rulebook";

export type RuleDoc = {
  fields: RuleFields;
  body: string;
  /** 不认识的顶层字段名（界面提示用；文件本身原样保存，不会被改写）。 */
  extraFields: string[];
};

export type FrontmatterSplit = {
  /** frontmatter 文本（不含分隔线）；没有 frontmatter 时为 null。 */
  frontmatter: string | null;
  /** 正文（原样，含结尾换行）。 */
  body: string;
  /** 以 `---` 开头但没有结束行时的说明。 */
  error?: string;
};

export type RuleParseResult =
  | { ok: true; doc: RuleDoc }
  | { ok: false; error: string; body: string };

/** 内容校验问题（组件负责翻译成界面文案；`detail` 是 yaml 解析器的原文）。 */
export type ConstraintIssue =
  | { kind: "tooLarge"; bytes: number }
  | { kind: "nul" }
  | { kind: "frontmatter"; detail: string };

export const MAX_CONSTRAINT_BYTES = 2 * 1024 * 1024;
export const MAX_RULE_NAME_LEN = 96;

const RULE_NAME_EXT = [".md", ".mdc"] as const;

/** 规则文件名形状（与后端 `valid_rule_name` 同口径）：单层、非隐藏、无控制字符。 */
function isValidRuleName(name: string): boolean {
  if (!name || name.length > MAX_RULE_NAME_LEN || name.trim() !== name) return false;
  const ext = RULE_NAME_EXT.find((suffix) => name.endsWith(suffix));
  if (!ext) return false;
  const stem = name.slice(0, name.length - ext.length);
  if (!stem || stem.startsWith(".")) return false;
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || '/\\:*?"<>|'.includes(ch)) return false;
  }
  return true;
}

export function defaultRuleFields(): RuleFields {
  return {
    description: "",
    enabled: true,
    alwaysApply: false,
    globs: [],
    condition: [],
    astCondition: [],
    question: "",
    scope: [],
    agents: [],
    interruptMode: "",
  };
}

/**
 * 拆出 frontmatter 与正文。只认**第一行恰好是 `---`** 的写法（与上游 `parseFrontmatter` 同口径）；
 * 结束行可以是 `---` 或 `...`。正文按原偏移切出，往返不改写未编辑的内容。
 */
export function splitFrontmatter(text: string): FrontmatterSplit {
  const start = text.startsWith("\uFEFF") ? 1 : 0;
  const firstLineEnd = text.indexOf("\n", start);
  const firstLine = (firstLineEnd >= 0 ? text.slice(start, firstLineEnd) : text.slice(start)).replace(/\r$/, "");
  if (firstLine.trimEnd() !== "---") return { frontmatter: null, body: text };
  if (firstLineEnd < 0) {
    return { frontmatter: null, body: text, error: "frontmatter 没有结束行（需要独占一行的 `---`）" };
  }
  let lineStart = firstLineEnd + 1;
  while (lineStart <= text.length) {
    const lineEnd = text.indexOf("\n", lineStart);
    const raw = lineEnd >= 0 ? text.slice(lineStart, lineEnd) : text.slice(lineStart);
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "---" || line.trim() === "...") {
      return {
        frontmatter: text.slice(firstLineEnd + 1, lineStart).replace(/\r?\n$/, ""),
        body: text.slice(lineEnd >= 0 ? lineEnd + 1 : text.length),
      };
    }
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
  }
  return { frontmatter: null, body: text, error: "frontmatter 没有结束行（需要独占一行的 `---`）" };
}

const asText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
};

const asList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return [value];
  return [];
};

const asInterruptMode = (value: unknown): InterruptMode | "" =>
  typeof value === "string" && (INTERRUPT_MODES as readonly string[]).includes(value)
    ? (value as InterruptMode)
    : "";

const keyName = (key: unknown): string => {
  if (key && typeof key === "object" && "value" in key) {
    const value = (key as { value?: unknown }).value;
    if (typeof value === "string") return value;
  }
  return String(key);
};

/** 解析一份规则文件的文本；frontmatter 坏掉时返回错误（界面据此不给类型标签）。 */
export function parseRuleDoc(text: string): RuleParseResult {
  const split = splitFrontmatter(text);
  if (split.error) return { ok: false, error: split.error, body: split.body };
  if (split.frontmatter === null || split.frontmatter.trim() === "") {
    return { ok: true, doc: { fields: defaultRuleFields(), body: split.body, extraFields: [] } };
  }
  const document = parseDocument(split.frontmatter);
  if (document.errors.length > 0) {
    return { ok: false, error: document.errors[0].message, body: split.body };
  }
  if (document.contents !== null && !isMap(document.contents)) {
    return { ok: false, error: "frontmatter 必须是一个键值映射", body: split.body };
  }
  const fields = defaultRuleFields();
  // `Document.get` 对集合返回的是 YAML 节点；统一走 `toJS()` 拿普通值（数组 / 标量）。
  const data = document.toJS() as Record<string, unknown> | null;
  const get = (key: string): unknown =>
    data && typeof data === "object" ? data[key] : undefined;
  fields.description = asText(get("description"));
  fields.enabled = get("enabled") !== false;
  fields.alwaysApply = get("alwaysApply") === true;
  fields.globs = asList(get("globs"));
  fields.condition = asList(get("condition"));
  fields.astCondition = asList(get("astCondition"));
  fields.question = asText(get("question"));
  fields.scope = asList(get("scope"));
  fields.agents = asList(get("agents"));
  fields.interruptMode = asInterruptMode(get("interruptMode"));

  const extraFields: string[] = [];
  if (isMap(document.contents)) {
    for (const pair of document.contents.items) {
      const key = keyName(pair.key);
      if (!(KNOWN_RULE_FIELDS as readonly string[]).includes(key) && !extraFields.includes(key)) {
        extraFields.push(key);
      }
    }
  }
  return { ok: true, doc: { fields, body: split.body, extraFields } };
}

/** 规则摘要：always = 总是生效；ttsr = 有实时注入条件；rulebook = 规则手册（按需读取）。 */
export function ruleKindOf(fields: RuleFields): RuleKind {
  if (fields.alwaysApply) return "always";
  if (fields.condition.length > 0 || fields.astCondition.length > 0 || fields.question.trim() !== "") {
    return "ttsr";
  }
  return "rulebook";
}

/** 文件名 → 规则名（去掉 `.md` / `.mdc`）。 */
export function ruleDisplayName(name: string): string {
  return name.replace(/\.(?:md|mdc)$/i, "");
}

/** 文件列表项的稳定键（选中态 / 草稿缓存 / 搜索定位共用）。 */
export function constraintKey(kind: string, name: string): string {
  return `${kind}:${name}`;
}

/** 新建规则的名称校验（与后端 `valid_rule_name` 同口径；返回最终文件名）。 */
export function newRuleName(stem: string): { name: string | null; error: "empty" | "invalid" | null } {
  const trimmed = stem.trim();
  if (!trimmed) return { name: null, error: "empty" };
  const name = trimmed.endsWith(".md") || trimmed.endsWith(".mdc") ? trimmed : `${trimmed}.md`;
  if (name.length > MAX_RULE_NAME_LEN || !isValidRuleName(name)) {
    return { name: null, error: "invalid" };
  }
  return { name, error: null };
}

/** 保存前的本地校验：大小 / NUL / frontmatter 结构（规则文件才查 frontmatter）。 */
export function validateConstraintText(kind: string, text: string): ConstraintIssue | null {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_CONSTRAINT_BYTES) return { kind: "tooLarge", bytes };
  if (text.includes("\0")) return { kind: "nul" };
  if (kind === "rule" || kind === "rules") {
    // 规则文件不只看分隔符：YAML 语法必须能解析（上游读不懂的 frontmatter 等于坏规则）。
    const parsed = parseRuleDoc(text);
    if (!parsed.ok) return { kind: "frontmatter", detail: parsed.error };
  }
  return null;
}

/** 搜索用的规则描述（解析失败时退到空串，不影响搜索其它字段）。 */
export function ruleDescriptionOf(text: string): string {
  const parsed = parseRuleDoc(text);
  return parsed.ok ? parsed.doc.fields.description : "";
}
