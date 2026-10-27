import type { ReactNode } from "react";

/**
 * 搜索命中高亮（v3 设置搜索）：把 `query` 在 `text` 中的全部出现包成 `<mark>`（大小写不敏感）。
 * 只做纯文本切分，不解析任何标记；`query` 为空 / 无命中时原样返回文本。
 */
export function Highlight({ text, query }: { text: string; query: string }): ReactNode {
 const needle = query.trim().toLowerCase();
 if (!needle) return text;
 const lower = text.toLowerCase();
 const parts: ReactNode[] = [];
 let from = 0;
 for (; ;) {
  const at = lower.indexOf(needle, from);
  if (at < 0) break;
  if (at > from) parts.push(text.slice(from, at));
  parts.push(
   <mark key={at} className="rounded-sm bg-accent/15 text-foreground">
    {text.slice(at, at + needle.length)}
   </mark>,
  );
  from = at + needle.length;
 }
 if (parts.length === 0) return text;
 if (from < text.length) parts.push(text.slice(from));
 return parts;
}
