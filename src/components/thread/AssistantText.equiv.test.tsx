// @vitest-environment jsdom
/**
 * 分块渲染 ≡ 整体渲染（V38，语义等价性）：
 * 分块器把文本切成「冻结块 + 尾块」，每块各自过一遍 react-markdown——
 * 只要切点选得对，渲染出的元素序列（标签 + 规整化文本）应与整篇一次解析一致。
 * 这是分块器的正确性护栏：切点一旦破坏 Markdown 结构（列表被切开、围栏被截断），
 * 这里的序列就会对不上。
 *
 * 「整体」参照物的构造：给文本追加一行**链接引用定义**（渲染为零节点）——
 * 分块器遇到引用定义会整段不冻结（`mdBlocks.ts` 的保守规则），于是同一套组件、
 * 同一条管线只出一块，等价于整篇解析。
 */
import { describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AssistantText } from "./AssistantText";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const FIXTURE = `## 标题

第一段，包含 **加粗** 与 [链接](https://example.com)。

- 列表项一
- 列表项二

> 引用一行

\`\`\`ts
const a = 1;
\`\`\`

| a | b |
|---|---|
| 1 | 2 |

收尾段落。
`;

/** 追加引用定义：渲染零节点，同时让分块器放弃冻结 → 单块（整体）渲染。 */
const asWhole = (text: string) => `${text}\n[ref]: https://example.com\n`;

async function mount(text: string, complete: boolean): Promise<HTMLDivElement> {
 const container = document.createElement("div");
 document.body.appendChild(container);
 const root = createRoot(container);
 await act(async () => {
  root.render(createElement(AssistantText, { text, complete }));
 });
 return container;
}

/** 元素序列指纹：按文档序取全部元素（跳过 md-body 出纳容器与流式装饰——骨架 / 光标），
 *  比较标签 + 规整化文本。 */
function elementSeq(root: Element): string[] {
 const norm = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim();
 return Array.from(root.querySelectorAll("*"))
  .filter((e) => !e.classList.contains("md-body") && !e.closest('[role="status"], .stream-caret'))
  .map((e) => `${e.tagName}|${norm(e.textContent)}`);
}

describe("分块渲染 ≡ 整体渲染（V38）", () => {
 it("完整消息：逐块渲染与整篇解析结果一致", async () => {
  const chunked = await mount(FIXTURE, true);
  const whole = await mount(asWhole(FIXTURE), true);
  expect(elementSeq(chunked)).toEqual(elementSeq(whole));
 });

 it("流式中途（切在列表中间）：逐块渲染仍与整篇解析一致", async () => {
  // 在「- 列表项二」处截断：分块器不许把列表项切开
  const partial = FIXTURE.slice(0, FIXTURE.indexOf("- 列表项二"));
  const chunked = await mount(partial, false);
  const whole = await mount(asWhole(partial), false);
  expect(elementSeq(chunked)).toEqual(elementSeq(whole));
 });

 it("流式中途（切在围栏代码块中间）：逐块渲染仍与整篇解析一致", async () => {
  const partial = FIXTURE.slice(0, FIXTURE.indexOf("const a = 1;") + "const a = 1;\n".length);
  const chunked = await mount(partial, false);
  // 参照物：先补一行闭合围栏（渲染结果与「未闭合到文末」一致）+ 引用定义 → 单块渲染
  const whole = await mount(`${partial}\`\`\`\n[ref]: https://example.com\n`, false);
  expect(elementSeq(chunked)).toEqual(elementSeq(whole));
 });
});
