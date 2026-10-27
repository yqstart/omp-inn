import { describe, expect, it } from "vitest";
import { sessionTitleForDisplay } from "./sessionTitle";

/** U+F084D（Nerd Fonts 的 `md-arrow_decision`）：用户标题前缀里实测用到的那一个。 */
const ICON = "\u{F084D}";
/** U+E0B0（Powerline）——同一段私有区里的另一个码位，用来验证不止一个图标能去。 */
const ICON2 = "\u{E0B0}";

describe("会话标题显示口径", () => {
 it("去掉开头的标题卡前缀（图标 + 大写短码）", () => {
  // 本机 jsonl 实测的形态（omp 18.10.x，`title.icons` 默认 `nf+emoji`）。
  expect(sessionTitleForDisplay("\u{F0718} COMMIT: 提交推送后仍有修改标识")).toBe("提交推送后仍有修改标识");
  expect(sessionTitleForDisplay("\u{F05E8} DEL: 修复删除会话后出现新会话")).toBe("修复删除会话后出现新会话");
  expect(sessionTitleForDisplay("\u{F011C} SCRN: 调整小屏流式输出比例")).toBe("调整小屏流式输出比例");
  expect(sessionTitleForDisplay("\u{F1400} DROP: 下拉框未开权限加载失败")).toBe("下拉框未开权限加载失败");
  expect(sessionTitleForDisplay("\u{F05F4} TITLE: 去除标题前缀")).toBe("去除标题前缀");
  // 旧口径的实测样例：图标 + 短码，两段一起剥。
  expect(sessionTitleForDisplay(`${ICON} HGT: 修复输入框高度过高`)).toBe("修复输入框高度过高");
 });

 it("emoji 图标 + 短码也一并去掉（`emoji` 档的标题卡形态）", () => {
  expect(sessionTitleForDisplay("✅ COMMIT: 修复完成")).toBe("修复完成");
  expect(sessionTitleForDisplay("📝 DEPLOY: 补充发布说明")).toBe("补充发布说明");
 });

 it("图标后没有空白（不成卡）只去图标，裸短码不动", () => {
  expect(sessionTitleForDisplay(`${ICON}HGT: 修复输入框高度过高`)).toBe("HGT: 修复输入框高度过高");
  expect(sessionTitleForDisplay("HGT: 修复输入框高度过高")).toBe("HGT: 修复输入框高度过高");
 });

 it("连着几个图标一并去掉（含变体选择符与全角空格）", () => {
  expect(sessionTitleForDisplay(`${ICON}${ICON2}\uFE0F\u3000修复输入框高度过高`)).toBe("修复输入框高度过高");
 });

 it("中段的图标 / 短码不动（它属于标题内容）", () => {
  expect(sessionTitleForDisplay(`修复输入框高度过高 ${ICON} 收尾`)).toBe(`修复输入框高度过高 ${ICON} 收尾`);
  expect(sessionTitleForDisplay(`HGT: ${ICON} 修复输入框高度过高`)).toBe(`HGT: ${ICON} 修复输入框高度过高`);
  expect(sessionTitleForDisplay(`修复 COMMIT: 收尾`)).toBe(`修复 COMMIT: 收尾`);
 });

 it("整条标题只有前缀时返回原文（不留在空白行）", () => {
  expect(sessionTitleForDisplay(`${ICON} `)).toBe(`${ICON} `);
  expect(sessionTitleForDisplay(`${ICON} COMMIT: `)).toBe(`${ICON} COMMIT: `);
 });

 it("普通标题（中文 / 英文 / emoji）原样返回", () => {
  expect(sessionTitleForDisplay("Fix composer height")).toBe("Fix composer height");
  expect(sessionTitleForDisplay("✅ 修复完成")).toBe("✅ 修复完成");
 });
});
