// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 应用更新检查的落库行为——**auto 与 manual 共用同一套结论**。
 * 回归背景（用户实测）：首次启动时应用版本 chip 恒灰——旧口径 auto 在「已是最新」时写 `idle`
 * （chip 灰点 + 文案「点击检查更新」）、失败只 console.warn 不落状态；与 omp 链路
 * （checking 转轮 → latest 绿点 / error 黄点，见 `lib/ompUpdate.ts`）不一致。
 * 现在两条链路同款：`checking` → `latest` / `available` / `error`，区别只在 auto 是否自动弹窗。
 */
const mock = vi.hoisted(() => ({
 check: vi.fn(),
 getVersion: vi.fn(async () => "0.10.0"),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mock.check }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: mock.getVersion }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => undefined) }));

/** 每个用例一份全新模块（`checking` / `pending` 是模块级状态）。动态 import 是刻意的加载边界用法。 */
async function freshModule() {
 vi.resetModules();
 const store = await import("../stores/app");
 const lib = await import("./appUpdate");
 return { lib, useApp: store.useApp };
}

const fakeUpdate = {
 version: "0.9.1",
 currentVersion: "0.10.0",
 body: "notes",
 close: async () => undefined,
 downloadAndInstall: async () => undefined,
};

beforeEach(() => {
 mock.check.mockReset();
 // `isTauri()` 要看到注入标记；DEV 关掉才走真实检查路径（vitest 默认 DEV=true）
 Object.assign(window, { __TAURI_INTERNALS__: {} });
 vi.stubEnv("DEV", false);
});

afterEach(() => {
 vi.unstubAllEnvs();
});

describe("检查结论落库（auto 与 manual 同一套）", () => {
 it("启动静默检查：无更新写 latest——chip 绿点，而不是不解释的灰", async () => {
  const { lib, useApp } = await freshModule();
  mock.check.mockResolvedValue(null);
  await expect(lib.checkForUpdate("auto")).resolves.toBe("latest");
  expect(useApp.getState().update).toEqual({ status: "latest", current: "0.10.0" });
 });

 it("发起后先落 checking（chip 转轮），等回包再落结论", async () => {
  const { lib, useApp } = await freshModule();
  // 项目目标为 ES2021，没有 Promise.withResolvers。
  let resolve!: (v: null) => void;
  mock.check.mockReturnValue(
   new Promise((r) => {
    resolve = r;
   }),
  );
  const pending = lib.checkForUpdate("auto");
  expect(useApp.getState().update).toEqual({ status: "checking" });
  resolve(null);
  await pending;
  expect(useApp.getState().update).toEqual({ status: "latest", current: "0.10.0" });
 });

 it("有新版本：写 available 并带出目标版本（auto 未「稍后」过 → 弹窗）", async () => {
  const { lib, useApp } = await freshModule();
  mock.check.mockResolvedValue(fakeUpdate);
  await expect(lib.checkForUpdate("auto")).resolves.toBe("available");
  const st = useApp.getState();
  expect(st.update).toEqual({ status: "available", version: "0.9.1", current: "0.10.0", body: "notes" });
  expect(st.updateDialogOpen).toBe(true);
 });

 it("检查失败：auto 也落 error（chip 黄点，原因进弹窗）——「还没查」与「查失败」不给同一种灰", async () => {
  const { lib, useApp } = await freshModule();
  mock.check.mockRejectedValue(new Error("network down"));
  await expect(lib.checkForUpdate("auto")).resolves.toBe("error");
  expect(useApp.getState().update).toEqual({ status: "error", message: "network down" });
 });

 it("本轮已「稍后」过的版本：状态照落，弹窗不打扰", async () => {
  const { lib, useApp } = await freshModule();
  useApp.setState({ updateDismissedVersion: "0.9.1" });
  mock.check.mockResolvedValue(fakeUpdate);
  await lib.checkForUpdate("auto");
  const st = useApp.getState();
  expect(st.update.status).toBe("available");
  expect(st.updateDialogOpen).toBe(false);
 });
});
