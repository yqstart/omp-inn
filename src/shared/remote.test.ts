// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { isRemoteClient, onRemoteUnauthorized, remoteInvoke } from "./remote";

const res = (status: number, body: unknown) =>
  Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response);

describe("remote transport", () => {
  afterEach(() => {
    delete window.__OMP_REMOTE__;
    vi.unstubAllGlobals();
  });

  it("只在移动入口标记下切换", () => {
    expect(isRemoteClient()).toBe(false);
    window.__OMP_REMOTE__ = true;
    expect(isRemoteClient()).toBe(true);
  });

  it("成功回包取 result", async () => {
    window.__OMP_REMOTE__ = true;
    vi.stubGlobal("fetch", vi.fn(() => res(200, { ok: true, result: 42 })));
    await expect(remoteInvoke<number>("x", {})).resolves.toBe(42);
  });

  it("错误回包保留 message + hint", async () => {
    window.__OMP_REMOTE__ = true;
    vi.stubGlobal("fetch", vi.fn(() => res(400, { ok: false, code: "BAD_ARG", message: "参数不合法", hint: "检查输入" })));
    await expect(remoteInvoke("x", {})).rejects.toThrow("参数不合法\n检查输入");
  });

  it("401 通知页面回到配对", async () => {
    window.__OMP_REMOTE__ = true;
    const hit = vi.fn();
    const off = onRemoteUnauthorized(hit);
    vi.stubGlobal("fetch", vi.fn(() => res(401, { ok: false, code: "UNAUTHORIZED", message: "未配对" })));
    await expect(remoteInvoke("x", {})).rejects.toThrow("未配对");
    expect(hit).toHaveBeenCalledTimes(1);
    off();
  });
});
