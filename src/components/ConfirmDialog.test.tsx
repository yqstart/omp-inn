// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * ConfirmDialog 的焦点契约：打开时焦点落在「取消」上（危险操作不该被回车误确认），
 * 且打开期间的重渲染不许抢焦点——调用方给的都是内联 `onCancel`，把它放进 effect 依赖会让
 * 每次父级渲染都重跑 `focus()`（与 DialogShell 同源的坑）。
 */

/** React 19 的 `act` 要求显式声明测试环境，否则每次调用都打警告。 */
const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let outside: HTMLInputElement;
let root: Root;

beforeEach(() => {
 container = document.createElement("div");
 document.body.append(container);
 outside = document.createElement("input");
 document.body.append(outside);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
 outside.remove();
});

const confirmProps = { open: true, danger: true, title: "删除？", detail: "不可恢复" };

describe("ConfirmDialog 焦点", () => {
 it("打开时焦点落在「取消」上", () => {
  act(() => {
   root.render(<ConfirmDialog {...confirmProps} onCancel={() => { }} onConfirm={() => { }} />);
  });
  const cancel = container.querySelector("button");
  expect(document.activeElement).toBe(cancel);
 });

 it("打开期间重渲染（新的 onCancel）不抢走既有焦点", () => {
  act(() => {
   root.render(<ConfirmDialog {...confirmProps} onCancel={() => { }} onConfirm={() => { }} />);
  });
  const confirm = container.querySelectorAll("button")[1];
  act(() => confirm.focus());
  act(() => {
   root.render(<ConfirmDialog {...confirmProps} onCancel={() => { }} onConfirm={() => { }} />);
  });
  expect(document.activeElement).toBe(confirm);
 });

 it("Esc 触发重渲染后的最新 onCancel", () => {
  const first = vi.fn();
  const second = vi.fn();
  act(() => {
   root.render(<ConfirmDialog {...confirmProps} onCancel={first} onConfirm={() => { }} />);
  });
  act(() => {
   root.render(<ConfirmDialog {...confirmProps} onCancel={second} onConfirm={() => { }} />);
  });
  act(() => {
   document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(second).toHaveBeenCalledTimes(1);
  expect(first).not.toHaveBeenCalled();
 });

 it("关闭后恢复触发焦点，但不抢走已移到其它面板的焦点", () => {
  act(() => outside.focus());
  act(() => root.render(<ConfirmDialog {...confirmProps} onCancel={() => { }} onConfirm={() => { }} />));
  act(() => root.render(<ConfirmDialog {...confirmProps} open={false} onCancel={() => { }} onConfirm={() => { }} />));
  expect(document.activeElement).toBe(outside);

  act(() => root.render(<ConfirmDialog {...confirmProps} onCancel={() => { }} onConfirm={() => { }} />));
  const other = document.createElement("button");
  document.body.append(other);
  act(() => other.focus());
  act(() => root.render(<ConfirmDialog {...confirmProps} open={false} onCancel={() => { }} onConfirm={() => { }} />));
  expect(document.activeElement).toBe(other);
  other.remove();
 });
});
