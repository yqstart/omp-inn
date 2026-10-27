// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewMsg } from "@shared/types";
import { useApp } from "../../stores/app";
import { fmt, TEXT } from "../../lib/locale";
import { isMacKeyboard } from "../../lib/platform";
import { FindBar } from "./FindBar";

/**
 * 会话内查找（⌘F）横条：计数、环形的上/下一个、Esc 关闭与高亮清理、
 * 以及**没有 CSS Custom Highlight API 时静默退化**（jsdom 与旧 WebView 的真实处境）。
 *
 * 消息 DOM（`[data-msg-id]`）由测试自己铺进 document——真实场景由 Thread 标注，
 * 这里只验证 FindBar 侧的定位与滚动。
 */

const t = TEXT["zh-CN"];

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const MSGS: ViewMsg[] = [
 { kind: "user", id: "m1", text: "hello world", mentions: [] },
 { kind: "text", id: "m2", seq: 1, text: "HelLO again", complete: true },
 {
  kind: "tool",
  id: "m3",
  toolCallId: "tc1",
  name: "bash",
  intent: "",
  argsSummary: "",
  state: "ok",
  output: "world output",
  streamIndex: 0,
 },
 { kind: "thinking", id: "m4", text: "中文思考", seconds: 2, complete: true },
];

/** 补 jsdom 缺的 `scrollIntoView`（真 WebView 才有）。 */
type ScrollIntoViewHost = { scrollIntoView: (options?: unknown) => void };

/** 假的高亮注册表（真 API 在 jsdom 里不存在）。 */
class FakeHighlight {
 readonly ranges: Range[];
 constructor(...ranges: Range[]) {
  this.ranges = ranges;
 }
}

/** 假的注册表：`Record` 存名字 → 高亮对象（名字只有固定的两条）。 */
function fakeRegistry() {
 const entries: Record<string, FakeHighlight> = {};
 return {
  entries,
  api: {
   set: (name: string, value: unknown) => {
    entries[name] = value as FakeHighlight;
   },
   delete: (name: string) => {
    delete entries[name];
   },
  },
 };
}

let container: HTMLDivElement;
let dom: HTMLDivElement;
let root: Root;
let errors: unknown[];
const scrolled: Element[] = [];

const domOf = (id: string): Element | null => dom.querySelector(`[data-msg-id="${id}"]`);
const input = (): HTMLInputElement => container.querySelector<HTMLInputElement>("input")!;
const count = (): string => container.querySelector('[data-testid="find-count"]')?.textContent ?? "";
const button = (label: string): HTMLButtonElement =>
 container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

function render() {
 root = createRoot(container, { onUncaughtError: (e) => errors.push(e) });
 act(() => root.render(<FindBar />));
}

/** 输入框打字（走原生 setter + input 事件，与真实输入同路径）。 */
function type(value: string) {
 const el = input();
 const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
 act(() => {
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
 });
}

function press(init: KeyboardEventInit) {
 const el = input();
 act(() => {
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
 });
}

beforeEach(() => {
 errors = [];
 scrolled.length = 0;
 const proto = Element.prototype as unknown as ScrollIntoViewHost; // jsdom 没实现 scrollIntoView，测试自补
 proto.scrollIntoView = function(this: Element) {
  scrolled.push(this);
 };
 container = document.createElement("div");
 document.body.append(container);
 dom = document.createElement("div");
 dom.innerHTML =
  '<div data-msg-id="m1">hello world</div>' +
  '<div data-msg-id="m2">HelLO again</div>' +
  '<div data-msg-id="m3">world output</div>';
 document.body.append(dom);
 useApp.setState({
  findOpen: true,
  activeSessionId: "s1",
  eventsBySession: { s1: MSGS },
  locale: "zh-CN",
 });
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
 dom.remove();
 vi.unstubAllGlobals();
 useApp.setState({ findOpen: false, activeSessionId: null, eventsBySession: {} });
});

describe("FindBar 会话内查找", () => {
 it("打开时渲染输入框；输入命中显示 序号/总数，无命中显示「无匹配」，且忽略大小写", () => {
  render();
  expect(input().placeholder).toBe(t.findPlaceholder);
  expect(count()).toBe("");
  expect(button(t.findNextAria).disabled).toBe(true);
  expect(button(t.findPrevAria).disabled).toBe(true);

  type("world");
  expect(count()).toBe(fmt(t.findCount, 1, 2));
  expect(button(t.findNextAria).disabled).toBe(false);
  // 命中消息依次是 m1 / m3；打开即定位到第一项
  expect(scrolled.at(-1)).toBe(domOf("m1"));

  // 大小写不敏感：HeLLo 命中 m1 与 m2（m2 正文里是 HelLO）
  type("HeLLo");
  expect(count()).toBe(fmt(t.findCount, 1, 2));

  type("zzz");
  expect(count()).toBe(t.findNoMatch);
  expect(button(t.findNextAria).disabled).toBe(true);
  expect(errors).toHaveLength(0);
 });

 it("下一个 / 上一个环形遍历：尾部回到头部、头部回到尾部；Enter 与 ⇧Enter 同效", () => {
  render();
  type("world");
  expect(count()).toBe(fmt(t.findCount, 1, 2));

  act(() => button(t.findNextAria).click());
  expect(count()).toBe(fmt(t.findCount, 2, 2));
  expect(scrolled.at(-1)).toBe(domOf("m3"));

  // 从尾回头
  act(() => button(t.findNextAria).click());
  expect(count()).toBe(fmt(t.findCount, 1, 2));
  expect(scrolled.at(-1)).toBe(domOf("m1"));

  // 从头到尾
  act(() => button(t.findPrevAria).click());
  expect(count()).toBe(fmt(t.findCount, 2, 2));

  press({ key: "Enter" });
  expect(count()).toBe(fmt(t.findCount, 1, 2));
  press({ key: "Enter", shiftKey: true });
  expect(count()).toBe(fmt(t.findCount, 2, 2));
  expect(scrolled.at(-1)).toBe(domOf("m3"));
 });

 it("DOM 里找不到的命中项跳过：消息被分页裁掉时不空转，直接落到下一个能定位的命中", () => {
  act(() =>
   useApp.setState({
    eventsBySession: { s1: [...MSGS, { kind: "text", id: "m5", seq: 2, text: "world again", complete: true }] },
   }),
  );
  // 这一条也在 DOM 里（m3 稍后才被移除）
  const m5 = document.createElement("div");
  m5.setAttribute("data-msg-id", "m5");
  m5.textContent = "world again";
  dom.append(m5);
  render();
  type("world"); // 命中 m1 / m3 / m5
  expect(count()).toBe(fmt(t.findCount, 1, 3));
  domOf("m3")!.remove(); // 模拟「这条消息没渲染出来」
  act(() => button(t.findNextAria).click());
  expect(count()).toBe(fmt(t.findCount, 3, 3));
  expect(scrolled.at(-1)).toBe(domOf("m5"));
  expect(errors).toHaveLength(0);
 });

 it("⌘G / ⇧⌘G 也能走下一个 / 上一个（不依赖焦点在输入框）", () => {
  render();
  type("world");
  // 平台修饰键与 App 的其它快捷键用例同口径（mac 用 ⌘、其余用 Ctrl）
  const mod = isMacKeyboard() ? { metaKey: true } : { ctrlKey: true };
  const key = (shift: boolean) =>
   act(() => {
    window.dispatchEvent(
     new KeyboardEvent("keydown", { key: "g", shiftKey: shift, bubbles: true, cancelable: true, ...mod }),
    );
   });
  key(false);
  expect(count()).toBe(fmt(t.findCount, 2, 2));
  key(true);
  expect(count()).toBe(fmt(t.findCount, 1, 2));
 });

 it("Esc 关闭：findOpen 落回 false、横条消失、高亮清空、查询复位", () => {
  const reg = fakeRegistry();
  vi.stubGlobal("Highlight", FakeHighlight);
  vi.stubGlobal("CSS", { highlights: reg.api });
  render();
  type("world");
  expect(reg.entries["omp-find"]).toBeDefined();
  expect(reg.entries["omp-find-active"]).toBeDefined();

  press({ key: "Escape" });
  expect(useApp.getState().findOpen).toBe(false);
  expect(container.querySelector("input")).toBeNull();
  expect(reg.entries["omp-find"]).toBeUndefined();
  expect(reg.entries["omp-find-active"]).toBeUndefined();

  // 重新打开：查询已清空（不残留上一次的查找词）
  act(() => useApp.setState({ findOpen: true }));
  expect(input().value).toBe("");
  expect(errors).toHaveLength(0);
 });

 it("有高亮 API 时：全部命中进 omp-find，当前命中另进 omp-find-active", () => {
  const reg = fakeRegistry();
  vi.stubGlobal("Highlight", FakeHighlight);
  vi.stubGlobal("CSS", { highlights: reg.api });
  render();
  type("world");
  // m1 一次、m3 一次
  expect(reg.entries["omp-find"]?.ranges).toHaveLength(2);
  expect(reg.entries["omp-find-active"]?.ranges).toHaveLength(1);
  act(() => button(t.findNextAria).click());
  // 当前项换成 m3，仍是各 1 条
  expect(reg.entries["omp-find"]?.ranges).toHaveLength(2);
  expect(reg.entries["omp-find-active"]?.ranges).toHaveLength(1);
  expect(errors).toHaveLength(0);
 });

 it("没有 CSS Custom Highlight API（jsdom / 旧 WebView）时静默退化：不抛错，计数与滚动照常", () => {
  // jsdom 本来就没有 Highlight / CSS.highlights；这里显式再确认一遍（CSS 存在但没有 highlights）
  vi.stubGlobal("CSS", { escape: (s: string) => s });
  render();
  type("world");
  expect(count()).toBe(fmt(t.findCount, 1, 2));
  act(() => button(t.findNextAria).click());
  expect(count()).toBe(fmt(t.findCount, 2, 2));
  expect(scrolled.at(-1)).toBe(domOf("m3"));
  press({ key: "Escape" });
  expect(useApp.getState().findOpen).toBe(false);
  expect(errors).toHaveLength(0);
 });

 it("切会话重置查询与命中（不串上个会话的查找词）", () => {
  render();
  type("world");
  expect(count()).toBe(fmt(t.findCount, 1, 2));
  act(() =>
   useApp.setState({
    activeSessionId: "s2",
    eventsBySession: { s1: MSGS, s2: [{ kind: "user", id: "x1", text: "另一个会话", mentions: [] }] },
   }),
  );
  expect(input().value).toBe("");
  expect(count()).toBe("");
  expect(errors).toHaveLength(0);
 });
});
