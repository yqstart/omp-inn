// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BtwRecord } from "@shared/types";
import { useApp, type BtwPanelState } from "../../stores/app";
import { TEXT } from "../../lib/locale";

/**
 * 旁问面板（V40）：空态 / 运行中轮次与取消 / Enter 发送（追问 vs 新话题）/ 预填消费。
 *
 * 面板只认 store 的 `btw` 片段，因此用例统一用 `setBtwState` 摆状态；发送与取消走
 * `lib/btw.ts` 的真实编排，断言落在被 mock 的 `@shared/api` 上。
 */
const { apiMock } = vi.hoisted(() => ({
 apiMock: {
  btwAsk: vi.fn(async (_sid: string, question: string) => ({
   record: {
    id: "new1",
    leafId: null,
    question,
    answer: "",
    status: "running" as const,
    createdAt: 0,
    updatedAt: 0,
   },
  })),
  btwCancel: vi.fn(async (_sid: string, _rid?: string) => undefined),
 },
}));
vi.mock("@shared/api", () => ({
 api: new Proxy(apiMock, { get: (t, k) => (k in t ? (t as Record<string, unknown>)[k as string] : async () => null) }),
}));

import { BtwPanel } from "./BtwPanel";

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

const zh = TEXT["zh-CN"];

let container: HTMLDivElement;
let root: Root;

const CLOSED: BtwPanelState = { open: false, sessionId: null, records: [], busyRecordId: null, draft: "", error: null };

const setBtwState = (p: Partial<BtwPanelState>) => {
 useApp.setState({ btw: { ...CLOSED, open: true, sessionId: "s1", ...p } });
};

const turn = (over: Partial<BtwRecord> = {}): BtwRecord => ({
 id: "r1",
 leafId: null,
 question: "什么是 X？",
 answer: "",
 status: "running",
 createdAt: 0,
 updatedAt: 0,
 ...over,
});

beforeEach(() => {
 vi.clearAllMocks();
 useApp.setState({ locale: "zh-CN", btw: { ...CLOSED } });
 container = document.createElement("div");
 document.body.append(container);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
});

const mount = async () => {
 act(() => root.render(<BtwPanel />));
 await act(async () => {});
};

/** 受控 textarea 写入：绕过 React 的 value 追踪器再派发 input。 */
const type = async (el: HTMLTextAreaElement, value: string) => {
 await act(async () => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
 });
};

const press = async (el: HTMLElement, init: KeyboardEventInit) => {
 await act(async () => {
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
 });
 await act(async () => {});
};

describe("BtwPanel", () => {
 it("面板关闭时不渲染", async () => {
  useApp.setState({ btw: { ...CLOSED } });
  await mount();
  expect(container.querySelector("aside")).toBeNull();
 });

 it("空态：居中显示 btwEmpty 文案，输入框可用", async () => {
  setBtwState({});
  await mount();
  expect(container.textContent).toContain(zh.btwEmpty);
  expect(container.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
 });

 it("运行中的话题显示思考态与取消按钮，点取消调 cancelBtw", async () => {
  setBtwState({ records: [turn()], busyRecordId: "r1" });
  await mount();
  expect(container.textContent).toContain(zh.btwThinking);
  // 运行中不允许再提问
  expect(container.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(true);
  const cancel = [...container.querySelectorAll("button")].find((b) => b.textContent === zh.btwCancel);
  expect(cancel).toBeTruthy();
  await act(async () => {
   cancel?.click();
  });
  expect(apiMock.btwCancel).toHaveBeenCalledWith("s1", "r1");
 });

 it("话题本体与其 followUps 依次渲染（完成态显示答案）", async () => {
  setBtwState({
   records: [
    turn({
     id: "r1",
     status: "complete",
     answer: "第一段答案",
     followUps: [
      { question: "那 Y 呢？", answer: "第二段答案", status: "complete", createdAt: 0, updatedAt: 0 },
     ],
    }),
   ],
  });
  await mount();
  const body = container.textContent ?? "";
  expect(body).toContain("什么是 X？");
  expect(body).toContain("第一段答案");
  expect(body).toContain("那 Y 呢？");
  expect(body).toContain("第二段答案");
 });

 it("Enter 发送：有最新话题时作为它的追问，并清空输入框", async () => {
  setBtwState({ records: [turn({ id: "r9", status: "complete", answer: "旧答案" })] });
  await mount();
  const ta = container.querySelector<HTMLTextAreaElement>("textarea")!;
  await type(ta, "再问一句");
  await press(ta, { key: "Enter" });
  expect(apiMock.btwAsk).toHaveBeenCalledWith("s1", "再问一句", "r9");
  expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("");
 });

 it("Enter 发送：没有话题时不带 recordId（建新话题）", async () => {
  setBtwState({});
  await mount();
  const ta = container.querySelector<HTMLTextAreaElement>("textarea")!;
  await type(ta, "随便问问");
  await press(ta, { key: "Enter" });
  expect(apiMock.btwAsk).toHaveBeenCalledWith("s1", "随便问问", undefined);
  expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("");
 });

 it("Shift+Enter 不发送（换行），空文本 Enter 也不发送", async () => {
  setBtwState({});
  await mount();
  const ta = container.querySelector<HTMLTextAreaElement>("textarea")!;
  await type(ta, "   ");
  await press(ta, { key: "Enter" });
  expect(apiMock.btwAsk).not.toHaveBeenCalled();
  await press(ta, { key: "Enter", shiftKey: true });
  expect(apiMock.btwAsk).not.toHaveBeenCalled();
 });

 it("草稿来自 store（划选「旁问」预填即写入 btw.draft）", async () => {
  setBtwState({ draft: "预填的问题" });
  await mount();
  expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("预填的问题");
  // 用户编辑写回 store（组件无本地拷贝）
  const ta = container.querySelector<HTMLTextAreaElement>("textarea")!;
  await type(ta, "改一下");
  expect(useApp.getState().btw.draft).toBe("改一下");
 });

 it("btw.error 显示在输入框上方；关闭按钮收起面板", async () => {
  setBtwState({ error: "连接断了" });
  await mount();
  expect(container.textContent).toContain("连接断了");
  const close = container.querySelector<HTMLButtonElement>(`button[aria-label="${zh.btwCloseAria}"]`);
  await act(async () => {
   close?.click();
  });
  expect(useApp.getState().btw.open).toBe(false);
 });
});
