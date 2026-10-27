// @vitest-environment jsdom
/**
 * 流式光标落位（V38：测坐标覆盖，不搬 DOM）。
 * 关键契约：节点不许被搬动（搬动 React 管理的 DOM 会在分块插入时崩），
 * 只写 style；没有可贴的文本时隐藏。
 */
import { describe, expect, it } from "vitest";
import { positionStreamCaret } from "./streamCaret";

/** 造一个 host 与光标（光标是 host 的末尾子节点，模拟 React 的渲染位置）。 */
function setup(html: string) {
 const host = document.createElement("div");
 host.innerHTML = html;
 document.body.appendChild(host);
 const caret = document.createElement("span");
 host.appendChild(caret);
 return { host, caret };
}

describe("positionStreamCaret", () => {
 it("跨块取文档序最后的非空白文本节点；光标节点不被搬动", () => {
  const { host, caret } = setup("<p>第一块</p><p>最后一块<span>（尾）</span></p>");
  positionStreamCaret(host, caret);
  // 节点位置原样（仍是 host 的直接末尾子节点）——V37 的 node.after 搬动已废弃
  expect(caret.parentElement).toBe(host);
  expect(host.lastChild).toBe(caret);
  expect(caret.style.display).not.toBe("none");
 });

 it("空内容 / 只有空白文本：光标隐藏", () => {
  const empty = setup("");
  positionStreamCaret(empty.host, empty.caret);
  expect(empty.caret.style.display).toBe("none");
  const blank = setup("<p>   </p>");
  positionStreamCaret(blank.host, blank.caret);
  expect(blank.caret.style.display).toBe("none");
 });

 it("jsdom 下 rect 全 0：不抛错，样式落 0", () => {
  const { host, caret } = setup("<p>abc</p>");
  positionStreamCaret(host, caret);
  expect(caret.style.left).toBe("0px");
  expect(caret.style.top).toBe("0px");
 });

 it("从隐藏恢复：有文本后再次调用会重新显示", () => {
  const { host, caret } = setup("");
  positionStreamCaret(host, caret);
  expect(caret.style.display).toBe("none");
  host.appendChild(document.createTextNode("有字了"));
  positionStreamCaret(host, caret);
  expect(caret.style.display).toBe("");
 });

 it("忽略末尾光标自身与空白：贴住最后一个有字节点", () => {
  const { host, caret } = setup("<p>正文</p>  ");
  positionStreamCaret(host, caret);
  expect(caret.style.display).not.toBe("none");
 });
});
