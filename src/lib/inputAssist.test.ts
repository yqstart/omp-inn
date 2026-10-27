// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installInputAssistOff } from "./inputAssist";

const ATTRS: ReadonlyArray<readonly [string, string]> = [
 ["spellcheck", "false"],
 ["autocorrect", "off"],
 ["autocapitalize", "off"],
 ["autocomplete", "off"],
];

function decorated(el: Element): boolean {
 return ATTRS.every(([k, v]) => el.getAttribute(k) === v);
}

/** MutationObserver 的派发走微任务：让出微任务直到条件成立（不用真实计时器）。 */
async function until(cond: () => boolean): Promise<void> {
 for (let i = 0; i < 20 && !cond(); i++) await Promise.resolve();
}

function expectDecorated(el: Element | null, label: string): void {
 expect(el, label).toBeTruthy();
 for (const [k, v] of ATTRS) expect(el!.getAttribute(k), `${label} 的 ${k}`).toBe(v);
}

let cleanup: (() => void) | null = null;

beforeEach(() => {
 document.body.innerHTML = "";
});
afterEach(() => {
 cleanup?.();
 cleanup = null;
});

describe("installInputAssistOff", () => {
 it("装饰既有输入框（input / textarea / contenteditable），不碰其它元素", () => {
  document.body.innerHTML = `
   <div id="box"><input id="a" /><section><textarea id="b"></textarea></section></div>
   <div id="edit" contenteditable="true"></div>
   <button id="btn">x</button>`;
  cleanup = installInputAssistOff();
  expectDecorated(document.getElementById("a"), "input");
  expectDecorated(document.getElementById("b"), "textarea");
  expectDecorated(document.getElementById("edit"), "contenteditable");
  expect(document.getElementById("btn")!.getAttribute("spellcheck")).toBeNull();
  expect(document.getElementById("box")!.getAttribute("autocomplete")).toBeNull();
 });

 it("装饰之后插入的元素（MutationObserver）", async () => {
  cleanup = installInputAssistOff();
  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  await until(() => decorated(ta));
  expectDecorated(ta, "后插入的 textarea");
 });

 it("属性被外部清掉 / 改回后自动补回", async () => {
  cleanup = installInputAssistOff();
  const input = document.createElement("input");
  document.body.appendChild(input);
  await until(() => decorated(input));
  input.setAttribute("spellcheck", "true");
  input.setAttribute("autocorrect", "on");
  await until(() => decorated(input));
  expectDecorated(input, "被改回的 input");
 });

 it("卸载后不再装饰新元素", async () => {
  const off = installInputAssistOff();
  off();
  const input = document.createElement("input");
  document.body.appendChild(input);
  await until(() => false);
  expect(input.getAttribute("spellcheck")).toBeNull();
 });
});
