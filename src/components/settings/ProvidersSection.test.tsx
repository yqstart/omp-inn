// @vitest-environment jsdom
import { setTimeout as delay } from "node:timers/promises";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@shared/api";
import type { DiscoveredModel, ModelInfo, ModelsConfigFile } from "@shared/types";
import { useApp } from "../../stores/app";
import { ProvidersSection } from "./ProvidersSection";

/**
 * 供应商配置与挑选模型拆开后的收口（2026-10-17）：
 * - 自定义供应商表单只配 名称 / 接口地址 / 接口类型 / API Key，**没有模型输入框**；
 * - 保存成功后开该供应商的模型清单弹窗；
 * - **清单为空 = 打开即拉**（2026-10-19）：弹窗一打开就用已保存的地址 / 接口类型 / 密钥探测端点，
 *   成功直接落在候选视图（不必手点「获取可用模型」）；清单非空或只读时不自动拉；
 * - 勾选后写进 models.yml 的 `models` 列表（`write_models_config` 落盘），随后刷新模型目录。
 */

const h = vi.hoisted(() => ({
 models: [] as ModelInfo[],
 file: { path: "/tmp/models.yml", exists: false, text: "", hash: "" } as ModelsConfigFile,
 discovered: [] as DiscoveredModel[],
 writes: 0,
}));

vi.mock("@shared/api", () => ({
 api: {
  listProviders: vi.fn(async () => []),
  readModelsConfig: vi.fn(async () => ({ ...h.file })),
  writeModelsConfig: vi.fn(async (text: string) => {
   h.writes += 1;
   h.file = { ...h.file, exists: true, text, hash: "h2" };
   return { ...h.file };
  }),
  fetchProviderModels: vi.fn(async () => h.discovered),
  getModels: vi.fn(async () => ({ models: h.models, fetchedAt: 0 })),
  refreshModels: vi.fn(async () => ({ models: h.models, fetchedAt: 0 })),
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
 h.models = [];
 h.file = { path: "/tmp/models.yml", exists: false, text: "", hash: "" };
 h.discovered = [];
 h.writes = 0;
 useApp.setState({ models: null, myModels: [], locale: "zh-CN" });
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

/** 受控输入：走原型 setter + input 事件（React 的 onChange 由 input 触发）。 */
const setInput = async (el: Element | null, value: string) => {
 const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
 await act(async () => {
  setter?.call(el, value);
  el?.dispatchEvent(new Event("input", { bubbles: true }));
 });
};

const byText = (text: string) =>
 [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

describe("添加供应商向导", () => {
 it("自定义供应商只配供应商字段：保存后开的是该供应商的模型清单弹窗", async () => {
  act(() => root.render(<ProvidersSection />));
  await flush();
  act(() => byText("添加供应商")!.click());
  // 第一步：选提供商（「自定义」是选择器首项）
  act(() => byText("自定义")!.click());
  // 自定义表单只有供应商字段（名称 / 接口地址 / 接口类型 / API Key）——模型不在这里配
  await setInput(container.querySelector('[placeholder="my-gateway"]'), "my-gw");
  await setInput(container.querySelector('[placeholder="https://gw.example.com/v1"]'), "https://gw.example.com/v1");
  expect(container.querySelector('[placeholder="model-id"]')).toBeNull();
  act(() => byText("保存")!.click());
  await flush();

  expect(h.writes).toBe(1);
  // 保存 → 页级刷新（目录）+ 就该供应商进行挑选：弹窗标题带新键
  const dialog = container.querySelector('[role="dialog"][aria-modal="true"]');
  expect(dialog).not.toBeNull();
  // 清单为空 = 打开即拉：直接拿新供应商已保存的配置探测端点（没填密钥就不带认证头），
  // 成功即落候选视图——用户不必再手点一次「获取可用模型」
  expect(vi.mocked(api.fetchProviderModels)).toHaveBeenCalledWith("https://gw.example.com/v1", "openai-completions", null);
  expect(dialog!.textContent).toContain("选择要添加的模型");
  // 端点没列出模型：候选视图给空结果说明
  expect(dialog!.textContent).toContain("该提供商没有列出任何模型");
  expect(vi.mocked(api.refreshModels)).toHaveBeenCalled();
 });

 it("清单为空：打开即拉端点候选，添加所选后写进 models.yml", async () => {
  h.file = {
   path: "/tmp/models.yml",
   exists: true,
   hash: "h1",
   text: "providers:\n  my-gw:\n    baseUrl: https://gw.example.com/v1\n    api: openai-completions\n    apiKey: GW_KEY\n",
  };
  h.discovered = [
   { id: "alpha", name: "Alpha", contextWindow: 200000, maxTokens: null, input: ["text", "image"] },
   { id: "beta", name: null, contextWindow: null, maxTokens: 4096, input: null },
  ];
  act(() => root.render(<ProvidersSection />));
  await flush();

  act(() => byText("挑选模型")!.click());
  await flush();
  // 打开即拉，拉取用的是该供应商已保存的配置（地址 / 接口类型 / 密钥原样传下去）
  expect(vi.mocked(api.fetchProviderModels)).toHaveBeenCalledWith("https://gw.example.com/v1", "openai-completions", "GW_KEY");
  // 候选默认全选（清单里还没有的）→ 添加所选
  act(() => byText("添加所选")!.click());
  await flush();
  expect((container.querySelector('[aria-label="模型 id"]') as HTMLInputElement | null)?.value).toBe("alpha");

  act(() => byText("保存")!.click());
  await flush();
  expect(h.writes).toBe(1);
  expect(h.file.text).toContain("id: alpha");
  expect(h.file.text).toContain("name: Alpha");
  expect(h.file.text).toContain("contextWindow: 200000");
  expect(h.file.text).toContain("input: [text, image]");
  expect(h.file.text).toContain("id: beta");
  expect(h.file.text).toContain("maxTokens: 4096");
  // 落盘后弹窗关闭、目录重读
  expect(container.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
  expect(vi.mocked(api.refreshModels)).toHaveBeenCalled();
 });

 it("清单非空：打开是清单视图（不自动探测），按钮仍可手动拉", async () => {
  h.file = {
   path: "/tmp/models.yml",
   exists: true,
   hash: "h1",
   text: "providers:\n  my-gw:\n    baseUrl: https://gw.example.com/v1\n    api: openai-completions\n    models:\n      - id: alpha\n        name: Alpha\n",
  };
  h.discovered = [{ id: "beta", name: null, contextWindow: null, maxTokens: null, input: null }];
  vi.mocked(api.fetchProviderModels).mockClear();
  act(() => root.render(<ProvidersSection />));
  await flush();

  act(() => byText("挑选模型")!.click());
  await flush();
  const dialog = container.querySelector('[role="dialog"][aria-modal="true"]');
  expect(dialog!.textContent).toContain("挑选 my-gw 的模型");
  expect(dialog!.textContent).toContain("获取可用模型");
  // 用户是来看 / 调现有清单的：打开不自动探测（否则候选视图会把清单挡掉）
  expect(vi.mocked(api.fetchProviderModels)).not.toHaveBeenCalled();

  // 手动入口照旧：点一下才问端点
  act(() => byText("获取可用模型")!.click());
  await flush();
  expect(vi.mocked(api.fetchProviderModels)).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="dialog"]')!.textContent).toContain("添加所选");
 });

 it("自定义清单的行尾星标 = 加入 / 移出「我的模型」", async () => {
  h.file = {
   path: "/tmp/models.yml",
   exists: true,
   hash: "h1",
   text: "providers:\n  my-gw:\n    baseUrl: https://gw.example.com/v1\n    api: openai-completions\n    models:\n      - id: alpha\n        name: Alpha\n",
  };
  act(() => root.render(<ProvidersSection />));
  await flush();

  act(() => byText("挑选模型")!.click());
  await flush();
  const dialog = container.querySelector('[role="dialog"][aria-modal="true"]');
  expect(dialog).not.toBeNull();

  // 行尾星标与登录型供应商的挑选面板同一口径：selector = provider/id
  const add = dialog!.querySelector('[aria-label="加入我的模型 Alpha"]');
  expect(add).not.toBeNull();
  act(() => (add as HTMLButtonElement).click());
  expect(useApp.getState().myModels).toEqual(["my-gw/alpha"]);

  const remove = dialog!.querySelector('[aria-label="移出我的模型 Alpha"]');
  expect(remove).not.toBeNull();
  act(() => (remove as HTMLButtonElement).click());
  expect(useApp.getState().myModels).toEqual([]);
 });

 it("清单形状界面表达不了（只读）：打开不自动探测，就地给只读说明", async () => {
  h.file = {
   path: "/tmp/models.yml",
   exists: true,
   hash: "h1",
   text: "providers:\n  my-gw:\n    baseUrl: https://gw.example.com/v1\n    api: openai-completions\n    models: {}\n",
  };
  vi.mocked(api.fetchProviderModels).mockClear();
  act(() => root.render(<ProvidersSection />));
  await flush();

  act(() => byText("挑选模型")!.click());
  await flush();
  const dialog = container.querySelector('[role="dialog"][aria-modal="true"]');
  expect(dialog!.textContent).toContain("挑选 my-gw 的模型");
  expect(dialog!.textContent).toContain("不是界面能安全改写的形状");
  expect(vi.mocked(api.fetchProviderModels)).not.toHaveBeenCalled();
 });
});
