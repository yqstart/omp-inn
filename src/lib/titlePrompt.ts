/**
 * 会话标题语言（V18）：把壳的**界面语言**同步成 omp 的自动会话标题 prompt。
 *
 * 上游事实（omp 18.2.10：源码 + 官方文档）：
 * - 自动会话标题的生成 prompt 可以用 `TITLE_SYSTEM.md` 覆盖——**项目级
 *   `<cwd>/.omp/TITLE_SYSTEM.md` 优先，其次用户级 `<agentDir>/TITLE_SYSTEM.md`**；
 * - 上游没有 CLI / 设置项改标题 prompt（`--no-title` 只是关自动标题），
 *   写用户级文件是壳侧唯一路径；
 * - 内置 prompt 不指定语言 → 壳按界面语言写「用简体中文 / 用英文」；
 * - omp 在**会话启动**时读该文件 → 切语言对**新开的终端**生效，已开的会话保持原语言。
 *
 * 「谁的文件」判定在后端（`title_prompt.rs`）：只有文件不存在、或内容恰好是壳的
 * 中文 / 英文文本时才写；用户自写的同名文件一律跳过，永不覆盖。
 */

import { api } from "@shared/api";
import type { Locale } from "./locale";

/**
 * 把当前界面语言同步给 omp 的标题生成 prompt；**失败静默**——
 * 这是尽力而为的体验增强（omp 不可用、用户接管了文件都属正常），
 * 失败不该弹错也不该挡住语言切换本身。
 */
export async function syncTitlePromptLanguage(locale: Locale): Promise<void> {
 try {
  // 语言档只有中 / 英两档：`zh-CN`（及任何非 en 值）→ `zh`
  await api.syncTitlePrompt(locale === "en" ? "en" : "zh");
 } catch {
  // 静默：标题语言只影响新会话的展示名，壳功能不依赖它。
 }
}
