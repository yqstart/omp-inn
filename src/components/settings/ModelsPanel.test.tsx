// @vitest-environment jsdom
import { setTimeout as delay } from "node:timers/promises";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@shared/api";
import type { ModelInfo, ModelRolesInfo, ProviderView } from "@shared/types";
import { useApp } from "../../stores/app";
import { ROLE_PROFILES_KEY } from "../../lib/roleProfiles";
import { ModelsPanel } from "./ModelsPanel";

/**
 * 「omp 里改完，切回设置页就能看到」这条契约：设置视图重新激活（从聊天切回来）时，
 * 模型角色要重新读一遍 omp 全局配置——此前只在组件挂载时读一次，切回来看到的还是旧值。
 *
 * 2026-10-20 起模型角色 = 多套本机配置：omp `modelRoles` 只对应「激活配置」，
 * 列表 → 点击一套进入编辑；本文件同时守住「只有一套激活 / 激活才写 omp / 未激活只落本机」。
 */

const CR = { slow: "y/gpt-5.6-astra:auto:medium" };

const h = vi.hoisted(() => ({
 roleCalls: 0,
 roles: { slow: "y/gpt-5.6-astra:auto:medium" } as Record<string, string>,
 models: [] as ModelInfo[],
 chains: {} as Record<string, string[]>,
 providers: [] as ProviderView[],
}));

const BUILTIN = ["default", "smol", "slow", "vision", "plan", "commit", "tiny", "task", "advisor"];

const info = (): ModelRolesInfo => ({
 roles: { ...h.roles },
 storage: "global",
 builtin: BUILTIN,
});

vi.mock("@shared/api", () => ({
 api: {
  getModelRoles: vi.fn(async () => {
   h.roleCalls += 1;
   return info();
  }),
  getFallbackChains: vi.fn(async () => ({ chains: h.chains, modelFallback: true, revertPolicy: "cooldown-expiry" })),
  syncCycleOrder: vi.fn(async () => [] as string[]),
  setModelRole: vi.fn(async (role: string, selector: string | null) => {
   if (selector) h.roles[role] = selector;
   else delete h.roles[role];
   return info();
  }),
  applyModelRoles: vi.fn(async (roles: Record<string, string>) => {
   h.roles = { ...roles };
   return info();
  }),
  getModels: vi.fn(async () => ({ models: h.models, fetchedAt: 0 })),
  refreshModels: vi.fn(async () => ({ models: h.models, fetchedAt: 0 })),
  setRetryOptions: vi.fn(async (modelFallback: boolean, revertPolicy: string) => ({ chains: h.chains, modelFallback, revertPolicy })),
  listProviders: vi.fn(async () => h.providers),
  logoutProvider: vi.fn(async () => { }),
  purgeProviderModels: vi.fn(async () => ({
   modelRoles: { roles: { slow: "openai/gpt" }, storage: "global", builtin: BUILTIN },
   fallbackChains: { chains: { "openai/gpt": ["openai/other"] }, modelFallback: true, revertPolicy: "cooldown-expiry" },
  })),
  readModelsConfig: vi.fn(async () => ({ path: "/tmp/models.yml", exists: false, text: "", hash: "" })),
  getProviderLogin: vi.fn(async () => ({ provider: "", running: false, url: null, lines: [], done: null })),
 },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => { }) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => { }) }));

/** React 19 的 `act` 要求显式声明测试环境，否则每次调用都打警告。 */
const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
 localStorage.clear();
 vi.mocked(api.applyModelRoles).mockClear();
 vi.mocked(api.setModelRole).mockClear();
 vi.mocked(api.syncCycleOrder).mockClear();
 h.roleCalls = 0;
 h.roles = { ...CR };
 h.models = [];
 h.chains = {};
 h.providers = [];
 vi.mocked(api.logoutProvider).mockClear();
 vi.mocked(api.purgeProviderModels).mockClear();
 useApp.setState({ settingsTabActive: true, models: null, myModels: [], locale: "zh-CN" });
 container = document.createElement("div");
 document.body.append(container);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
});

/** 冲掉 `load()` 的 promise 链（多处 setState）——两次宏任务足够。 */
const flush = async () => {
 await act(async () => {
  await delay(0);
  await delay(0);
 });
};

const buttonByLabel = (label: string) =>
 container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement | null;
const clickLabel = (label: string) => {
 const button = buttonByLabel(label);
 expect(button, label).not.toBeNull();
 act(() => button!.click());
};
const clickText = (text: string) => {
 const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
 expect(button, text).not.toBeUndefined();
 act(() => button!.click());
};
/** React 受控 input 的可靠赋值：走原型 setter，再发 input 事件（绕过 React 的 value tracker）。 */
const setInput = (el: HTMLInputElement, value: string) => {
 const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
 expect(setter).toBeTypeOf("function");
 act(() => {
  setter!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
 });
};
/** React 的 onBlur 监听 focusout（blur 不冒泡）。 */
const blurInput = (el: HTMLInputElement) => {
 act(() => {
  el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
 });
};
const writeProfiles = (state: unknown) => localStorage.setItem(ROLE_PROFILES_KEY, JSON.stringify(state));
const readProfiles = () => JSON.parse(localStorage.getItem(ROLE_PROFILES_KEY) ?? "null");

/** 打开一套配置的编辑视图（列表行的可访问名 = 「编辑配置 {名称}」）。 */
const openProfile = async (name: string) => {
 clickLabel(`编辑配置 ${name}`);
 await flush();
};

describe("ModelsPanel 的 omp 侧识别", () => {
 it("挂载时读一次 omp 角色；设置标签重新激活时再读一次（切回来看得到 omp 的新值）", async () => {
  act(() => {
   root.render(<ModelsPanel />);
  });
  await flush();
  expect(h.roleCalls).toBe(1);
  // 首次没有本机配置 → 用 omp 当前角色表建一套「默认配置」并激活；
  // 列表只展示名称，模型 selector 在编辑弹窗里
  expect(container.textContent).toContain("默认配置");
  expect(container.textContent).toContain("已激活");
  expect(container.textContent).not.toContain("y/gpt-5.6-astra:auto");
  expect(readProfiles().activeId).toBe(readProfiles().profiles[0].id);

  // 模拟「在别处（omp TUI / CLI）改了角色」：omp 侧的值变了，本组件不知情
  h.roles = { slow: "opencode-go/deepseek-v4.1-flash:low" };
  act(() => useApp.setState({ settingsTabActive: false }));
  expect(h.roleCalls).toBe(1);
  act(() => useApp.setState({ settingsTabActive: true }));
  await flush();

  expect(h.roleCalls).toBe(2);
  expect(container.textContent).toContain("默认配置");
  // 外部改动收进当前激活配置（不新建第二套）
  expect(readProfiles().profiles).toHaveLength(1);
  expect(readProfiles().profiles[0].roles).toEqual({ slow: "opencode-go/deepseek-v4.1-flash:low" });
  // 打开弹窗才看到角色表
  await openProfile("默认配置");
  expect(container.textContent).toContain("opencode-go/deepseek-v4.1-flash");
  expect(container.textContent).not.toContain("y/gpt-5.6-astra:auto");
 });

 it("未激活时不读（设置标签隐藏期间不打扰 omp）", async () => {
  useApp.setState({ settingsTabActive: false });
  act(() => {
   root.render(<ModelsPanel />);
  });
  await flush();
  expect(h.roleCalls).toBe(0);
 });

 it("已配置但未星标的角色仍按完整目录判断思考能力", async () => {
  h.models = [
   { provider: "demo", id: "plain", selector: "demo/plain", name: "Plain", contextWindow: 1000, maxTokens: 100, reasoning: false, thinking: [], input: ["text"] },
   { provider: "demo", id: "reason", selector: "demo/reason", name: "Reason", contextWindow: 1000, maxTokens: 100, reasoning: true, thinking: ["low", "high"], input: ["text"] },
  ];
  h.roles = { default: "demo/plain" };
  useApp.setState({ myModels: ["demo/reason"] });
  act(() => root.render(<ModelsPanel />));
  await flush();
  await openProfile("默认配置");
  expect(container.querySelector('[aria-label="设置 默认 的思考档位"]')).toBeNull();
 });

 it("候选 = 全量目录（不收窄）：星标模型置顶分组，未星标的照常可选、可加星", async () => {
  h.models = [
   { provider: "demo", id: "plain", selector: "demo/plain", name: "Plain", contextWindow: 1000, maxTokens: 100, reasoning: false, thinking: [], input: ["text"] },
   { provider: "demo", id: "reason", selector: "demo/reason", name: "Reason", contextWindow: 1000, maxTokens: 100, reasoning: true, thinking: ["low", "high"], input: ["text"] },
  ];
  h.roles = {};
  useApp.setState({ myModels: ["demo/reason"] });
  act(() => root.render(<ModelsPanel />));
  await flush();
  await openProfile("默认配置");
  act(() => (container.querySelector('[aria-label="选择 默认"]') as HTMLButtonElement).click());
  // 模型列表以模态弹窗呈现（内嵌展开会把下方角色整体推下去）
  const dialog = container.querySelector('[role="dialog"][aria-modal="true"]')!;
  const rows = [...dialog.querySelectorAll('button[aria-label^="使用模型"]')].map((el) => el.getAttribute("title"));
  // 星标组（「我的模型」）在前、供应商组在后；未星标的也在（只排序、不收窄）
  expect(dialog.textContent).toContain("我的模型");
  expect(rows).toEqual(["demo/reason", "demo/plain"]);
  // 行内星标 = 加入 / 移出「我的模型」（同一份 localStorage 偏好）
  act(() => (dialog.querySelector('[aria-label="加入我的模型 Plain"]') as HTMLButtonElement).click());
  expect(useApp.getState().myModels).toEqual(["demo/reason", "demo/plain"]);
  act(() => (container.querySelector('[aria-label="移出我的模型 Reason"]') as HTMLButtonElement).click());
  expect(useApp.getState().myModels).toEqual(["demo/plain"]);
 });

 it("角色行挑模型：弹窗点选即写回并收起，行上显示新 selector", async () => {
  h.models = [
   { provider: "demo", id: "plain", selector: "demo/plain", name: "Plain", contextWindow: 1000, maxTokens: 100, reasoning: false, thinking: [], input: ["text"] },
  ];
  h.roles = {};
  act(() => root.render(<ModelsPanel />));
  await flush();
  await openProfile("默认配置");
  act(() => (container.querySelector('[aria-label="选择 默认"]') as HTMLButtonElement).click());
  const dialog = container.querySelector('[role="dialog"][aria-modal="true"]')!;
  act(() => (dialog.querySelector('[title="demo/plain"]') as HTMLButtonElement).click());
  await flush();
  const calls = vi.mocked(api.applyModelRoles).mock.calls;
  expect(calls[calls.length - 1]).toEqual([{ default: "demo/plain" }]);
  // 模型选择弹窗收起；配置编辑弹窗仍在（角色行现在在弹窗里）
  expect(container.querySelector('[role="dialog"][aria-label="选择模型 · 默认"]')).toBeNull();
  expect(container.querySelector('[role="dialog"][aria-label="编辑模型配置"]')).not.toBeNull();
  expect(container.textContent).toContain("demo/plain");
  // 激活配置的写入同步到本机快照（下次回读用于识别外部改动）
  expect(readProfiles().applied).toEqual({ default: "demo/plain" });
 });

 it("较早的角色读取晚返回时不能覆盖重新激活后的配置", async () => {
  // 项目目标为 ES2021，没有 Promise.withResolvers。
  let finish!: (value: ModelRolesInfo) => void;
  vi.mocked(api.getModelRoles).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  act(() => root.render(<ModelsPanel />));
  await flush();
  h.roles = { slow: "demo/current" };
  act(() => useApp.setState({ settingsTabActive: false }));
  act(() => useApp.setState({ settingsTabActive: true }));
  await flush();
  await act(async () => finish({ roles: { slow: "demo/stale" }, storage: "global", builtin: ["slow"] }));
  await flush();
  await openProfile("默认配置");
  expect(container.textContent).toContain("demo/current");
  expect(container.textContent).not.toContain("demo/stale");
 });

 it("角色读取失败时给错误与重试；重试后角色列表恢复", async () => {
  vi.mocked(api.getModelRoles).mockRejectedValueOnce(new Error("roles boom"));
  act(() => root.render(<ModelsPanel />));
  await flush();
  expect(container.textContent).toContain("roles boom");
  h.roles = { slow: "demo/fresh" };
  act(() => {
   const retry = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "重试");
   retry?.click();
  });
  await flush();
  await openProfile("默认配置");
  expect(container.textContent).toContain("demo/fresh");
  expect(container.textContent).not.toContain("roles boom");
 });

 it("环是角色表的派生投影：挂载后与改角色后各同步一次，行内不再有环控件", async () => {
  const syncSpy = vi.mocked(api.syncCycleOrder);
  syncSpy.mockClear();
  h.models = [
   { provider: "demo", id: "plain", selector: "demo/plain", name: "Plain", contextWindow: 1000, maxTokens: 100, reasoning: false, thinking: [], input: ["text"] },
  ];
  h.roles = { default: "demo/plain" };
  act(() => root.render(<ModelsPanel />));
  await flush();
  // 打开页面：环对齐一次；行内环控件（开关 / 位次 / 上下移）已随手动编辑面一起退场
  expect(syncSpy).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[aria-label="添加角色 默认"]')).toBeNull();
  expect(container.querySelector('[aria-label="移出环 默认"]')).toBeNull();

  // 换另一个角色的模型 → 角色写入后自动再同步一次
  await openProfile("默认配置");
  act(() => (container.querySelector('[aria-label="选择 深思"]') as HTMLButtonElement).click());
  const dialog = container.querySelector('[role="dialog"][aria-modal="true"]')!;
  act(() => (dialog.querySelector('[title="demo/plain"]') as HTMLButtonElement).click());
  await flush();
  expect(syncSpy).toHaveBeenCalledTimes(2);
 });

 it("新建转移链排除已配置模型，切换总开关不丢失草稿", async () => {
  h.models = ["first", "second"].map((id) => ({ provider: "demo", id, selector: `demo/${id}`, name: id, contextWindow: 1000, maxTokens: 100, reasoning: false, thinking: [], input: ["text"] }));
  h.chains = { "demo/first": ["demo/second"] };
  act(() => root.render(<ModelsPanel />));
  await flush();
  const section = container.querySelector('[aria-label="失败转移"]')!;
  const clickSectionText = (text: string) => act(() => [...section.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!.click());
  clickSectionText("添加转移链");
  act(() => (section.querySelector('fieldset [role="radio"][aria-checked="false"]') as HTMLButtonElement).click());
  // 模型对象走弹窗（已配置的 demo/first 不在候选里）
  act(() => (section.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement).click());
  expect(container.querySelector('[role="dialog"] [title="demo/first"]')).toBeNull();
  act(() => (container.querySelector('[role="dialog"] [title="demo/second"]') as HTMLButtonElement).click());
  clickSectionText("添加目标");
  act(() => (container.querySelector('[role="dialog"] [title="demo/first"]') as HTMLButtonElement).click());
  act(() => (section.querySelector('[role="switch"]') as HTMLButtonElement).click());
  await flush();
  expect(section.querySelector("fieldset")?.textContent).toContain("demo/second");
  expect(section.querySelector("fieldset")?.textContent).toContain("demo/first");
  expect([...section.querySelectorAll("button")].find((b) => b.textContent?.trim() === "创建")?.disabled).toBe(false);
 });
});

describe("模型角色的多套配置", () => {
 const twoProfiles = () => ({
  version: 1,
  profiles: [
   { id: "p1", name: "日常", roles: { default: "demo/plain" } },
   { id: "p2", name: "提交", roles: { commit: "demo/commit" } },
  ],
  activeId: "p1",
  applied: { default: "demo/plain" },
 });

 it("点击配置打开弹窗编辑，配置列表仍在页面上（不是行内展开）", async () => {
  h.roles = { default: "demo/plain" };
  writeProfiles(twoProfiles());
  act(() => root.render(<ModelsPanel />));
  await flush();
  expect(container.querySelector('[role="dialog"]')).toBeNull();

  await openProfile("日常");
  const dialog = container.querySelector('[role="dialog"][aria-modal="true"]')!;
  expect(dialog.getAttribute("aria-label")).toBe("编辑模型配置");
  // 角色行在弹窗里；列表没有被替换掉（弹窗关闭后仍在原位）
  expect(dialog.querySelector('[aria-label="选择 默认"]')).not.toBeNull();
  expect(buttonByLabel("编辑配置 日常")).not.toBeNull();
  expect(buttonByLabel("编辑配置 提交")).not.toBeNull();
 });

 it("列表展示多套配置且只有一套激活；点击进入该套编辑", async () => {
  h.models = [
   { provider: "demo", id: "plain", selector: "demo/plain", name: "Plain", contextWindow: 1000, maxTokens: 100, reasoning: false, thinking: [], input: ["text"] },
  ];
  h.roles = { default: "demo/plain" };
  writeProfiles(twoProfiles());
  act(() => root.render(<ModelsPanel />));
  await flush();

  expect(container.textContent).toContain("日常");
  expect(container.textContent).toContain("提交");
  // 列表只展示名称，不展示模型信息
  expect(container.textContent).not.toContain("demo/plain");
  // 激活徽标只有一个（列表里另一套显示「激活」按钮）
  expect(container.textContent?.match(/已激活/g)).toHaveLength(1);
  expect([...container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "激活")).toHaveLength(1);

  await openProfile("提交");
  // 未激活配置的编辑提示 + 这套配置自己的角色值
  expect(container.textContent).toContain("此配置未激活");
  expect(container.querySelector('[aria-label="选择 提交信息"]')).not.toBeNull();
  expect(container.querySelector('input[aria-label="名称"]')).toHaveProperty("value", "提交");
 });

 it("编辑弹窗的「完成」关闭弹窗，列表回到可操作状态", async () => {
  h.roles = { default: "demo/plain" };
  writeProfiles(twoProfiles());
  act(() => root.render(<ModelsPanel />));
  await flush();
  await openProfile("日常");
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  clickText("完成");
  await flush();
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(buttonByLabel("编辑配置 日常")).not.toBeNull();
 });

 it("未激活配置改角色只落本机，不调用 omp 写入", async () => {
  h.models = [
   { provider: "demo", id: "plain", selector: "demo/plain", name: "Plain", contextWindow: 1000, maxTokens: 100, reasoning: false, thinking: [], input: ["text"] },
  ];
  h.roles = { default: "demo/plain" };
  writeProfiles(twoProfiles());
  act(() => root.render(<ModelsPanel />));
  await flush();
  await openProfile("提交");
  act(() => (container.querySelector('[aria-label="选择 默认"]') as HTMLButtonElement).click());
  const dialog = container.querySelector('[role="dialog"][aria-modal="true"]')!;
  act(() => (dialog.querySelector('[title="demo/plain"]') as HTMLButtonElement).click());
  await flush();

  expect(api.applyModelRoles).not.toHaveBeenCalled();
  const saved = readProfiles();
  expect(saved.activeId).toBe("p1");
  expect(saved.profiles.find((p: { id: string }) => p.id === "p2").roles).toEqual({ commit: "demo/commit", default: "demo/plain" });
  expect(saved.profiles.find((p: { id: string }) => p.id === "p1").roles).toEqual({ default: "demo/plain" });
 });

 it("激活一套配置：整表写入 omp、移动激活位并同步轮换序", async () => {
  h.roles = { default: "demo/plain" };
  writeProfiles(twoProfiles());
  act(() => root.render(<ModelsPanel />));
  await flush();
  const syncSpy = vi.mocked(api.syncCycleOrder);
  syncSpy.mockClear();

  clickText("激活");
  await flush();

  expect(api.applyModelRoles).toHaveBeenCalledWith({ commit: "demo/commit" });
  expect(h.roles).toEqual({ commit: "demo/commit" });
  expect(readProfiles().activeId).toBe("p2");
  expect(readProfiles().applied).toEqual({ commit: "demo/commit" });
  expect(syncSpy).toHaveBeenCalledTimes(1);
  expect(container.textContent?.match(/已激活/g)).toHaveLength(1);
 });

 it("激活中的配置不能删除；未激活配置删除走二次确认", async () => {
  h.roles = { default: "demo/plain" };
  writeProfiles(twoProfiles());
  act(() => root.render(<ModelsPanel />));
  await flush();

  expect(buttonByLabel("删除配置 日常")?.disabled).toBe(true);
  clickLabel("删除配置 提交");
  const dialog = container.querySelector('[role="dialog"][aria-modal="true"]')!;
  expect(dialog.textContent).toContain("提交");
  act(() => [...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "删除")!.click());
  await flush();

  const saved = readProfiles();
  expect(saved.profiles).toHaveLength(1);
  expect(saved.profiles[0].id).toBe("p1");
  expect(saved.activeId).toBe("p1");
 });

 it("新建配置 = 弹窗里同时配名称与角色，创建后不改变激活位", async () => {
  h.models = [
   { provider: "demo", id: "plain", selector: "demo/plain", name: "Plain", contextWindow: 1000, maxTokens: 100, reasoning: false, thinking: [], input: ["text"] },
  ];
  h.roles = { default: "demo/plain" };
  writeProfiles(twoProfiles());
  act(() => root.render(<ModelsPanel />));
  await flush();
  // 两套已有配置（都不叫「配置 N」）→ 建议名从 1 开始
  clickText("新建配置");
  const dialog = container.querySelector('[role="dialog"][aria-modal="true"]')!;
  expect(dialog.getAttribute("aria-label")).toBe("新建模型配置");
  const input = dialog.querySelector("input") as HTMLInputElement;
  expect(input.value).toBe("配置 1");
  // 重名会被拦下（弹窗不关、不落盘）
  setInput(input, "日常");
  act(() => [...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "创建")!.click());
  expect(dialog.textContent).toContain("已有同名配置");
  // 改成新名字，并在弹窗里先配一个角色 → 创建时一起落盘
  setInput(input, "写作");
  act(() => (dialog.querySelector('[aria-label="选择 默认"]') as HTMLButtonElement).click());
  act(() => (container.querySelector('[title="demo/plain"]') as HTMLButtonElement).click());
  await flush();
  act(() => [...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "创建")!.click());
  await flush();

  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain("写作");
  const saved = readProfiles();
  expect(saved.profiles).toHaveLength(3);
  expect(saved.activeId).toBe("p1");
  expect(saved.profiles[2].name).toBe("写作");
  expect(saved.profiles[2].roles).toEqual({ default: "demo/plain" });
  // 新建不激活，也不写 omp
  expect(api.applyModelRoles).not.toHaveBeenCalled();
 });

 it("供应商登出后清掉收藏与每套配置里的该供应商角色，并采用后端清理后的角色表", async () => {
  h.providers = [{ id: "anthropic", name: "Anthropic", configured: true }];
  const active = { id: "p1", name: "日常", roles: { default: "anthropic/claude", slow: "openai/gpt" } };
  const inactive = { id: "p2", name: "写作", roles: { commit: "anthropic/claude:high", plan: "demo/plan" } };
  h.roles = { ...active.roles };
  writeProfiles({ version: 1, profiles: [active, inactive], activeId: "p1", applied: { ...active.roles } });
  useApp.setState({ myModels: ["anthropic/claude", "openai/gpt"] });

  act(() => root.render(<ModelsPanel />));
  await flush();
  clickLabel("登出 anthropic");
  const dialog = container.querySelector('[role="dialog"][aria-modal="true"]')!;
  expect(dialog.textContent).toContain("登出 Anthropic？");
  act(() => [...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "登出")!.click());
  await flush();

  expect(api.logoutProvider).toHaveBeenCalledWith("anthropic");
  expect(api.purgeProviderModels).toHaveBeenCalledWith("anthropic");
  expect(useApp.getState().myModels).toEqual(["openai/gpt"]);
  const saved = readProfiles();
  // 激活配置 = 后端清理后的回读真值；未激活配置按同一供应商前缀过滤
  expect(saved.profiles[0].roles).toEqual({ slow: "openai/gpt" });
  expect(saved.profiles[1].roles).toEqual({ plan: "demo/plan" });
  expect(saved.applied).toEqual({ slow: "openai/gpt" });
 });

 it("编辑激活配置的角色会立即写 omp；改名只落本机", async () => {
  h.models = [
   { provider: "demo", id: "other", selector: "demo/other", name: "Other", contextWindow: 1000, maxTokens: 100, reasoning: false, thinking: [], input: ["text"] },
  ];
  h.roles = { default: "demo/plain" };
  writeProfiles(twoProfiles());
  act(() => root.render(<ModelsPanel />));
  await flush();
  await openProfile("日常");

  const name = container.querySelector('input[aria-label="名称"]') as HTMLInputElement;
  setInput(name, "工作");
  blurInput(name);
  await flush();
  expect(readProfiles().profiles[0].name).toBe("工作");
  expect(api.applyModelRoles).not.toHaveBeenCalled();

  act(() => (container.querySelector('[aria-label="选择 默认"]') as HTMLButtonElement).click());
  const dialog = container.querySelector('[role="dialog"][aria-modal="true"]')!;
  act(() => (dialog.querySelector('[title="demo/other"]') as HTMLButtonElement).click());
  await flush();
  expect(api.applyModelRoles).toHaveBeenCalledWith({ default: "demo/other" });
  expect(readProfiles().profiles[0].roles).toEqual({ default: "demo/other" });
  expect(readProfiles().applied).toEqual({ default: "demo/other" });
 });
});
