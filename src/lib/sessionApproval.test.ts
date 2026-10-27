// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Text } from "./locale";
import { TEXT } from "./locale";

/**
 * 执行模式真值（2026-10-14 收敛，见 `lib/sessionApproval.ts`）：
 * - 全局档只认 omp 的 `tools.approvalMode`，**读不到就是「未知」**（不许拿某一档冒充真值）；
 * - 启动水合覆盖层的本会话覆盖（重启应用后存量覆盖不能丢）；
 * - 菜单选择 = 写全局默认（新会话档位）+ 本会话覆盖（立即生效：idle 重启 / 运行中挂起）。
 */

const { apiMock } = vi.hoisted(() => ({
 apiMock: {
  getGlobalApproval: vi.fn(async () => "yolo"),
  setGlobalApproval: vi.fn(async (_mode: string) => undefined),
  setSessionApproval: vi.fn(async (_id: string, _mode: string | null) => undefined),
  getOverlay: vi.fn(async () => ({
   version: 1,
   projects: [],
   archived: {},
   notes: {},
   session_approval: { s1: "always-ask" },
  })),
  restartSessionRuntime: vi.fn(async (_id: string) => null),
 },
}));
vi.mock("@shared/api", () => ({ api: apiMock }));
const { restartMock } = vi.hoisted(() => ({ restartMock: vi.fn(async (_sid: string) => undefined) }));
vi.mock("./useSessionEvents", () => ({ restartRuntimeForApproval: restartMock }));

import {
 APPROVAL_CYCLE,
 applyApproval,
 approvalName,
 cycleSessionApproval,
 ensureGlobalApproval,
 loadApprovalState,
} from "./sessionApproval";
import { useApp } from "../stores/app";

beforeEach(() => {
 vi.clearAllMocks();
 useApp.setState({ globalApproval: null, sessionApprovals: {}, statusBySession: {}, approvalRestartBySession: {} });
});

describe("执行模式真值", () => {
 it("全局档没读到就是「未知」，不用某一档兜底", async () => {
  apiMock.getGlobalApproval.mockRejectedValueOnce(new Error("omp 不在"));
  expect(await ensureGlobalApproval()).toBeNull();
  expect(useApp.getState().globalApproval).toBeNull();
  // 读失败不写假值；下一次调用自然重试并落真值
  expect(await ensureGlobalApproval()).toBe("yolo");
  expect(useApp.getState().globalApproval).toBe("yolo");
 });

 it("并发读单飞：同时发起只起一次子进程", async () => {
  const [a, b] = await Promise.all([ensureGlobalApproval(), ensureGlobalApproval()]);
  expect([a, b]).toEqual(["yolo", "yolo"]);
  expect(apiMock.getGlobalApproval).toHaveBeenCalledTimes(1);
  // 已有值直接命中，不再读
  expect(await ensureGlobalApproval()).toBe("yolo");
  expect(apiMock.getGlobalApproval).toHaveBeenCalledTimes(1);
 });

 it("启动水合：覆盖层的本会话覆盖（snake_case）+ 全局默认档各就各位", async () => {
  await loadApprovalState();
  expect(useApp.getState().sessionApprovals).toEqual({ s1: "always-ask" });
  expect(useApp.getState().globalApproval).toBe("yolo");
 });

 it("菜单选择：写全局默认（新会话档位）+ 本会话覆盖（本会话立即生效）", async () => {
  useApp.setState({ statusBySession: {} });
  expect(await applyApproval("s1", "write")).toBe(true);
  expect(apiMock.setGlobalApproval).toHaveBeenCalledWith("write");
  expect(apiMock.setSessionApproval).toHaveBeenCalledWith("s1", "write");
  expect(useApp.getState().globalApproval).toBe("write");
  expect(useApp.getState().sessionApprovals.s1).toBe("write");
  // idle：立刻重启 runtime 换档
  expect(restartMock).toHaveBeenCalledWith("s1");
  expect(useApp.getState().approvalRestartBySession.s1).toBeUndefined();
 });

 it("菜单选择：运行中挂起到本轮结束（不打断进行中的轮次）", async () => {
  useApp.setState({ statusBySession: { s1: { state: "running" } } });
  await applyApproval("s1", "yolo");
  expect(useApp.getState().approvalRestartBySession.s1).toBe(true);
  expect(restartMock).not.toHaveBeenCalled();
 });

 it("空态（还没有会话）只改全局默认，不写会话覆盖", async () => {
  await applyApproval(null, "always-ask");
  expect(apiMock.setGlobalApproval).toHaveBeenCalledWith("always-ask");
  expect(apiMock.setSessionApproval).not.toHaveBeenCalled();
  expect(useApp.getState().sessionApprovals).toEqual({});
 });

 it("写失败：不假装切了（档位与 store 都保持原样）", async () => {
  useApp.setState({ globalApproval: "yolo" });
  apiMock.setGlobalApproval.mockRejectedValueOnce(new Error("写配置失败"));
  expect(await applyApproval("s1", "write")).toBe(false);
  expect(useApp.getState().globalApproval).toBe("yolo");
  expect(useApp.getState().sessionApprovals.s1).toBeUndefined();
  expect(restartMock).not.toHaveBeenCalled();
 });

 it("Shift+Tab 循环：从生效档（覆盖优先）走一档，只动本会话覆盖", async () => {
  useApp.setState({ globalApproval: "yolo" });
  expect(await cycleSessionApproval("s1")).toBe(APPROVAL_CYCLE[0]); // 未知档位从第一档起步
  expect(apiMock.setGlobalApproval).not.toHaveBeenCalled();
  useApp.setState({ sessionApprovals: { s1: "write" } });
  expect(await cycleSessionApproval("s1")).toBe("yolo");
  expect(useApp.getState().sessionApprovals.s1).toBe("yolo");
  expect(restartMock).toHaveBeenCalledWith("s1");
 });

 it("档位名走字典（统计弹窗 / 菜单共用）；未知档位回退原文、空值给空串", () => {
  const t = TEXT["zh-CN"] as unknown as Text;
  expect(approvalName(t, "yolo")).toBe(TEXT["zh-CN"].permYolo);
  expect(approvalName(t, "write")).toBe(TEXT["zh-CN"].permWrite);
  expect(approvalName(t, "always-ask")).toBe(TEXT["zh-CN"].permAlwaysAsk);
  expect(approvalName(t, "weird")).toBe("weird");
  expect(approvalName(t, null)).toBe("");
 });
});
