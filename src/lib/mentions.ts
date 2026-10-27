/**
 * `@文件` 提及的解析（V2 M6b）。
 *
 * 规则与 omp 内嵌实现保持一致（`extractFileMentions`，实测 omp 18.1.22）：
 * - 正则 `@(?:"([^"]+)"|'([^']+)'|([^\s@]+))`，引号形式允许路径带空格；
 * - `@` 必须在行首或紧跟 `空白 ( [ { < " ' \`` 之一（否则是邮箱之类的普通文本）；
 * - 非引号形式会去掉首尾的括号/引号/句读（`GNa` 的 trim 规则）；
 * - 结果去重且保持出现顺序。
 *
 * 注意：**展开动作是 omp 做的**（prompt 时自动把命中的文件读成 fileMention 消息），
 * 桌面壳只用这个解析结果做输入框芯片与「路径是否存在」的提示，不自己读文件进上下文。
 */

/** 前一个字符必须命中这个集合，`@` 才算提及（行首视为命中）。 */
const PRECEDING = /[\s([{<"'`]/;
const MENTION = /@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g;
const LEADING = /^[`"'([{<]+/;
const TRAILING = /[)\]}>.,;:!?"'`]+$/;

/** 单个候选做首尾修剪，修剪后为空则不算提及。 */
function trimToken(raw: string): string | null {
  const t = raw.trim().replace(LEADING, "").replace(TRAILING, "").trim();
  return t.length > 0 ? t : null;
}

/** 从文本里抽出提及路径（去重、保序）。 */
export function extractMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    const at = m.index ?? 0;
    if (at !== 0 && !PRECEDING.test(text[at - 1])) continue;
    // 引号形式直接取引号内内容；非引号形式走首尾修剪
    const token = m[1] !== undefined || m[2] !== undefined ? (m[1] ?? m[2] ?? "").trim() : trimToken(m[3] ?? "");
    if (!token) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * 按 `rewrite` 改写文本里的提及（返回 null = 原样保留），用于**发送前把短标签还原成完整相对路径**。
 *
 * 与 `extractMentions` 共用同一套正则与边界规则——改写只动真正的提及位置，
 * 正文里恰好出现的同名字符串不受影响；新路径含空白时写回引号形式（`@"a b.md"`）。
 */
export function rewriteMentions(text: string, rewrite: (token: string) => string | null): string {
  return text.replace(MENTION, (whole, dq: string | undefined, sq: string | undefined, plain: string | undefined, offset: number) => {
    if (offset !== 0 && !PRECEDING.test(text[offset - 1] ?? "")) return whole;
    const token = dq !== undefined || sq !== undefined ? (dq ?? sq ?? "").trim() : trimToken(plain ?? "");
    if (!token) return whole;
    const next = rewrite(token);
    if (next === null || next === token) return whole;
    return `@${/[\s"]/.test(next) ? `"${next}"` : next}`;
  });
}
