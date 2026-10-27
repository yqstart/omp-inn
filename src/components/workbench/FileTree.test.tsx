// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeFile, ChangeSet, DirEntry, DirListing } from "@shared/types";
import { useApp } from "../../stores/app";
import { TEXT } from "../../lib/locale";

/**
 * 右栏文件树（V42 / V43+）：懒加载一层目录、Material 类型图标、快速过滤（文件与文件夹）、
 * 变更标色、点文件交给系统打开、行尾「引用到输入框」（**相对路径**）。
 * 后端与系统打开都替换成 mock——本用例只验证前端的取数口径与交互。
 */
const { apiMock, openerMock } = vi.hoisted(() => ({
 apiMock: {
  listDir: vi.fn(),
  getChangeSet: vi.fn(),
  searchPaths: vi.fn(),
  // 短标签：默认给尾段（真实实现是「最短唯一后缀」，这里只验前端拿它写草稿）
  mentionLabel: vi.fn(async (_base: string, path: string) => path.split("/").pop() ?? path),
 },
 openerMock: { openPath: vi.fn(async () => {}), revealItemInDir: vi.fn(async () => {}) },
}));
vi.mock("@shared/api", () => ({ api: apiMock }));
vi.mock("@tauri-apps/plugin-opener", () => ({ ...openerMock, openUrl: vi.fn(async () => {}) }));

import { FileTree } from "./FileTree";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const zh = TEXT["zh-CN"];
const ROOT = "/w/alpha";
/** 过滤防抖 180ms：推进得多一点，避免边界抖动。 */
const DEBOUNCE = 200;

const entry = (name: string, isDir: boolean): DirEntry => ({
 name,
 path: `${ROOT}/${name}`,
 isDir,
 isSymlink: false,
 size: isDir ? null : 12,
});

/** 指定目录下的条目（深层目录要用它，`entry` 只拼根）。 */
const entryAt = (dir: string, name: string, isDir: boolean): DirEntry => ({
 name,
 path: `${dir}/${name}`,
 isDir,
 isSymlink: false,
 size: isDir ? null : 12,
});

const listing = (path: string, entries: DirEntry[], repoRoot: string | null = ROOT): DirListing => ({
 path,
 parent: null,
 entries,
 truncated: false,
 repoRoot,
});

const changeSet = (files: Partial<ChangeFile>[]): ChangeSet => ({
 isRepo: true,
 branch: "main",
 head: null,
 upstream: null,
 upstreamGone: false,
 ahead: 0,
 behind: 0,
 files: files.map((f) => ({
  path: "a.ts",
  origPath: null,
  index: " ",
  worktree: "M",
  untracked: false,
  add: 1,
  del: 0,
  ...f,
 })),
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
 vi.clearAllMocks();
 // jsdom 没实现 scrollIntoView（定位到某一行后要滚过去），给个空实现即可
 if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
 }
 useApp.setState({
  locale: "zh-CN",
  activeSessionId: "s1",
  drafts: {},
  composerFocusSeq: 0,
 });
 container = document.createElement("div");
 document.body.append(container);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
});

async function render() {
 await act(async () => {
  root.render(<FileTree root={ROOT} />);
 });
}

/** 行按钮的文字里带图标与徽标，按「包含名字」找。 */
function rowByName(name: string): HTMLElement | null {
 return [...container.querySelectorAll<HTMLElement>("div.group")].find((d) => d.textContent?.includes(name)) ?? null;
}

/** 受控 input 的赋值：React 19 认的是原生 value setter + input 事件。 */
function typeInto(input: HTMLInputElement, value: string) {
 const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
 setter?.call(input, value);
 input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("FileTree", () => {
 it("树根加载：列目录、按仓库根给改动文件打徽标", async () => {
  apiMock.listDir.mockResolvedValue(listing(ROOT, [entry("src", true), entry("a.ts", false)]));
  apiMock.getChangeSet.mockResolvedValue(changeSet([{ path: "a.ts", worktree: "M" }]));
  await render();
  expect(apiMock.listDir).toHaveBeenCalledWith(ROOT, true);
  expect(container.textContent).toContain("src");
  expect(rowByName("a.ts")?.textContent).toContain("M");
  // 没有改动的目录不带徽标
  expect(rowByName("src")?.textContent).not.toContain("M");
 });

 it("行图标是 Material Icon（生成表里的 SVG，按扩展名取）", async () => {
  apiMock.listDir.mockResolvedValue(listing(ROOT, [entry("src", true), entry("a.ts", false)]));
  apiMock.getChangeSet.mockResolvedValue(changeSet([]));
  await render();
  const srcIcon = rowByName("src")?.querySelector("img")?.getAttribute("src") ?? "";
  const tsIcon = rowByName("a.ts")?.querySelector("img")?.getAttribute("src") ?? "";
  expect(srcIcon.startsWith("data:image/svg+xml")).toBe(true);
  expect(tsIcon.startsWith("data:image/svg+xml")).toBe(true);
  // 目录与文件、不同扩展名不是同一张图
  expect(srcIcon).not.toBe(tsIcon);
 });

 it("展开目录才取它的内容（懒加载，第二次调用不再带仓库根）", async () => {
  apiMock.listDir.mockImplementation(async (path: string) =>
   path === ROOT ? listing(ROOT, [entry("src", true)]) : listing(path, [entry("index.ts", false)]),
  );
  apiMock.getChangeSet.mockResolvedValue(changeSet([]));
  await render();
  expect(container.textContent).not.toContain("index.ts");
  act(() => rowByName("src")?.querySelector("button")?.click());
  await act(async () => {});
  expect(apiMock.listDir).toHaveBeenCalledWith(`${ROOT}/src`, false);
  expect(container.textContent).toContain("index.ts");
 });

 it("点文件交给系统默认程序打开", async () => {
  apiMock.listDir.mockResolvedValue(listing(ROOT, [entry("a.ts", false)]));
  apiMock.getChangeSet.mockResolvedValue(changeSet([]));
  await render();
  await act(async () => {
   rowByName("a.ts")?.querySelector("button")?.click();
  });
  expect(openerMock.openPath).toHaveBeenCalledWith(`${ROOT}/a.ts`);
 });

 it("行尾「引用到输入框」写进草稿的是**短标签**（不是整条路径）", async () => {
  apiMock.listDir.mockResolvedValue(listing(ROOT, [entry("a.ts", false), entry("src", true)]));
  apiMock.getChangeSet.mockResolvedValue(changeSet([]));
  await render();
  const btn = rowByName("a.ts")?.querySelector<HTMLButtonElement>(`button[aria-label="${zh.filesInsertRef}"]`);
  expect(btn).toBeTruthy();
  await act(async () => {
   btn?.click();
   for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
  expect(apiMock.mentionLabel).toHaveBeenCalledWith(ROOT, `${ROOT}/a.ts`);
  // 引用走「待插入芯片」通道（草稿编辑器非受控，插入由 Composer 消费）
  expect(useApp.getState().pendingReference).toMatchObject({
   sessionId: "s1",
   path: "a.ts",
   label: "a.ts",
   isDir: false,
  });
 });

 it("目录引用补尾斜杠（短标签 + `/`）", async () => {
  apiMock.listDir.mockResolvedValue(listing(ROOT, [entry("src", true)]));
  apiMock.getChangeSet.mockResolvedValue(changeSet([]));
  await render();
  const btn = rowByName("src")?.querySelector<HTMLButtonElement>(`button[aria-label="${zh.filesInsertRef}"]`);
  await act(async () => {
   btn?.click();
   for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
  expect(useApp.getState().pendingReference).toMatchObject({
   sessionId: "s1",
   path: "src",
   label: "src",
   isDir: true,
  });
 });

 it("拿不到标签（后端失败）时回退相对路径，照旧能引用", async () => {
  apiMock.listDir.mockResolvedValue(listing(ROOT, [entry("a.ts", false)]));
  apiMock.getChangeSet.mockResolvedValue(changeSet([]));
  apiMock.mentionLabel.mockRejectedValueOnce(new Error("boom"));
  await render();
  const btn = rowByName("a.ts")?.querySelector<HTMLButtonElement>(`button[aria-label="${zh.filesInsertRef}"]`);
  await act(async () => {
   btn?.click();
   for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
  expect(useApp.getState().pendingReference).toMatchObject({ path: "a.ts", label: "a.ts" });
 });

 it("目录读不到时显示失败行，不抛到界面上", async () => {
  apiMock.listDir.mockRejectedValue(new Error("EACCES"));
  apiMock.getChangeSet.mockResolvedValue(changeSet([]));
  await render();
  expect(container.textContent).toContain(zh.filesLoadFailed);
 });

 describe("快速过滤", () => {
  beforeEach(() => {
   apiMock.listDir.mockImplementation(async (path: string) =>
    path === ROOT
     ? listing(ROOT, [entry("src", true), entry("a.ts", false)])
     : listing(path, [entryAt(path, "components", true)]),
   );
   apiMock.getChangeSet.mockResolvedValue(changeSet([]));
   apiMock.searchPaths.mockResolvedValue({
    hits: [
     { name: "components", rel: "src/components", path: `${ROOT}/src/components`, isDir: true },
     { name: "Composer.tsx", rel: "src/components/composer/Composer.tsx", path: `${ROOT}/src/components/composer/Composer.tsx`, isDir: false },
    ],
    truncated: false,
   });
  });

  it("输入即搜（防抖后一次 IPC），文件与文件夹都在结果里，路径显示相对写法", async () => {
   vi.useFakeTimers();
   try {
    await render();
    const input = container.querySelector<HTMLInputElement>("input");
    expect(input?.placeholder).toBe(zh.filesFilterPlaceholder);
    await act(async () => {
     typeInto(input!, "comp");
    });
    await act(async () => {
     vi.advanceTimersByTime(DEBOUNCE);
    });
    expect(apiMock.searchPaths).toHaveBeenCalledWith(ROOT, "comp", 200);
    expect(container.textContent).toContain("components");
    expect(container.textContent).toContain("Composer.tsx");
    // 次要文字是相对路径的父级（不是绝对路径）
    expect(container.textContent).toContain("src/components");
    expect(container.textContent).not.toContain(ROOT);
    // 过滤态不渲染树体
    expect(container.textContent).not.toContain("a.ts");
   } finally {
    vi.useRealTimers();
   }
  });

  it("结果行尾「引用到输入框」同样是相对路径", async () => {
   vi.useFakeTimers();
   try {
    await render();
    const input = container.querySelector<HTMLInputElement>("input");
    await act(async () => {
     typeInto(input!, "comp");
    });
    await act(async () => {
     vi.advanceTimersByTime(DEBOUNCE);
    });
    const btn = rowByName("Composer.tsx")?.querySelector<HTMLButtonElement>(
     `button[aria-label="${zh.filesInsertRef}"]`,
    );
    await act(async () => {
     btn?.click();
     for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    expect(useApp.getState().pendingReference).toMatchObject({
     path: "src/components/composer/Composer.tsx",
     label: "Composer.tsx",
    });
   } finally {
    vi.useRealTimers();
   }
  });

  it("点结果 → 清空过滤、逐级展开到该目录并高亮", async () => {
   // 这个用例走真实定时器：定位是「await 一层 → 展开一层」的异步链，
   // fake timers 会把 React 的调度批次一起冻住（其余用例只测同步交互，用 fake timers 更稳）
   await render();
   const input = container.querySelector<HTMLInputElement>("input");
   await act(async () => {
    typeInto(input!, "comp");
   });
   await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE));
   });
   // 点目录结果：过滤清空 + 展开 `src`（父级）后铺出 `components`
   await act(async () => {
    rowByName("components")?.querySelector("button")?.click();
   });
   await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
   });
   expect(input?.value).toBe("");
   expect(apiMock.listDir).toHaveBeenCalledWith(`${ROOT}/src`, false);
   expect(container.textContent).toContain("components");
   // 定位后行是选中底色
   expect(rowByName("components")?.className).toContain("bg-active");
   // 高亮一闪即散：行仍在树里，底色随定时器消失（不长期占位）
   await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1800));
   });
   expect(container.textContent).toContain("components");
   expect(rowByName("components")?.className).not.toContain("bg-active");
  });

  it("无匹配 / 搜索失败都如实说，不留空白", async () => {
   vi.useFakeTimers();
   try {
    await render();
    apiMock.searchPaths.mockResolvedValueOnce({ hits: [], truncated: false });
    const input = container.querySelector<HTMLInputElement>("input");
    await act(async () => {
     typeInto(input!, "zzz");
    });
    await act(async () => {
     vi.advanceTimersByTime(DEBOUNCE);
    });
    expect(container.textContent).toContain(zh.filesSearchEmpty);

    apiMock.searchPaths.mockRejectedValueOnce(new Error("EACCES"));
    await act(async () => {
     typeInto(input!, "qqq");
    });
    await act(async () => {
     vi.advanceTimersByTime(DEBOUNCE);
    });
    expect(container.textContent).toContain(zh.filesSearchFailed);
   } finally {
    vi.useRealTimers();
   }
  });

  it("Esc 清空过滤回到树", async () => {
   vi.useFakeTimers();
   try {
    await render();
    const input = container.querySelector<HTMLInputElement>("input");
    await act(async () => {
     typeInto(input!, "comp");
    });
    await act(async () => {
     vi.advanceTimersByTime(DEBOUNCE);
    });
    expect(container.textContent).not.toContain("a.ts");
    await act(async () => {
     input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(input?.value).toBe("");
    expect(container.textContent).toContain("a.ts");
   } finally {
    vi.useRealTimers();
   }
  });
 });
});
