// @vitest-environment jsdom
/**
 * `useRevealedText` 的行为契约（V38）：
 * 挂载即全量（不倒放）；小增量零滞后；突发按帧倾倒且 complete 立即收尾。
 * rAF 用队列桩（与 mergeEvents.test.ts 的 createStreamBuffer 同一套手法）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useRevealedText } from "./streamReveal";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Probe({ text, complete }: { text: string; complete: boolean }) {
 const shown = useRevealedText(text, complete);
 return createElement("div", { "data-testid": "probe" }, shown);
}

describe("useRevealedText", () => {
 let rafQueue: FrameRequestCallback[];
 let originalRaf: typeof globalThis.requestAnimationFrame;
 let originalCancel: typeof globalThis.cancelAnimationFrame;

 beforeEach(() => {
  rafQueue = [];
  originalRaf = globalThis.requestAnimationFrame;
  originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
   rafQueue.push(cb);
   return rafQueue.length;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => undefined) as typeof globalThis.cancelAnimationFrame;
 });

 afterEach(() => {
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCancel;
 });

 /** 跑一帧（执行排队的 rAF 回调）。 */
 const frame = async () => {
  const cb = rafQueue.shift();
  if (cb) await act(async () => cb(0));
 };

 it("挂载即显示全量（打开正在跑的会话不倒放）", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const long = "字".repeat(200);
  await act(async () => {
   root.render(createElement(Probe, { text: long, complete: false }));
  });
  expect(container.textContent).toBe(long);
  await act(async () => root.unmount());
 });

 it("小增量（≤ 落定阈值）下一帧直接追平，无滞后", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
   root.render(createElement(Probe, { text: "开头", complete: false }));
  });
  await act(async () => {
   root.render(createElement(Probe, { text: "开头再加一点点", complete: false }));
  });
  // 积压 10 字符 ≤ 24 → 一帧内落定
  await frame();
  expect(container.textContent).toBe("开头再加一点点");
  await act(async () => root.unmount());
 });

 it("突发（> 落定阈值）按帧倾倒，complete 立即全量", async () => {
  const head = "头".repeat(30);
  const burst = "尾".repeat(200);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
   root.render(createElement(Probe, { text: head, complete: false }));
  });
  expect(container.textContent).toBe(head);
  await act(async () => {
   root.render(createElement(Probe, { text: head + burst, complete: false }));
  });
  // 更新后未跑帧：仍停在旧量（等下一帧倾倒）
  expect(container.textContent).toBe(head);
  await frame();
  const afterOne = container.textContent ?? "";
  expect(afterOne.length).toBeGreaterThan(head.length);
  expect(afterOne.length).toBeLessThan(head.length + burst.length);
  // 多跑几帧后追赶完成（200 字符积压在 ~30 帧内落定）
  for (let i = 0; i < 40 && (container.textContent ?? "").length < head.length + burst.length; i++) {
   await frame();
  }
  expect(container.textContent).toBe(head + burst);
  // complete 立即全量（即使还有积压）
  await act(async () => {
   root.render(createElement(Probe, { text: head + burst, complete: true }));
  });
  expect(container.textContent).toBe(head + burst);
  await act(async () => root.unmount());
 });

 it("文本被替换成更短内容：直接收敛，不回放", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
   root.render(createElement(Probe, { text: "很长很长很长的一段内容", complete: false }));
  });
  await act(async () => {
   root.render(createElement(Probe, { text: "短", complete: false }));
  });
  expect(container.textContent).toBe("短");
  await act(async () => root.unmount());
 });
});
