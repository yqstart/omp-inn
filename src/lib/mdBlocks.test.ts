import { describe, expect, it } from "vitest";
import { openFenceState, splitMarkdownBlocks } from "./mdBlocks";

/**
 * 流式分块器（V38）的核心契约：
 * 1. `blocks.join("") === text`（渲染可拼接）；
 * 2. 冻结边界只出现在「空行段确实终结了前块、且锚行是已换行结尾的完整行」的位置
 *    ——可能被后续文本改写的块不许冻结；
 * 3. 拿不准就少冻结（尾块多留一些），正确性优先于性能。
 */
describe("splitMarkdownBlocks", () => {
 it("空文本原样返回", () => {
  expect(splitMarkdownBlocks("")).toEqual([""]);
 });

 it("空行终结的两个段落：后段起点成为冻结点", () => {
  const t = "第一段\n\n第二段\n";
  expect(splitMarkdownBlocks(t)).toEqual(["第一段\n\n", "第二段\n"]);
 });

 it("尾行未换行（半截行）不能当锚：不冻结", () => {
  expect(splitMarkdownBlocks("a\n\nb")).toEqual(["a\n\nb"]);
  expect(splitMarkdownBlocks("a\n\nb\nc")).toEqual(["a\n\n", "b\nc"]);
 });

 it("结尾只有空行 / 纯空白、没有锚行：不冻结", () => {
  const t = "a\n\n";
  expect(splitMarkdownBlocks(t)).toEqual([t]);
  expect(splitMarkdownBlocks("a\n\n   ")).toEqual(["a\n\n   "]);
 });

 it("多个段落各自成块，join 恒等于原文", () => {
  const t = "a\n\nb\n\nc\n";
  const blocks = splitMarkdownBlocks(t);
  expect(blocks).toEqual(["a\n\n", "b\n\n", "c\n"]);
  expect(blocks.join("")).toBe(t);
 });

 it("松列表（项之间隔空行）：不许切开", () => {
  const t = "- a\n\n- b\n";
  expect(splitMarkdownBlocks(t)).toEqual([t]);
  expect(splitMarkdownBlocks("1. a\n\n2. b\n")).toEqual(["1. a\n\n2. b\n"]);
 });

 it("列表项缩进续行（≥2 空格）：不许切开", () => {
  const t = "- a\n\n  para2\n\n  para3\n";
  expect(splitMarkdownBlocks(t)).toEqual([t]);
 });

 it("列表结束后的普通段落：可以切开", () => {
  expect(splitMarkdownBlocks("- a\n\nplain\n")).toEqual(["- a\n\n", "plain\n"]);
 });

 it("缩进代码块跨空行：不许切开；结束后可切", () => {
  const t = "    a\n\n    b\n";
  expect(splitMarkdownBlocks(t)).toEqual([t]);
  expect(splitMarkdownBlocks("    a\n\nplain\n")).toEqual(["    a\n\n", "plain\n"]);
 });

 it("引用（blockquote）跨空行续 `>`：不许切开；不续则可切", () => {
  const t = "> a\n\n> b\n";
  expect(splitMarkdownBlocks(t)).toEqual([t]);
  expect(splitMarkdownBlocks("> a\n\nplain\n")).toEqual(["> a\n\n", "plain\n"]);
 });

 it("引用里的惰性续行（无 `>`、无空行）：留在尾块", () => {
  const t = "> a\nlazy";
  expect(splitMarkdownBlocks(t)).toEqual([t]);
 });

 it("未闭合围栏：围栏内一律不切（围栏前的空行边界照常冻结）", () => {
  const t = "前文\n\n```\ncode\n\ncode2";
  expect(splitMarkdownBlocks(t)).toEqual(["前文\n\n", "```\ncode\n\ncode2"]);
 });

 it("闭合围栏代码块：整块冻结，后续可再切", () => {
  const t = "前文\n\n```\nc\n```\n\n后文\n";
  expect(splitMarkdownBlocks(t)).toEqual(["前文\n\n", "```\nc\n```\n\n", "后文\n"]);
 });

 it("列表项里的围栏闭合后，列表容器恢复（后续普通段落可切）", () => {
  const t = "- a\n  ```\n  c\n  ```\n\nplain\n";
  expect(splitMarkdownBlocks(t)).toEqual(["- a\n  ```\n  c\n  ```\n\n", "plain\n"]);
 });

 it("表头 + 分隔行 + 数据行作为一个整体冻结（GFM 表格不跨空行）", () => {
  const t = "h | h\n--|--\n1|2\n\nx\n";
  expect(splitMarkdownBlocks(t)).toEqual(["h | h\n--|--\n1|2\n\n", "x\n"]);
 });

 it("setext 标题与正文分属两块时各自完整", () => {
  const t = "标题\n====\n\n正文\n";
  expect(splitMarkdownBlocks(t)).toEqual(["标题\n====\n\n", "正文\n"]);
 });

 it("文内出现链接引用定义 / 脚注定义：整段不冻结", () => {
  expect(splitMarkdownBlocks("a\n\n[b]: http://x\n\nc")).toEqual(["a\n\n[b]: http://x\n\nc"]);
  expect(splitMarkdownBlocks("a\n\n[^1]: 注释\n\nc")).toEqual(["a\n\n[^1]: 注释\n\nc"]);
 });

 it("HR / 标题后的空行边界可冻结", () => {
  expect(splitMarkdownBlocks("a\n\n---\n\nb\n")).toEqual(["a\n\n", "---\n\n", "b\n"]);
  expect(splitMarkdownBlocks("a\n\n# h\n\nb\n")).toEqual(["a\n\n", "# h\n\n", "b\n"]);
 });

 it("CRLF 文本按 `\\r` 参与空行判断", () => {
  const t = "a\r\n\r\nb\r\n";
  expect(splitMarkdownBlocks(t)).toEqual(["a\r\n\r\n", "b\r\n"]);
 });

 it("增量追加过程中，已冻结的块不因后续文本变化", () => {
  const full = "开头一段\n\n```ts\nconst a = 1;\n```\n\n收尾\n";
  expect(splitMarkdownBlocks(full)).toEqual(["开头一段\n\n", "```ts\nconst a = 1;\n```\n\n", "收尾\n"]);
  // 中途状态：围栏未闭合时不许出现把围栏切开的边界
  const mid = "开头一段\n\n```ts\nconst a = 1;\n\n更多";
  expect(splitMarkdownBlocks(mid)).toEqual(["开头一段\n\n", "```ts\nconst a = 1;\n\n更多"]);
 });
});

/**
 * `openFenceState`（V46）：AssistantText 的骨架 / 光标策略用它判断「未闭合围栏」——
 * 此前按「``` 出现次数奇偶」判断，行内代码里的三个反引号会误报骨架。
 */
describe("openFenceState", () => {
 it("普通文本 / 闭合围栏：不在围栏里", () => {
  expect(openFenceState("")).toEqual({ open: false, hasContent: false });
  expect(openFenceState("普通一段话")).toEqual({ open: false, hasContent: false });
  expect(openFenceState("```ts\nconst a = 1;\n```\n")).toEqual({ open: false, hasContent: false });
 });

 it("开栏未闭合：区分「还没有内容」与「内容已开始」", () => {
  // 刚打出开栏行：骨架（空代码块）
  expect(openFenceState("```ts\n")).toEqual({ open: true, hasContent: false });
  expect(openFenceState("```ts")).toEqual({ open: true, hasContent: false });
  // 代码开始落下：光标贴上去
  expect(openFenceState("```ts\nconst a = 1;\n")).toEqual({ open: true, hasContent: true });
  expect(openFenceState("```ts\nconst a = 1")).toEqual({ open: true, hasContent: true });
  // 空白不算内容
  expect(openFenceState("```ts\n\n")).toEqual({ open: true, hasContent: false });
 });

 it("行内三个反引号不是围栏（旧的计数奇偶会误报）", () => {
  expect(openFenceState("用 ``` 包住代码")).toEqual({ open: false, hasContent: false });
  expect(openFenceState("行内 ``` 与闭合的块：\n\n```ts\nx\n```\n")).toEqual({ open: false, hasContent: false });
 });

 it("波浪号围栏同口径；缩进 ≥4 的行不算围栏", () => {
  expect(openFenceState("~~~\ncode")).toEqual({ open: true, hasContent: true });
  expect(openFenceState("~~~\ncode\n~~~\n")).toEqual({ open: false, hasContent: false });
  expect(openFenceState("    ```\n不是围栏")).toEqual({ open: false, hasContent: false });
 });

 it("四反引号围栏按长度配对（短的闭不掉）", () => {
  expect(openFenceState("````\ncode\n```\n")).toEqual({ open: true, hasContent: true });
  expect(openFenceState("````\ncode\n````\n")).toEqual({ open: false, hasContent: false });
 });
});
