// @vitest-environment jsdom
/**
 * 计时 hook（V38）：active 期间按秒走字、停表冻结。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { formatElapsed, useElapsedSeconds } from "./useElapsed";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Probe({ active }: { active: boolean }) {
 return createElement("div", { "data-testid": "probe" }, useElapsedSeconds(active));
}

describe("useElapsedSeconds", () => {
 beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
 });
 afterEach(() => {
  vi.useRealTimers();
 });

 it("active 时走字，停表后冻结", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
   root.render(createElement(Probe, { active: true }));
  });
  expect(container.textContent).toBe("0");
  await act(async () => {
   vi.advanceTimersByTime(2000);
  });
  expect(container.textContent).toBe("2");
  await act(async () => {
   root.render(createElement(Probe, { active: false }));
  });
  await act(async () => {
   vi.advanceTimersByTime(5000);
  });
  expect(container.textContent).toBe("2");
  await act(async () => root.unmount());
 });

 it("从历史打开的已完成行（active 恒为假）不走字", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
   root.render(createElement(Probe, { active: false }));
  });
  await act(async () => {
   vi.advanceTimersByTime(3000);
  });
  expect(container.textContent).toBe("0");
  await act(async () => root.unmount());
 });
});

describe("formatElapsed", () => {
 it("秒内 `12s`，满分钟 `1:05`", () => {
  expect(formatElapsed(0)).toBe("0s");
  expect(formatElapsed(12)).toBe("12s");
  expect(formatElapsed(59)).toBe("59s");
  expect(formatElapsed(60)).toBe("1:00");
  expect(formatElapsed(65)).toBe("1:05");
  expect(formatElapsed(605)).toBe("10:05");
 });
});
