import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLiveStats } from "@shared/types";
import { TEXT } from "./locale";
import {
 LIVE_STATS_FRESH_MS,
 __resetSessionLiveStats,
 fmtHitRate,
 fmtSpan,
 fmtTps,
 liveStatsReadable,
 liveStatsSnapshot,
 liveTokensReadable,
 loadSessionLiveStats,
} from "./sessionLiveStats";

/**
 * 会话累计统计条的数据层与展示口径：
 * 快照（按会话 id 归属 / 单飞 / 失败保留旧值 / 新鲜度节流）与三处格式化（与 DH 同规矩）。
 */
const mock = vi.hoisted(() => ({ getSessionLiveStats: vi.fn() }));
vi.mock("@shared/api", () => ({ api: { getSessionLiveStats: mock.getSessionLiveStats } }));

const zh = TEXT["zh-CN"];
const en = TEXT.en;

const stats = (over: Partial<SessionLiveStats> = {}): SessionLiveStats => ({
 turns: 1,
 steps: 2,
 toolCalls: 3,
 modelMs: 1000,
 toolMs: 0,
 ttftMs: null,
 decodeMs: 0,
 tps: null,
 tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2, calls: 1 },
 cacheHitRate: null,
 cost: 0,
 startedAt: null,
 lastAt: null,
 truncated: false,
 ...over,
});

beforeEach(() => {
 __resetSessionLiveStats();
 mock.getSessionLiveStats.mockReset();
});

describe("展示口径（与 DH 同规矩）", () => {
 it("时长：<1 分钟给一位小数的秒，其后「N 分 N 秒」/「N 小时 N 分」", () => {
  expect(fmtSpan(2400, zh)).toBe("2.4 秒");
  expect(fmtSpan(45_200, zh)).toBe("45.2 秒");
  expect(fmtSpan(162_000, zh)).toBe("2 分 42 秒");
  expect(fmtSpan(3_780_000, zh)).toBe("1 小时 3 分");
  expect(fmtSpan(-5, zh)).toBe("0.0 秒");
  expect(fmtSpan(2400, en)).toBe("2.4s");
  expect(fmtSpan(162_000, en)).toBe("2m 42s");
 });

 it("吞吐：≥10 取整、<10 留一位小数；命中率取整数百分比", () => {
  expect(fmtTps(230.4)).toBe("230");
  expect(fmtTps(2.44)).toBe("2.4");
  expect(fmtHitRate(62_804_864 / 63_330_854)).toBe("99%");
  expect(fmtHitRate(1)).toBe("100%");
 });

 it("露面门槛：没有步也没有 token 就不显示；读不全时整块不显示", () => {
  expect(liveStatsReadable(stats())).toBe(true);
  expect(liveStatsReadable(stats({ steps: 0, tokens: { ...stats().tokens, total: 0 } }))).toBe(false);
  expect(liveStatsReadable(stats({ steps: 0 }))).toBe(true); // 有 token 也显示（与 DH 的 hasTokens 同口径）
  expect(liveStatsReadable(stats({ truncated: true }))).toBe(false);
  expect(liveStatsReadable(null)).toBe(false);
  expect(liveTokensReadable(stats({ steps: 0 }))).toBe(true);
  expect(liveTokensReadable(stats({ tokens: { ...stats().tokens, input: 0, output: 0 } }))).toBe(false);
 });

 it("字典中英同键：模板占位数量一致（漏键 / 漏占位由单测兜住）", () => {
  for (const key of ["liveStatsTurns", "liveStatsRoundsSummary", "liveStatsTokensInline", "liveStatsCacheHitInline", "spanMinSec", "spanHourMin"] as const) {
   expect(zh[key].match(/\{\d\}/g) ?? []).toEqual(en[key].match(/\{\d\}/g) ?? []);
  }
 });
});

describe("快照与拉取", () => {
 it("按会话 id 归属：拉到后写入对应会话，其它会话保持空", async () => {
  mock.getSessionLiveStats.mockResolvedValueOnce(stats({ turns: 7 }));
  await loadSessionLiveStats("s1", true);
  expect(liveStatsSnapshot("s1").data?.turns).toBe(7);
  expect(liveStatsSnapshot("s2").data).toBeNull();
  expect(liveStatsSnapshot(null).data).toBeNull();
 });

 it("单飞：同一会话并发拉取只发一次请求", async () => {
  mock.getSessionLiveStats.mockResolvedValue(stats());
  await Promise.all([loadSessionLiveStats("s1", true), loadSessionLiveStats("s1", true), loadSessionLiveStats("s1", true)]);
  expect(mock.getSessionLiveStats).toHaveBeenCalledTimes(1);
 });

 it("新鲜度节流：2 秒内 force=false 不重复拉，force=true 照拉", async () => {
  mock.getSessionLiveStats.mockResolvedValue(stats());
  await loadSessionLiveStats("s1");
  await loadSessionLiveStats("s1");
  expect(mock.getSessionLiveStats).toHaveBeenCalledTimes(1);
  expect(LIVE_STATS_FRESH_MS).toBeGreaterThan(0);
  await loadSessionLiveStats("s1", true);
  expect(mock.getSessionLiveStats).toHaveBeenCalledTimes(2);
 });

 it("失败保留旧值并记一行错误（不闪空）", async () => {
  mock.getSessionLiveStats.mockResolvedValueOnce(stats({ turns: 3 }));
  await loadSessionLiveStats("s1", true);
  mock.getSessionLiveStats.mockRejectedValueOnce(new Error("找不到会话文件：s1"));
  await loadSessionLiveStats("s1", true);
  const snap = liveStatsSnapshot("s1");
  expect(snap.data?.turns).toBe(3);
  expect(snap.error).toContain("找不到会话文件");
 });
});
