// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDropdown } from "./useDropdown";

/**
 * `useDropdown` 的开合契约。
 *
 * `ignore` 是触发按钮的真实用法（`EnumSelect`）：同一次点击的 `pointerdown` 与 `click` 都会
 * 落在按钮上——若 `pointerdown` 先关、随后的 `click` 又开，按钮就永远关不掉。
 */
const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let outside: HTMLButtonElement;

beforeEach(() => {
 container = document.createElement("div");
 document.body.append(container);
 outside = document.createElement("button");
 outside.textContent = "别处";
 document.body.append(outside);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
 outside.remove();
});

/** 真实点击序列：`pointerdown` 与 `click` 都派发（jsdom 不会自己生成）。 */
function click(element: Element) {
 act(() => {
  element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
 });
}

function Example() {
 const [open, setOpen] = useState(false);
 const triggerRef = useRef<HTMLButtonElement>(null);
 const ref = useDropdown(open, () => setOpen(false), triggerRef);
 return (
  <>
   <button ref={triggerRef} onClick={() => setOpen((v) => !v)}>触发</button>
   {open && <div ref={ref}><button data-option>候选</button></div>}
  </>
 );
}

describe("useDropdown 开合", () => {
 it("触发按钮自己开关：点一下开、再点一下关", () => {
  act(() => root.render(<Example />));
  const trigger = container.querySelector("button")!;
  click(trigger);
  expect(container.querySelector("[data-option]")).not.toBeNull();
  click(trigger);
  expect(container.querySelector("[data-option]")).toBeNull();
 });

 it("点浮层外部关闭", () => {
  act(() => root.render(<Example />));
  click(container.querySelector("button")!);
  expect(container.querySelector("[data-option]")).not.toBeNull();
  click(outside);
  expect(container.querySelector("[data-option]")).toBeNull();
 });
});
