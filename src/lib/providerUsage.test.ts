import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderUsage, ProviderUsageReport, UsageLimit } from "@shared/types";
import { fmt, TEXT, type Text } from "./locale";
import {
 disabledCredentialsToWarn,
 fmtAmount,
 fmtPercent,
 formatAgo,
 formatDuration,
 groupReports,
 hasBar,
 latestFetchedAt,
 levelOf,
 limitReading,
 providersWithoutUsage,
 remainingText,
 usedLimitText,
 windowNames,
 type ProviderUsageSnapshot,
} from "./providerUsage";

/** 造一个窗口（只写关心的字段，其余给中性值）。 */
const limit = (over: Partial<UsageLimit> = {}): UsageLimit => ({
 id: "rolling-5h",
 label: "5 Hour limit",
 windowId: "5h",
 windowLabel: "5 Hour",
 usedFraction: 0.5,
 percent: 50,
 status: "ok",
 resetsAt: null,
 durationMs: 18_000_000,
 notes: [],
 used: null,
 limit: null,
 remaining: null,
 unit: "percent",
 ...over,
});

const report = (provider: string, over: Partial<ProviderUsageReport> = {}): ProviderUsageReport => ({
 provider,
 planType: null,
 accountLabel: null,
 fetchedAt: 1000,
 limits: [],
 ...over,
});

const usage = (over: Partial<ProviderUsage> = {}): ProviderUsage => ({
 generatedAt: 2000,
 reports: [],
 accountsWithoutUsage: [],
 disabledCredentials: [],
 configuredProviders: [],
 extraFailures: [],
 ...over,
});

describe("groupReports", () => {
 it("按 provider 分组且保持上游顺序（同 provider 的多账号合并成一组）", () => {
  const groups = groupReports([
   report("opencode-go", { accountLabel: "a" }),
   report("anthropic"),
   report("opencode-go", { accountLabel: "b" }),
  ]);
  expect(groups.map((g) => g.provider)).toEqual(["opencode-go", "anthropic"]);
  expect(groups[0].reports.map((r) => r.accountLabel)).toEqual(["a", "b"]);
  expect(groups[1].reports).toHaveLength(1);
 });
});

describe("levelOf", () => {
 it("按比例分档：<80% 充足、≥80% 警告、≥100% 用尽", () => {
  expect(levelOf(limit({ usedFraction: 0.5 }))).toBe("ok");
  expect(levelOf(limit({ usedFraction: 0.79 }))).toBe("ok");
  expect(levelOf(limit({ usedFraction: 0.8 }))).toBe("warn");
  expect(levelOf(limit({ usedFraction: 1 }))).toBe("danger");
  expect(levelOf(limit({ usedFraction: 1.2, percent: 120 }))).toBe("danger");
 });
 it("上游 status 优先：exhausted 直接红、warning 直接黄（即使比例没到阈值）", () => {
  expect(levelOf(limit({ status: "exhausted", usedFraction: 0.3 }))).toBe("danger");
  expect(levelOf(limit({ status: "warning", usedFraction: 0.1 }))).toBe("warn");
 });
});

describe("latestFetchedAt", () => {
 it("取各报告里最新的抓取时刻；没有报告或全为 0 时给 null", () => {
  expect(latestFetchedAt(usage({ reports: [report("a", { fetchedAt: 100 }), report("b", { fetchedAt: 900 })] }))).toBe(900);
  expect(latestFetchedAt(usage())).toBeNull();
  expect(latestFetchedAt(null)).toBeNull();
 });
});

describe("providersWithoutUsage", () => {
 it("configured − reports（保持字母序）；没有模型目录数据时为空", () => {
  const u = usage({
   reports: [report("opencode-go")],
   configuredProviders: ["anthropic", "commandcode", "opencode-go"],
  });
  expect(providersWithoutUsage(u)).toEqual(["anthropic", "commandcode"]);
  expect(providersWithoutUsage(usage({ configuredProviders: [] }))).toEqual([]);
  expect(providersWithoutUsage(null)).toEqual([]);
 });
 it("补充探针失败的供应商不算「无用量数据」（它们走「查询失败」块）", () => {
  const u = usage({
   reports: [report("opencode-go")],
   configuredProviders: ["commandcode", "opencode-go"],
   extraFailures: [{ provider: "commandcode", message: "HTTP 401" }],
  });
  expect(providersWithoutUsage(u)).toEqual([]);
 });
 it("停用凭据的供应商也不算「无用量数据」（它们走「已停用的凭据」块）", () => {
  const u = usage({
   configuredProviders: ["opencode-go", "zai"],
   disabledCredentials: [
    { provider: "zai", kind: "oauth", email: "old@example.com", accountId: null, cause: "refresh failed", disabledAtMs: 1 },
   ],
  });
  expect(providersWithoutUsage(u)).toEqual(["opencode-go"]);
 });
});

describe("disabledCredentialsToWarn", () => {
 it("用户主动动作的墓碑不提示（登出 / 删除 / 被替换，含大小写差异），其余照常提示", () => {
  const u = usage({
   disabledCredentials: [
    { provider: "cursor", kind: "oauth", email: null, accountId: "acc-1", cause: "logged out by user", disabledAtMs: 1 },
    { provider: "openai-codex", kind: "oauth", email: "me@example.com", accountId: null, cause: "Deleted by user", disabledAtMs: 2 },
    { provider: "zai", kind: "oauth", email: null, accountId: null, cause: "replaced by newer credential", disabledAtMs: 3 },
    { provider: "anthropic", kind: "oauth", email: "me@example.com", accountId: null, cause: "oauth refresh failed: invalid_grant", disabledAtMs: 4 },
    { provider: "windsurf", kind: "oauth", email: null, accountId: null, cause: null, disabledAtMs: 5 },
   ],
  });
  expect(disabledCredentialsToWarn(u).map((d) => d.provider)).toEqual(["anthropic", "windsurf"]);
  expect(disabledCredentialsToWarn(null)).toEqual([]);
 });
});

describe("fmtPercent", () => {
 it("≥10% 取整，小比例留一位小数", () => {
  expect(fmtPercent(50)).toBe("50%");
  expect(fmtPercent(8.04)).toBe("8.0%");
  expect(fmtPercent(9.55)).toBe("9.6%");
  expect(fmtPercent(100)).toBe("100%");
  expect(fmtPercent(120.4)).toBe("120%");
 });
});

describe("金额窗口与余额窗口", () => {
 it("fmtAmount：已知货币走符号 + 两位小数；其它单位「数字 + 单位」", () => {
  expect(fmtAmount("usd", 14)).toBe("$14.00");
  expect(fmtAmount("USD", 0.306)).toBe("$0.31");
  expect(fmtAmount("cny", 110)).toBe("¥110.00");
  expect(fmtAmount("credits", 3)).toBe("3 credits");
  expect(fmtAmount("tokens", 1234.5)).toBe("1234.50 tokens");
 });
 it("usedLimitText / remainingText / hasBar：金额窗口、余额窗口、百分比窗口各走各的", () => {
  const money = limit({ used: 0.306, limit: 14, remaining: 13.69, unit: "usd", usedFraction: 0.0219, percent: 2.19 });
  expect(usedLimitText(money)).toBe("$0.31 / $14.00");
  expect(remainingText(money)).toBeNull();
  expect(hasBar(money)).toBe(true);

  // 同单位只写一次（commandcode 的 credits 月度窗口）
  const credits = limit({ id: "monthly", windowId: "monthly", used: 64.639, limit: 70, remaining: 5.361, unit: "credits", usedFraction: 0.9234, percent: 92.34 });
  expect(usedLimitText(credits)).toBe("64.64 / 70 credits");
  expect(hasBar(credits)).toBe(true);

  const balance = limit({ id: "balance-cny", windowId: "balance", used: null, limit: null, remaining: 110, unit: "cny" });
  expect(usedLimitText(balance)).toBeNull();
  expect(remainingText(balance)).toBe("¥110.00");
  expect(hasBar(balance), "余额没有比例，不画条").toBe(false);

  const percent = limit();
  expect(usedLimitText(percent)).toBeNull();
  expect(remainingText(percent)).toBeNull();
  expect(hasBar(percent), "百分比窗口照旧画条").toBe(true);
 });
});

describe("limitReading（输入卡浮层与设置页卡片共用的读数口径）", () => {
 const t = TEXT["zh-CN"] as unknown as Text;
 it("百分比窗口：读数 = 百分比 + 画条，悬停给「状态 · 已用/上限」", () => {
  const r = limitReading(t, limit({ usedFraction: 0.9, percent: 90, status: "warning" }));
  expect(r).toEqual({
   bar: true,
   text: "90%",
   state: TEXT["zh-CN"].pusageStateWarn,
   level: "warn",
   title: TEXT["zh-CN"].pusageStateWarn,
  });
  const money = limitReading(t, limit({ used: 0.306, limit: 14, remaining: 13.69, unit: "usd", usedFraction: 0.0219, percent: 2.19 }));
  expect(money.title).toBe(`${TEXT["zh-CN"].pusageStateOk} · $0.31 / $14.00`);
 });

 it("余额窗口（deepseek 的 api 余额那种）：读数 = 金额，不画条、不显示 0.0%", () => {
  const r = limitReading(t, limit({ id: "balance", windowId: "balance", used: null, limit: null, remaining: 54.77, unit: "usd", usedFraction: 0, percent: 0 }));
  expect(r.bar).toBe(false);
  expect(r.text).toBe(fmt(TEXT["zh-CN"].pusageRemaining, "$54.77"));
  expect(r.text).not.toContain("0.0%");
 });

 it("计数型窗口：给数量原文；一无所有时给「—」，绝不编造 0.0%", () => {
  const count = limitReading(t, limit({ unit: "requests", used: 12, limit: null, remaining: null, usedFraction: 0, percent: 0 }));
  expect(count.text).toBe("12 requests");
  const nothing = limitReading(t, limit({ unit: "", used: null, limit: null, remaining: null, usedFraction: 0, percent: 0 }));
  expect(nothing.bar).toBe(false);
  expect(nothing.text).toBe("—");
 });
});

describe("相对时间文案", () => {
 it("formatDuration：分钟 / 小时+分 / 天+小时，负数与不足一分钟都钳到「不到 1 分钟」", () => {
  expect(formatDuration(30_000, "zh-CN")).toBe("不到 1 分钟");
  expect(formatDuration(-5000, "zh-CN")).toBe("不到 1 分钟");
  expect(formatDuration(5 * 60_000, "zh-CN")).toBe("5 分钟");
  expect(formatDuration(90 * 60_000, "zh-CN")).toBe("1 小时 30 分");
  expect(formatDuration(2 * 3_600_000, "zh-CN")).toBe("2 小时");
  expect(formatDuration(50 * 3_600_000, "zh-CN")).toBe("2 天 2 小时");
  expect(formatDuration(48 * 3_600_000, "zh-CN")).toBe("2 天");
  expect(formatDuration(90 * 60_000, "en")).toBe("1h 30m");
  expect(formatDuration(48 * 3_600_000, "en")).toBe("2d");
 });
 it("formatAgo：中文「N前」、英文 «N ago»", () => {
  expect(formatAgo(5 * 60_000, "zh-CN")).toBe("5 分钟前");
  expect(formatAgo(5 * 60_000, "en")).toBe("5m ago");
 });
});

describe("windowNames", () => {
 const t = TEXT["zh-CN"];

 it("通用窗口走字典（5 小时 / 每周 / 每月 / 余额 / 已消费）", () => {
  const limits = [
   limit({ id: "rolling-5h", label: "5 Hour limit", windowId: "5h", windowLabel: "5 Hour" }),
   limit({ id: "weekly", label: "Weekly limit", windowId: "7d", windowLabel: "Weekly" }),
   limit({ id: "monthly", label: "Monthly limit", windowId: "monthly", windowLabel: "Monthly" }),
   limit({ id: "balance", label: "Balance", windowId: "balance", windowLabel: "Balance" }),
   limit({ id: "spent", label: "Spent", windowId: "spent", windowLabel: "Spent" }),
  ];
  expect(windowNames(t, limits)).toEqual([
   t.pusageWindow5h,
   t.pusageWindow7d,
   t.pusageWindowMonthly,
   t.pusageWindowBalance,
   t.pusageWindowSpent,
  ]);
 });

 it("同一 windowId 挂多个池子时用上游 label 区分（omp 给 cursor 的三个 monthly 池子）", () => {
  const limits = [
   limit({ id: "cursor:requests:gpt-4", label: "gpt-4 requests", windowId: "monthly", windowLabel: "Monthly" }),
   limit({ id: "cursor:usd:individual-auto", label: "Cursor Models", windowId: "monthly", windowLabel: "Monthly" }),
   limit({ id: "cursor:usd:individual-api", label: "Other Models", windowId: "monthly", windowLabel: "Monthly" }),
  ];
  expect(windowNames(t, limits)).toEqual(["gpt-4 requests", "Cursor Models", "Other Models"]);
 });

 it("重复但上游也没给具体名（label = windowLabel）回退字典；未知 windowId 回退上游 windowLabel 再 label", () => {
  const limits = [
   limit({ id: "a", label: "Monthly", windowId: "monthly", windowLabel: "Monthly" }),
   limit({ id: "b", label: "Monthly", windowId: "monthly", windowLabel: "Monthly" }),
   limit({ id: "c", label: "Custom", windowId: "custom-x", windowLabel: "Custom X" }),
   limit({ id: "d", label: "Only label", windowId: "custom-y", windowLabel: "Only label" }),
  ];
  expect(windowNames(t, limits)).toEqual([t.pusageWindowMonthly, t.pusageWindowMonthly, "Custom X", "Only label"]);
 });
});

// ---------- 模块级快照（拉取 / 节流 / 单飞 / 失败保留） ----------

/** `vi.mock` 的工厂会被提升：用 `vi.hoisted` 拿一个能在用例里改行为的 mock。 */
const mock = vi.hoisted(() => ({ getProviderUsage: vi.fn() }));
vi.mock("@shared/api", () => ({ api: { getProviderUsage: mock.getProviderUsage } }));

/**
 * 每个用例拿一份全新的模块实例——模块级快照是单例，用例间必须隔离。
 * 这里刻意用动态 import 触发模块重载（vitest 的模块加载边界测试场景）：
 * 静态 import 拿到的初态会被前一个用例污染。
 */
async function freshModule() {
 vi.resetModules();
 return await import("./providerUsage");
}

const data = (over: Partial<ProviderUsage> = {}) =>
 usage({ reports: [report("opencode-go", { planType: "OpenCode Go", limits: [limit()] })], ...over });

async function snapshotOf(m: { providerUsageSnapshot: () => ProviderUsageSnapshot }) {
 return m.providerUsageSnapshot();
}

beforeEach(() => {
 mock.getProviderUsage.mockReset();
});

describe("数据层：拉取与快照", () => {
 it("首次拉取填充快照；60s 内非强制调用走缓存不再请求，force 才重拉", async () => {
  const m = await freshModule();
  mock.getProviderUsage.mockResolvedValue(data());
  await m.loadProviderUsage();
  expect(mock.getProviderUsage).toHaveBeenCalledTimes(1);
  const snap = m.providerUsageSnapshot();
  expect(snap.data?.reports[0].planType).toBe("OpenCode Go");
  expect(snap.error).toBeNull();
  expect(snap.loading).toBe(false);

  await m.loadProviderUsage();
  expect(mock.getProviderUsage).toHaveBeenCalledTimes(1);

  await m.loadProviderUsage(true);
  expect(mock.getProviderUsage).toHaveBeenCalledTimes(2);
 });

 it("失败保留上一份数据并给出错误（界面显示旧值 + 错误行，不闪空）", async () => {
  const m = await freshModule();
  mock.getProviderUsage.mockResolvedValueOnce(data());
  await m.loadProviderUsage();
  mock.getProviderUsage.mockRejectedValueOnce(new Error("读取供应商用量失败：omp 命令超时"));
  await m.loadProviderUsage(true);
  const snap = m.providerUsageSnapshot();
  expect(snap.data?.reports).toHaveLength(1);
  expect(snap.error).toContain("超时");
  expect(snap.loading).toBe(false);
 });

 it("单飞：进行中的请求被并发调用复用（force 也等它）", async () => {
  const m = await freshModule();
  let release: (v: ProviderUsage) => void = () => { };
  mock.getProviderUsage.mockImplementationOnce(
   () => new Promise<ProviderUsage>((resolve) => {
    release = resolve;
   }),
  );
  const p1 = m.loadProviderUsage();
  const p2 = m.loadProviderUsage(true);
  expect(mock.getProviderUsage).toHaveBeenCalledTimes(1);
  release(data());
  await Promise.all([p1, p2]);
  expect(mock.getProviderUsage).toHaveBeenCalledTimes(1);
  expect((await snapshotOf(m)).data?.reports).toHaveLength(1);
 });
});
