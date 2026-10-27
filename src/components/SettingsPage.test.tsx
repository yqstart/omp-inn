// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@shared/api";
import type { OmpCatalogItem, OmpSettingsCatalog } from "@shared/types";
import { isMacKeyboard } from "../lib/platform";
import { clearSettingsSearchCache } from "../lib/settingsSearch";
import { useApp } from "../stores/app";
import { SettingsPage } from "./SettingsPage";

/** 快捷键的修饰键按平台分叉（与热键判定同源）。 */
const modKey = isMacKeyboard() ? { metaKey: true } : { ctrlKey: true };

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@shared/api", () => ({
 api: {
  getOmpSettingsCatalog: vi.fn(),
  getModels: vi.fn(),
  refreshModels: vi.fn(),
  listPlugins: vi.fn(),
  listSkills: vi.fn(),
  listMemories: vi.fn(),
  listArchivedSessions: vi.fn(),
  getOmpConstraints: vi.fn(),
  getSystemPermissions: vi.fn(),
  openSystemPermission: vi.fn(),
 },
}));

// 通用页真实渲染（搜索定位要落在它的行上）；其余条目用占位，测试聚焦「导航 + 搜索 + 跳转」
vi.mock("./settings/ModelsPanel", () => ({ ModelsPanel: () => <div data-testid="panel-models">models</div> }));
vi.mock("./settings/PluginsPanel", () => ({ PluginsPanel: () => <div data-testid="panel-plugins">plugins</div> }));
vi.mock("./settings/SkillsPanel", () => ({ SkillsPanel: () => <div data-testid="panel-skills">skills</div> }));
vi.mock("./settings/MemoryPanel", () => ({ MemoryPanel: () => <div data-testid="panel-memories">memories</div> }));
vi.mock("./settings/UsagePanel", () => ({ UsagePanel: () => <div data-testid="panel-usage">usage</div> }));
vi.mock("./ArchivedSessions", () => ({ ArchivedSessions: () => <div data-testid="panel-archived">archived</div> }));

const catalogItem = (over: Partial<OmpCatalogItem>): OmpCatalogItem => ({
 key: "k",
 value: true,
 kind: "boolean",
 description: "",
 section: "tools",
 options: [],
 redacted: false,
 ...over,
});
const catalog = (items: OmpCatalogItem[]): OmpSettingsCatalog => ({ sections: ["tools"], items });

/** 冲掉 mock promise 链（目录 / 主题 / 搜索各源）。 */
const flush = async () => {
 await act(async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
 });
};

/** 受控输入：走原生 setter + input 事件（React onChange 的口径）。 */
const typeInto = (input: HTMLInputElement, value: string) => {
 const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
 act(() => {
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
 });
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
 vi.clearAllMocks();
 clearSettingsSearchCache();
 // jsdom 不实现滚动方法（真实 WebView 都有）
 Element.prototype.scrollTo = vi.fn() as never;
 Element.prototype.scrollIntoView = vi.fn() as never;
 useApp.setState({
  health: null,
  locale: "zh-CN",
  models: null,
  settingsTabOpen: true,
  settingsTabActive: true,
  settingsSearchOpen: false,
 });
 vi.mocked(api.getModels).mockResolvedValue({ models: [], fetchedAt: 0 });
 vi.mocked(api.listPlugins).mockResolvedValue({ cwd: "", npm: [], marketplace: [] });
 vi.mocked(api.listSkills).mockResolvedValue({ cwd: "", skills: [], disabled: [], staleDisabled: [], warnings: [] });
 vi.mocked(api.listMemories).mockResolvedValue([]);
 vi.mocked(api.listArchivedSessions).mockResolvedValue([]);
 vi.mocked(api.getOmpConstraints).mockResolvedValue({
  agentDir: "/tmp/omp-agent",
  rulesDir: "/tmp/omp-agent/rules",
  files: [
   { kind: "agents", name: "AGENTS.md", path: "/tmp/omp-agent/AGENTS.md", exists: false, content: "", hash: "", modifiedMs: null, size: 0, error: null },
   { kind: "rules", name: "RULES.md", path: "/tmp/omp-agent/RULES.md", exists: false, content: "", hash: "", modifiedMs: null, size: 0, error: null },
  ],
  rulesError: null,
 });
 container = document.createElement("div");
 document.body.append(container);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
 act(() => {
  useApp.setState({ settingsTabOpen: false, settingsTabActive: false, settingsSearchOpen: false });
 });
});

describe("设置视图框架", () => {
 it("顶部条 + 四组十条目导航；切条目显示对应面板", async () => {
  vi.mocked(api.getOmpSettingsCatalog).mockResolvedValue(catalog([catalogItem({ key: "todo.enabled" })]));
  act(() => {
   root.render(<SettingsPage visible />);
  });
  await flush();

  expect(container.textContent).toContain("返回聊天");
  const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].map((b) => b.textContent?.trim());
  expect(tabs).toEqual(["常用设置", "omp 约束", "系统授权", "远程控制", "模型", "插件", "技能", "记忆", "使用统计", "已归档对话", "存储维护"]);
  // 四组组标题（窄导航下 sr-only，但仍在无障碍树里）
  for (const group of ["通用", "模型", "扩展", "数据"]) {
   expect(container.textContent).toContain(group);
  }
  // 选中态：只有当前条目 aria-selected
  const selected = [...container.querySelectorAll('[role="tab"][aria-selected="true"]')].map((b) => b.textContent?.trim());
  expect(selected).toEqual(["常用设置"]);

  act(() => {
   container.querySelector<HTMLButtonElement>("#settings-tab-models")?.click();
  });
  expect(container.querySelector('[data-testid="panel-models"]')).toBeTruthy();
  expect(container.querySelector('[data-testid="panel-plugins"]')).toBeNull();
 });

 it("系统授权条目：点击后显示四项授权读数", async () => {
  vi.mocked(api.getOmpSettingsCatalog).mockResolvedValue(catalog([catalogItem({ key: "todo.enabled" })]));
  vi.mocked(api.getSystemPermissions).mockResolvedValue({
   supported: true,
   diskAccess: false,
   accessibility: true,
   screenCapture: false,
   automation: true,
  });
  act(() => {
   root.render(<SettingsPage visible />);
  });
  await flush();

  act(() => {
   container.querySelector<HTMLButtonElement>("#settings-tab-system")?.click();
  });
  // 面板首读挂在 setTimeout(0) 上（避开 set-state-in-effect），等一拍宏任务再断言
  await act(async () => {
   await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });

  expect(container.textContent).toContain("完全磁盘访问权限");
  expect(container.textContent).toContain("屏幕录制");
  expect(container.textContent?.match(/已授权/g)?.length).toBe(2);
 });

 it("搜索：跨条目命中、点击结果跳转并定位闪烁；Esc 先清空再关闭", async () => {
  vi.useFakeTimers();
  try {
   vi.mocked(api.getOmpSettingsCatalog).mockResolvedValue(catalog([catalogItem({ key: "todo.enabled" })]));
   act(() => {
    root.render(<SettingsPage visible />);
   });
   await flush();

   // 打开搜索（⌘F 落到 store 状态；顶部条已无搜索钮）
   act(() => {
    useApp.getState().set({ settingsSearchOpen: true });
   });
   await flush();
   const input = container.querySelector<HTMLInputElement>("#settings-search-input");
   expect(input).toBeTruthy();
   expect(container.textContent).toContain("搜索设置");

   // 输入 → 命中常用设置（标题 + 键名）
   typeInto(input!, "todo");
   await flush();
   const mark = container.querySelector("mark");
   expect(mark?.textContent?.toLowerCase()).toBe("todo");
   const hit = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => {
    const text = b.textContent ?? "";
    return text.includes("任务清单") && text.includes("todo.enabled");
   });
   expect(hit).toBeTruthy();

   // 已展开时再按 ⌘F（Ctrl+F 档同样）：焦点拉回输入框
   act(() => {
    input!.blur();
    window.dispatchEvent(
     new KeyboardEvent("keydown", { key: "f", bubbles: true, ...modKey }),
    );
   });
   expect(document.activeElement).toBe(input);

   // 点击 → 收搜索、切到通用、滚动 + 闪烁
   act(() => {
    hit!.click();
   });
   await flush();
   expect(container.querySelector("#settings-search-input")).toBeNull();
   act(() => {
    vi.advanceTimersByTime(200);
   });
   const row = container.querySelector('[data-setting="todo.enabled"]');
   expect(row?.classList.contains("setting-flash")).toBe(true);
   expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  } finally {
   vi.useRealTimers();
  }
 });

 it("搜索：全源失败显示读取失败（不显示「没有匹配」）", async () => {
  vi.mocked(api.getOmpSettingsCatalog).mockRejectedValue(new Error("omp 未就绪"));
  vi.mocked(api.listPlugins).mockRejectedValue(new Error("boom"));
  vi.mocked(api.listSkills).mockRejectedValue(new Error("boom"));
  vi.mocked(api.listMemories).mockRejectedValue(new Error("boom"));
  vi.mocked(api.listArchivedSessions).mockRejectedValue(new Error("boom"));
  vi.mocked(api.getModels).mockRejectedValue(new Error("boom"));
  vi.mocked(api.getOmpConstraints).mockRejectedValue(new Error("boom"));
  act(() => {
   root.render(<SettingsPage visible />);
  });
  await flush();
  act(() => {
   useApp.getState().set({ settingsSearchOpen: true });
  });
  await flush();
  const input = container.querySelector<HTMLInputElement>("#settings-search-input")!;
  typeInto(input, "todo");
  await flush();
  expect(container.textContent).toContain("搜索数据读取失败");
  expect(container.textContent).not.toContain("没有匹配");
 });
});
