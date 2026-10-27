// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogShell } from "./DialogShell";
import { ConfirmDialog } from "../ConfirmDialog";
import { useDropdown } from "../../lib/useDropdown";

/**
 * DialogShell 的焦点契约（用户实测 bug 的回归测试）：「输入一下输入框就失焦，焦点跑到整个弹窗上」。
 *
 * 根因是依赖不稳的挂载 effect：调用方给的都是内联 `onClose`（每次渲染都是新函数），
 * 一旦把它放进 effect 依赖，输入框每敲一个字 → 父级 state 更新 → 新 `onClose` → effect 重跑 →
 * `cardRef.focus()` 把焦点从输入框抢回卡片。
 */

/** React 19 的 `act` 要求显式声明测试环境，否则每次调用都打警告。 */
const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

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

/** 真实用法形态：弹窗里有个输入框，`onClose` 由调用方内联给出（每次渲染新函数）。 */
function dialog(onClose: () => void) {
 return (
  <DialogShell title="标题" onClose={onClose} width="max-w-2xl">
   <input aria-label="field" />
  </DialogShell>
 );
}

function pressKey(key: string, shiftKey = false) {
 act(() => {
  (document.activeElement ?? document).dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
 });
}

function DropdownExample({ onClose }: { onClose: () => void }) {
 const [open, setOpen] = useState(false);
 const ref = useDropdown(open, () => {
  onClose();
  setOpen(false);
 });
 return (
  <>
   <button data-open onClick={() => setOpen(true)}>选择</button>
   {open && <div ref={ref}><input aria-label="搜索" /><button data-option>候选</button></div>}
  </>
 );
}

describe("DialogShell 焦点", () => {
 it("挂载时焦点落在卡片上", () => {
  act(() => {
   root.render(dialog(() => { }));
  });
  expect(document.activeElement?.getAttribute("role")).toBe("dialog");
 });

 it("重渲染（调用方换新的 onClose）不抢走输入框焦点", () => {
  act(() => {
   root.render(dialog(() => { }));
  });
  const field = container.querySelector("input");
  if (!field) throw new Error("输入框没渲染出来");
  act(() => field.focus());
  expect(document.activeElement).toBe(field);

  // 模拟「敲一个字符 → 父级 state 更新 → 传给弹窗的 onClose 是新函数」
  act(() => {
   root.render(dialog(() => { }));
  });
  expect(document.activeElement).toBe(field);
 });

 it("Esc 触发重渲染后的最新 onClose", () => {
  const first = vi.fn();
  const second = vi.fn();
  act(() => {
   root.render(dialog(first));
  });
  act(() => {
   root.render(dialog(second));
  });
  act(() => {
   document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(second).toHaveBeenCalledTimes(1);
  expect(first).not.toHaveBeenCalled();
 });

 it("Tab 只循环可见且启用的控件，Shift+Tab 不越出弹窗", () => {
  act(() => root.render(
   <DialogShell title="选择" onClose={() => { }}>
    <input aria-label="搜索" />
    <button disabled>不可用</button>
    <div hidden><button>隐藏</button></div>
   </DialogShell>,
  ));
  const close = container.querySelector("button")!;
  const field = container.querySelector("input")!;
  act(() => field.focus());
  pressKey("Tab");
  expect(document.activeElement).toBe(close);
  pressKey("Tab", true);
  expect(document.activeElement).toBe(field);
 });

 it("嵌套确认只消费一次 Esc，取消后返回父弹窗触发项", () => {
  const close = vi.fn();
  function Nested() {
   const [confirm, setConfirm] = useState(false);
   return (
    <>
     <DialogShell title="会话" onClose={close}>
      <button data-delete onClick={() => setConfirm(true)}>删除</button>
     </DialogShell>
     <ConfirmDialog open={confirm} title="删除？" danger onConfirm={() => { }} onCancel={() => setConfirm(false)} />
    </>
   );
  }
  act(() => root.render(<Nested />));
  const trigger = container.querySelector<HTMLButtonElement>("[data-delete]")!;
  act(() => { trigger.focus(); trigger.click(); });
  pressKey("Escape");
  expect(close).not.toHaveBeenCalled();
  expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(document.activeElement).toBe(trigger);
  pressKey("Escape");
  expect(close).toHaveBeenCalledTimes(1);
 });

 it("隐藏保活的弹窗不抢焦点也不消费 Esc", () => {
  const close = vi.fn();
  act(() => root.render(<button data-outside>终端</button>));
  const outside = container.querySelector<HTMLButtonElement>("[data-outside]")!;
  act(() => outside.focus());
  act(() => root.render(<><button data-outside>终端</button><div hidden>{dialog(close)}</div></>));
  expect(document.activeElement).toBe(outside);
  pressKey("Escape");
  expect(close).not.toHaveBeenCalled();
 });

 it("内部已处理的 Esc 不关闭弹窗", () => {
  const close = vi.fn();
  act(() => root.render(
   <DialogShell title="编辑" onClose={close}>
    <input onKeyDown={(event) => { if (event.key === "Escape") event.preventDefault(); }} />
   </DialogShell>,
  ));
  act(() => container.querySelector("input")!.focus());
  pressKey("Escape");
  expect(close).not.toHaveBeenCalled();
 });

 it("下拉重渲染不重置焦点，Esc 使用最新回调并返回触发项", () => {
  const first = vi.fn();
  const latest = vi.fn();
  act(() => root.render(<DropdownExample onClose={first} />));
  const trigger = container.querySelector<HTMLButtonElement>("[data-open]")!;
  act(() => { trigger.focus(); trigger.click(); });
  const option = container.querySelector<HTMLButtonElement>("[data-option]")!;
  act(() => option.focus());
  act(() => root.render(<DropdownExample onClose={latest} />));
  expect(document.activeElement).toBe(option);
  pressKey("Escape");
  expect(latest).toHaveBeenCalledTimes(1);
  expect(first).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
 });

 it("在已打开的弹窗内再开下拉，Esc 先收起下拉", () => {
  const close = vi.fn();
  act(() => root.render(<DialogShell title="编辑" onClose={close}><DropdownExample onClose={() => { }} /></DialogShell>));
  const trigger = container.querySelector<HTMLButtonElement>("[data-open]")!;
  act(() => { trigger.focus(); trigger.click(); });
  pressKey("Escape");
  expect(container.querySelector("input")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(close).not.toHaveBeenCalled();
  pressKey("Escape");
  expect(close).toHaveBeenCalledTimes(1);
 });

 it("带 autoFocus 的新挂载下拉仍返回真正的触发项", () => {
  function Popup({ onClose }: { onClose: () => void }) {
   const ref = useDropdown(true, onClose);
   return <div ref={ref}><input autoFocus aria-label="分支" /></div>;
  }
  function Example() {
   const [open, setOpen] = useState(false);
   return <><button onClick={() => setOpen(true)}>新建 worktree</button>{open && <Popup onClose={() => setOpen(false)} />}</>;
  }
  act(() => root.render(<Example />));
  const trigger = container.querySelector("button")!;
  act(() => { trigger.focus(); trigger.click(); });
  expect(document.activeElement).toBe(container.querySelector("input"));
  pressKey("Escape");
  expect(document.activeElement).toBe(trigger);
 });
});
