// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/** omp 默认思考档读取（`lib/thinkingDefault.ts`）：单飞 + 读失败不写假值 + 已有值命中缓存。 */
const { apiMock } = vi.hoisted(() => ({
 apiMock: { getDefaultThinkingLevel: vi.fn(async () => "max" as string | null) },
}));
vi.mock("@shared/api", () => ({ api: apiMock }));

import { useApp } from "../stores/app";
import { ensureOmpDefaultThinking } from "./thinkingDefault";

beforeEach(() => {
 vi.clearAllMocks();
 useApp.setState({ ompDefaultThinking: null });
});

describe("omp 默认思考档", () => {
 it("读到的值落 store；已有值直接命中，不再起进程", async () => {
  expect(await ensureOmpDefaultThinking()).toBe("max");
  expect(useApp.getState().ompDefaultThinking).toBe("max");
  expect(await ensureOmpDefaultThinking()).toBe("max");
  expect(apiMock.getDefaultThinkingLevel).toHaveBeenCalledTimes(1);
 });

 it("读失败不写假值（显示层退回最高档兜底），下一次调用自然重试", async () => {
  apiMock.getDefaultThinkingLevel.mockRejectedValueOnce(new Error("omp 不在"));
  expect(await ensureOmpDefaultThinking()).toBeNull();
  expect(useApp.getState().ompDefaultThinking).toBeNull();
  expect(await ensureOmpDefaultThinking()).toBe("max");
  expect(useApp.getState().ompDefaultThinking).toBe("max");
 });

 it("并发读单飞；force 强制重读（配置可能被别处改过）", async () => {
  const [a, b] = await Promise.all([ensureOmpDefaultThinking(), ensureOmpDefaultThinking()]);
  expect([a, b]).toEqual(["max", "max"]);
  expect(apiMock.getDefaultThinkingLevel).toHaveBeenCalledTimes(1);
  await ensureOmpDefaultThinking(true);
  expect(apiMock.getDefaultThinkingLevel).toHaveBeenCalledTimes(2);
 });
});
