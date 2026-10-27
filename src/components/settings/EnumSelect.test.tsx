// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogShell } from "./DialogShell";
import { EnumSelect } from "./EnumSelect";

/**
 * 「安装插件」弹窗里的项目下拉被弹窗整个盖住（用户实测）：列表原来无条件 `portal` 到
 * `document.body`（`z-10`），弹窗遮罩却是 `z-30`——列表在遮罩底下，既看不见也点不到；
 * `useDropdown` 的模态判定又把「不在弹窗里」的浮层当失效浮层（不自动聚焦、Esc 不先关它）。
 * 契约定为：**有可见模态弹窗时列表挂进该弹窗**，没有才挂 `body`（设置页行内的用法）。
 */

/** React 19 的 `act` 要求显式声明测试环境，否则每次调用都打警告。 */
const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

const CHOICES = [
 { value: "omp-inn", label: "omp-inn" },
 { value: "oh-my-pi", label: "oh-my-pi" },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
 container = document.createElement("div");
 document.body.append(container);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
});

/** 真实点击序列：`pointerdown` 与 `click` 都派发（jsdom 不会自己生成）。 */
function click(element: Element) {
 act(() => {
  element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
 });
}

function pressEscape() {
 act(() => {
  (document.activeElement ?? document).dispatchEvent(
   new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
 });
}

/** 「安装插件」弹窗的形态：项目级下拉是这个弹窗里唯一的下拉。 */
function InstallDialog({ onClose }: { onClose: () => void }) {
 const [value, setValue] = useState(CHOICES[0].value);
 return (
  <DialogShell title="安装插件" onClose={onClose}>
   <EnumSelect label="项目" value={value} choices={CHOICES} onPick={setValue} />
  </DialogShell>
 );
}

describe("EnumSelect 的挂载层", () => {
 it("弹窗里打开：列表挂进弹窗，遮罩盖不住", () => {
  act(() => root.render(<InstallDialog onClose={() => { }} />));
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
  click(container.querySelector('[aria-haspopup="listbox"]')!);
  const list = document.querySelector<HTMLElement>('[role="listbox"]');
  expect(list).not.toBeNull();
  expect(dialog.contains(list)).toBe(true);
 });

 it("弹窗里打开：焦点进入列表，Esc 只收起列表，再按 Esc 才关弹窗", () => {
  const onClose = vi.fn();
  act(() => root.render(<InstallDialog onClose={onClose} />));
  const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!;
  act(() => { trigger.focus(); trigger.click(); });
  const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
  expect(list.contains(document.activeElement)).toBe(true);

  pressEscape();
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(onClose).not.toHaveBeenCalled();

  pressEscape();
  expect(onClose).toHaveBeenCalledTimes(1);
 });

 it("没有弹窗时仍挂 body（设置页行内用法不变）", () => {
  function Page() {
   const [value, setValue] = useState(CHOICES[0].value);
   return <EnumSelect label="项目" value={value} choices={CHOICES} onPick={setValue} />;
  }
  act(() => root.render(<Page />));
  click(container.querySelector('[aria-haspopup="listbox"]')!);
  const list = document.querySelector<HTMLElement>('[role="listbox"]');
  expect(list).not.toBeNull();
  expect(list!.closest('[role="dialog"]')).toBeNull();
 });
});
