/**
 * 会话标题的显示口径：去掉**开头**的 omp 标题卡前缀——图标（Nerd Font 字形 / emoji）
 * 与其后的大写短码（`COMMIT:` 这类分类码），两段一起剥。
 *
 * 背景：
 * - （2026-10-14，用户报「会话前的标识符太丑」）omp 侧标题会在开头挂 Nerd Font 图标码位
 *   （实测 `󰡍 HGT: 修复输入框高度过高`，U+F084D 来自 omp 侧写入的 jsonl 标题）。壳里
 *   （WebView）没有覆盖私有区的字体，WebKit 回退到 Apple Symbols 的杂物字形——同一码位
 *   在别的字体下画出来的东西完全不同（U+F084D 实测是 6 根横条）。
 * - （2026-10-15，用户报「生成的标题去除前缀」）omp 18.8.7+ 的标题卡（上游
 *   `utils/title-card.ts`，`title.icons` 设置默认 `nf+emoji`）会在生成 / `/rename` 时把
 *   标题写成 `${icon} ${code}: ${title}`（实测 `󰜘 COMMIT: 提交推送后仍有修改标识`）——
 *   图标之外还有一段大写短码，终端里是卡片、壳里只是噪音。
 *
 * 边界：
 * - **只去开头**：中段的图标 / 短码属于标题内容，不搬运、不删（同一条消息里的图标不是「前缀」）。
 * - **裸短码不剥**：`HGT: 修复…` 这种没有图标的形态不是 omp 的卡（上游 `title-card.ts`
 *   的解析也要求图标存在），照原文显示——不把用户自己写的「大写词 + 冒号」标题吃掉。
 * - **数据不动**：只作用于显示（侧栏行 / 删除确认 / 顶栏 / 命令面 / 归档 / 设置搜索 / aria）与
 *   **改名输入框的回显**（2026-10-15 用户报「改标题时前方还有个图标」——回显跟着显示口径走，
 *   图标 / 短码不进输入框；原样提交不写盘，改过的才按用户看到 / 编辑的文本写回 omp 真名）；
 *   导出、`list_sessions` 的原始标题仍带前缀——显示口径不写回数据。
 * - 整条标题只有前缀（去掉后为空）时返回原文：行变空白比留个符号更难认。
 */

/** omp 标题卡前缀：图标（1–8 个码位：Nerd Font 私有区字形 / emoji）+ 短码（1–6 位大写字母 / 数字）+ 冒号 + 空白。
 *  图标字符类不用「任何非 ASCII」——中文也非 ASCII，那样会把 `修复 COMMIT: 收尾` 当成卡剥掉。 */
const TITLE_CARD_PREFIX = /^[\p{Co}\p{Extended_Pictographic}\uFE0E\uFE0F\u200D]{1,8}\s+[A-Z0-9]{1,6}:\s*/u;

/** 单纯的图标前缀（PUA 码位 / 变体选择符）及其后的空白。 */
const LEADING_ICON = /^[\p{Co}\uFE0E\uFE0F]+[\s\u00A0]*/u;

/** 标题的显示文本：去掉开头的标题卡前缀（图标 + 短码），或单独的 PUA 图标。 */
export function sessionTitleForDisplay(title: string): string {
 const stripped = title.replace(TITLE_CARD_PREFIX, "").replace(LEADING_ICON, "");
 return stripped.trim() === "" ? title : stripped;
}
