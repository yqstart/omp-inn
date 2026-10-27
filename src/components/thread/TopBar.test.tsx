// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "@shared/types";
import { useApp } from "../../stores/app";
import { TopBar } from "./TopBar";

/**
 * 聊天 TopBar 的会话名编辑（点名字改名）：
 * - **回显当前显示名**再让用户改（用户口径：「重命名会话时，原来的内容应该先回显到输入框内」）——
 *   没有备注的会话此前开出来是空输入框，得对着上方看到的标题重打一遍；回显走显示口径
 *   （`sessionTitleForDisplay`），omp 标题卡的图标 / 短码不进输入框；
 * - 提交 = Enter 或**点输入框外**，改过才写 omp（V40 起改名 = `set_session_name` 写 jsonl 真名），
 *   原样提交不写；Esc 取消也不写；
 * - 顶栏右端 = 只剩右栏工作台开关（上下文容量环与供应商用量 2026-10-14 搬进输入卡工具行）。
 */

/** `vi.mock` 的工厂会被提升：用 `vi.hoisted` 拿能在用例里改行为的 mock。 */
const mock = vi.hoisted(() => ({
 renameSession: vi.fn(async () => null),
 openSession: vi.fn(async () => {
  throw new Error("本用例不覆盖会话回读");
 }),
}));
vi.mock("@shared/api", () => ({
 api: {
  renameSession: mock.renameSession,
  openSession: mock.openSession,
 },
}));

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const TITLE = "删除内容（src/components/settings/）";

const session = (over: Partial<SessionView> = {}): SessionView => ({
 id: "s1",
 projectId: null,
 title: TITLE,
 cwd: "/w/alpha",
 timestamp: 0,
 archived: false,
 corrupt: false,
 note: null,
 running: false,
 ...over,
});

beforeEach(() => {
 mock.renameSession.mockClear();
 useApp.setState({
  sessions: [],
  activeSessionId: null,
  eventsBySession: {},
  currentRuntime: null,
  providerUsageOpen: false,
  locale: "zh-CN",
 });
 container = document.createElement("div");
 document.body.append(container);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
});

const noteInput = () => container.querySelector<HTMLInputElement>("header input");

function render() {
 act(() => root.render(<TopBar />));
}

function openEditor() {
 act(() => container.querySelector<HTMLButtonElement>('header button[aria-label^="会话标题"]')?.click());
}

/** 往受控 input 里打字：React 接管 value，得走原生 setter + `input` 事件。 */
function type(input: HTMLInputElement, text: string) {
 const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
 act(() => {
  setter?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
 });
}

function pressKey(el: HTMLElement, key: string) {
 act(() => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
 });
}

/** 点输入框外（标题栏空白处）：提交入口是 document 上的 pointerdown，不是不可靠的 blur。 */
function clickOutside() {
 act(() => {
  container.querySelector("header")?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
 });
}

describe("聊天 TopBar 会话名编辑", () => {
 it("没有备注时回显 omp 原标题，而不是空输入框", () => {
  useApp.setState({ sessions: [session()], activeSessionId: "s1" });
  render();
  openEditor();
  expect(noteInput()?.value).toBe(TITLE);
 });

 it("有备注时回显备注（备注优先与后端 display_title 同口径）", () => {
  useApp.setState({ sessions: [session({ note: "设置提示改动" })], activeSessionId: "s1" });
  render();
  openEditor();
  expect(noteInput()?.value).toBe("设置提示改动");
 });

 it("回显显示名：omp 标题卡的图标 / 短码不进输入框", () => {
  useApp.setState({ sessions: [session({ title: "\u{F0718} LIST: 待办列表展示位置设计" })], activeSessionId: "s1" });
  render();
  openEditor();
  expect(noteInput()?.value).toBe("待办列表展示位置设计");
 });

 it("原样回车 = 没改名：不写 omp，只关闭输入框", async () => {
  useApp.setState({ sessions: [session()], activeSessionId: "s1" });
  render();
  openEditor();
  pressKey(noteInput()!, "Enter");
  await act(async () => { });
  expect(mock.renameSession).not.toHaveBeenCalled();
  expect(noteInput()).toBeNull();
 });

 it("改过再回车：以新文本写 omp 真名（set_session_name）", async () => {
  useApp.setState({ sessions: [session()], activeSessionId: "s1" });
  render();
  openEditor();
  const input = noteInput()!;
  type(input, "设置提示语改动");
  pressKey(input, "Enter");
  await act(async () => { });
  expect(mock.renameSession).toHaveBeenCalledWith("s1", "设置提示语改动");
  expect(noteInput()).toBeNull();
 });

 it("点输入框外 = 提交改名：不按 Enter 也写 omp", async () => {
  useApp.setState({ sessions: [session()], activeSessionId: "s1" });
  render();
  openEditor();
  type(noteInput()!, "设置提示语改动");
  clickOutside();
  await act(async () => { });
  expect(mock.renameSession).toHaveBeenCalledWith("s1", "设置提示语改动");
  expect(noteInput()).toBeNull();
 });

 it("点输入框外但没改过：只关输入框，不写 omp", async () => {
  useApp.setState({ sessions: [session()], activeSessionId: "s1" });
  render();
  openEditor();
  clickOutside();
  await act(async () => { });
  expect(mock.renameSession).not.toHaveBeenCalled();
  expect(noteInput()).toBeNull();
 });

 it("同一次点击里 pointerdown 提交后 blur 补发不再写第二刀", async () => {
  useApp.setState({ sessions: [session()], activeSessionId: "s1" });
  render();
  openEditor();
  const input = noteInput()!;
  type(input, "设置提示语改动");
  act(() => {
   container.querySelector("header")?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
   input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  await act(async () => { });
  expect(mock.renameSession).toHaveBeenCalledTimes(1);
 });

 it("Esc 取消：改过也不写 omp", async () => {
  useApp.setState({ sessions: [session()], activeSessionId: "s1" });
  render();
  openEditor();
  const input = noteInput()!;
  type(input, "别保存");
  pressKey(input, "Escape");
  await act(async () => { });
  expect(mock.renameSession).not.toHaveBeenCalled();
  expect(noteInput()).toBeNull();
 });

 it("顶栏右端只剩右栏工作台开关：上下文容量环与供应商用量都在输入卡工具行", () => {
  useApp.setState({ workbenchOpen: false });
  render();
  // 2026-10-14 起右上角不再有这两个入口（搬进 Composer 工具行，见 Composer.test.tsx）
  expect(container.querySelector('header button[aria-label="供应商用量"]')).toBeNull();
  expect(container.querySelector('header button[aria-label^="上下文容量"]')).toBeNull();
  const panel = container.querySelector<HTMLButtonElement>('header button[aria-label^="右栏工作台"]');
  expect(panel).not.toBeNull();
  act(() => panel?.click());
  expect(useApp.getState().workbenchOpen).toBe(true);
 });

 it("整条标题栏是窗口拖拽区，禁用态按钮不挡拖拽", () => {
  render();
  // ① 裸属性只认「直接命中 header 的 mousedown」；内容全在两层 flex 容器里，等于整条拖不动
  expect(container.querySelector("header")?.getAttribute("data-tauri-drag-region")).toBe("deep");
  // ② 交互件不带属性：Tauri 拖拽脚本按 clickable 元素短路，点击语义（改名 / 导出 / 开关）保住
  expect([...container.querySelectorAll("header button")].every((b) => !b.hasAttribute("data-tauri-drag-region"))).toBe(true);
  // ③ 空态标题 / 导出是 disabled 按钮：收不到 mousedown 还会挡住 `deep`，必须让出这一片
  const disabled = [...container.querySelectorAll<HTMLButtonElement>("header button:disabled")];
  expect(disabled.length).toBe(2);
  expect(disabled.every((b) => b.className.includes("disabled:pointer-events-none"))).toBe(true);
 });
});
