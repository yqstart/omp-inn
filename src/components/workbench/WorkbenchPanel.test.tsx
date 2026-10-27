// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "@shared/types";
import { useApp } from "../../stores/app";
import { TEXT } from "../../lib/locale";

/**
 * 右栏工作台外壳（V42 / V51）：四个页签、停靠显隐、终端目录保留表。
 * 页签内容各自有测试（`FileTree.test.tsx` / `GitGraphPanel.test.tsx`；`TerminalPane` 依赖真实
 * xterm，这里整块替换）。
 */
vi.mock("./TerminalPane", () => ({
 TerminalPane: ({ id, cwd }: { id: string; cwd: string }) => (
  <div data-testid="term" data-id={id}>
   {cwd}
  </div>
 ),
}));
vi.mock("./FileTree", () => ({
 FileTree: ({ root }: { root: string }) => <div data-testid="files">{root}</div>,
}));
vi.mock("./ScriptsPanel", () => ({
 ScriptsPanel: ({ cwd, visible }: { cwd: string; visible: boolean }) => (
  <div data-testid="scripts" data-visible={String(visible)}>
   {cwd}
  </div>
 ),
}));
vi.mock("./GitGraphPanel", () => ({
 GitGraphPanel: ({ cwd, visible }: { cwd: string; visible: boolean }) => (
  <div data-testid="graph" data-visible={String(visible)}>
   {cwd}
  </div>
 ),
}));

import { WorkbenchPanel } from "./WorkbenchPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const zh = TEXT["zh-CN"];

const session = (over: Partial<SessionView> = {}): SessionView => ({
 id: "s1",
 projectId: null,
 title: "会话",
 cwd: "/w/alpha",
 timestamp: 0,
 archived: false,
 corrupt: false,
 note: null,
 running: false,
 ...over,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
 useApp.setState({
  locale: "zh-CN",
  sessions: [session()],
  activeSessionId: "s1",
  projects: [],
  workbenchOpen: true,
  workbenchTab: "files",
  workbenchWidth: 300,
  terminals: [],
  activeTerminalId: null,
  terminalSeq: 0,
  settingsTabActive: false,
 });
 container = document.createElement("div");
 document.body.append(container);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
 localStorage.removeItem("omp.workbenchTab.v1");
});

function render() {
 act(() => {
  root.render(<WorkbenchPanel />);
 });
}

/** 按文案找一个按钮（页签 / 关闭键）。 */
function buttonByText(text: string): HTMLButtonElement | null {
 return (
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text) ?? null
 );
}

describe("WorkbenchPanel", () => {
 it("默认页签是文件：以当前会话 cwd 为根渲染目录树", () => {
  render();
  expect(container.querySelector('[data-testid="files"]')?.textContent).toBe("/w/alpha");
  expect(container.querySelector('[data-testid="term"]')).toBeNull();
 });

 it("页签顺序：文件 → Git 图谱 → 脚本 → 终端", () => {
  render();
  const tabs = [...container.querySelectorAll("header button")]
   .filter((b) => b.getAttribute("aria-pressed") !== null)
   .map((b) => b.textContent?.trim());
  expect(tabs).toEqual([zh.workbenchFiles, zh.workbenchGraph, zh.workbenchScripts, zh.workbenchTerminal]);
 });

 it("切到 Git 图谱页签：常驻挂载，只有显示时 visible=true", () => {
  render();
  act(() => buttonByText(zh.workbenchGraph)?.click());
  expect(useApp.getState().workbenchTab).toBe("graph");
  const graph = container.querySelector('[data-testid="graph"]');
  expect(graph?.textContent).toBe("/w/alpha");
  expect(graph?.getAttribute("data-visible")).toBe("true");
  // 切走仍挂载（提交筛选 / 详情状态不丢），只是 visible=false 不再拉数据
  act(() => buttonByText(zh.workbenchFiles)?.click());
  expect(graph?.getAttribute("data-visible")).toBe("false");
 });

 it("Git 图谱在 localStorage 里保留（重开仍是图谱页签）", () => {
  act(() => useApp.getState().setWorkbenchTab("graph"));
  expect(localStorage.getItem("omp.workbenchTab.v1")).toBe("graph");
 });

 it("切到终端页签：按会话目录建一个终端并渲染它", () => {
  render();
  act(() => buttonByText(zh.workbenchTerminal)?.click());
  expect(useApp.getState().workbenchTab).toBe("terminal");
  const term = container.querySelector('[data-testid="term"]');
  expect(term?.textContent).toBe("/w/alpha");
  const state = useApp.getState();
  // 标签标题取目录名；id 由 store 生成（后端进程表按它寻址）
  expect(state.terminals).toHaveLength(1);
  expect(state.terminals[0]).toMatchObject({ cwd: "/w/alpha", title: "alpha" });
  expect(state.activeTerminalId).toBe(state.terminals[0].id);
  expect(term?.getAttribute("data-id")).toBe(state.terminals[0].id);
 });

 it("多开：新建 / 切换 / 关闭都在标签行上（终端常驻挂载）", () => {
  render();
  act(() => buttonByText(zh.workbenchTerminal)?.click());
  // 新建第二个（+ 键）
  act(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${zh.terminalNew}"]`)?.click());
  let state = useApp.getState();
  expect(state.terminals).toHaveLength(2);
  expect(state.activeTerminalId).toBe(state.terminals[1].id);
  expect(container.querySelectorAll('[data-testid="term"]')).toHaveLength(2);
  // 点第一个标签切回去
  act(() => buttonByText(state.terminals[0].title)?.click());
  state = useApp.getState();
  expect(state.activeTerminalId).toBe(state.terminals[0].id);
  // 关掉当前的：切到列表末尾那个，另一个仍在
  act(() =>
   container.querySelectorAll<HTMLButtonElement>(`button[aria-label="${zh.terminalClose}"]`)[0]?.click(),
  );
  state = useApp.getState();
  expect(state.terminals).toHaveLength(1);
  expect(state.activeTerminalId).toBe(state.terminals[0].id);
 });

 it("切到脚本页签：渲染脚本面板并以当前 cwd 为范围（可见才扫描）", () => {
  render();
  expect(container.querySelector('[data-testid="scripts"]')?.getAttribute("data-visible")).toBe("false");
  act(() => buttonByText(zh.workbenchScripts)?.click());
  expect(useApp.getState().workbenchTab).toBe("scripts");
  const panel = container.querySelector('[data-testid="scripts"]');
  expect(panel?.textContent).toBe("/w/alpha");
  expect(panel?.getAttribute("data-visible")).toBe("true");
 });

 it("收起时整栏隐藏但仍挂载（终端进程与树的位置不丢）", () => {
  render();
  act(() => buttonByText(zh.workbenchTerminal)?.click());
  act(() => useApp.getState().setWorkbenchOpen(false));
  const aside = container.querySelector("aside");
  expect(aside?.className).toContain("hidden");
  expect(container.querySelector('[data-testid="term"]')).not.toBeNull();
 });

 it("没有会话时两个页签都给空态文案，不起终端", () => {
  useApp.setState({ sessions: [], activeSessionId: null, workbenchTab: "terminal" });
  render();
  expect(container.textContent).toContain(zh.workbenchNoSession);
  expect(container.querySelector('[data-testid="term"]')).toBeNull();
  expect(useApp.getState().terminals).toEqual([]);
 });

 it("关闭键收起整栏", () => {
  render();
  act(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${zh.workbenchCloseAria}"]`)?.click());
  expect(useApp.getState().workbenchOpen).toBe(false);
 });
});

describe("WorkbenchPanel 宽度", () => {
 /** jsdom 不做布局：给右缘一个真实坐标，「指针到右缘的距离」才算得出来。 */
 function stubRect(aside: HTMLElement, right: number) {
  aside.getBoundingClientRect = () =>
   ({ right, left: right - 300, top: 0, bottom: 600, width: 300, height: 600, x: right - 300, y: 0, toJSON: () => ({}) }) as DOMRect;
 }

 it("宽度来自 store，手柄带完整 aria 读数", () => {
  render();
  const aside = container.querySelector<HTMLElement>("aside");
  expect(aside?.style.width).toBe("300px");
  const handle = container.querySelector<HTMLElement>('[role="separator"]');
  expect(handle).not.toBeNull();
  expect(handle?.getAttribute("aria-valuenow")).toBe("300");
  expect(handle?.getAttribute("aria-valuemin")).toBe("260");
  expect(handle?.getAttribute("aria-label")).toBe(zh.workbenchResizeAria);
 });

 it("手柄聚焦后 ← 变宽、→ 变窄（每次 8px）", () => {
  render();
  const handle = container.querySelector<HTMLElement>('[role="separator"]')!;
  act(() => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
  expect(useApp.getState().workbenchWidth).toBe(308);
  act(() => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(useApp.getState().workbenchWidth).toBe(300);
 });

 it("拖动左缘：宽度 = 指针到右栏右缘的距离（不看主区外边距）", () => {
  render();
  const aside = container.querySelector<HTMLElement>("aside")!;
  stubRect(aside, 1000);
  const handle = container.querySelector<HTMLElement>('[role="separator"]')!;
  act(() => {
   handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
   window.dispatchEvent(new MouseEvent("pointermove", { clientX: 720 }));
  });
  expect(useApp.getState().workbenchWidth).toBe(280);
  act(() => window.dispatchEvent(new MouseEvent("pointerup")));
  // 松手后再动指针不再改宽度
  act(() => window.dispatchEvent(new MouseEvent("pointermove", { clientX: 500 })));
  expect(useApp.getState().workbenchWidth).toBe(280);
 });

 it("窗口约束：向左扩不过「给中列留 420px」的线", () => {
  // jsdom 视口 1024 - 左栏 292 - 中列 420 = 312 是当前上限
  render();
  const handle = container.querySelector<HTMLElement>('[role="separator"]')!;
  act(() => useApp.getState().setWorkbenchWidth(312));
  act(() => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
  expect(useApp.getState().workbenchWidth).toBe(312);
 });
});
