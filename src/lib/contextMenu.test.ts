// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

describe("installNativeContextMenuOff（全 app 禁用原生右键菜单）", () => {
 it("幂等安装一次监听；安装后 document 上的右键事件被吞掉", async () => {
  // 动态 import：要先 `vi.resetModules()` 拿到「没安装过」的新模块实例——静态 import 拿到的是
  // 已缓存的同一实例（它的 `installed` 可能已被本文件其他用例置位），测不出刚安装那一刻。
  vi.resetModules();
  const mod = await import("./contextMenu");
  const spy = vi.spyOn(document, "addEventListener");
  mod.installNativeContextMenuOff();
  mod.installNativeContextMenuOff();
  const attached = spy.mock.calls.filter((call) => call[0] === "contextmenu");
  expect(attached).toHaveLength(1);
  spy.mockRestore();

  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
 });
});
