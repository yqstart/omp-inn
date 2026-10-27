import type { ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Markdown 正文里的链接（记忆页 / 技能页 / 更新说明共用）：点击一律交给**系统浏览器**。
 *
 * 为什么必须拦：正文是**不可信输入**（用户或第三方的 `SKILL.md` / 记忆文件），
 * `<a href>` 在 Tauri webview 里会让整个应用导航走（没有后退入口，界面就没了）。
 * 渲染成 `button` + `openUrl` 既保住「链接点得动」，又不会把应用顶掉。
 */
export function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
 return (
  <button
   type="button"
   onClick={() => {
    if (href) void openUrl(href).catch(() => undefined);
   }}
   className="cursor-pointer text-accent underline underline-offset-2"
  >
   {children}
  </button>
 );
}
