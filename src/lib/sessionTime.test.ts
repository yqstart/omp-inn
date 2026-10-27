import { describe, expect, it } from "vitest";
import { TEXT } from "./locale";
import { formatSessionFullTime, formatSessionTime, sessionTimeBucket } from "./sessionTime";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("会话行时间（ZCode 口径的紧凑相对时间）", () => {
  it("档位边界：<1 分钟 now / <60 分钟 minutes / <24 小时 hours / 其余 days（与 ZCode 逐档一致）", () => {
    expect(sessionTimeBucket(NOW, NOW)).toEqual({ unit: "now" });
    expect(sessionTimeBucket(NOW - 59_000, NOW)).toEqual({ unit: "now" });
    expect(sessionTimeBucket(NOW - MIN, NOW)).toEqual({ unit: "minutes", n: 1 });
    expect(sessionTimeBucket(NOW - 59 * MIN, NOW)).toEqual({ unit: "minutes", n: 59 });
    expect(sessionTimeBucket(NOW - 60 * MIN, NOW)).toEqual({ unit: "hours", n: 1 });
    expect(sessionTimeBucket(NOW - (24 * 60 - 1) * MIN, NOW)).toEqual({ unit: "hours", n: 23 });
    expect(sessionTimeBucket(NOW - DAY, NOW)).toEqual({ unit: "days", n: 1 });
    expect(sessionTimeBucket(NOW - 400 * DAY, NOW)).toEqual({ unit: "days", n: 400 });
  });

  it("未来时间戳（时钟漂移）落到 now，不出现负数", () => {
    expect(sessionTimeBucket(NOW + 5 * MIN, NOW)).toEqual({ unit: "now" });
  });

  it("文案：中文「刚刚 / 5分 / 3小时 / 2天」、英文「now / 5m / 3h / 2d」", () => {
    const zh = TEXT["zh-CN"];
    const en = TEXT.en;
    expect(formatSessionTime(NOW - 10_000, zh, NOW)).toBe("刚刚");
    expect(formatSessionTime(NOW - 5 * MIN, zh, NOW)).toBe("5分");
    expect(formatSessionTime(NOW - 3 * HOUR, zh, NOW)).toBe("3小时");
    expect(formatSessionTime(NOW - 2 * DAY, zh, NOW)).toBe("2天");
    expect(formatSessionTime(NOW - 10_000, en, NOW)).toBe("now");
    expect(formatSessionTime(NOW - 5 * MIN, en, NOW)).toBe("5m");
    expect(formatSessionTime(NOW - 3 * HOUR, en, NOW)).toBe("3h");
    expect(formatSessionTime(NOW - 2 * DAY, en, NOW)).toBe("2d");
  });

  it("悬停完整时间：含日期与分钟（绝对信息不丢）", () => {
    const ts = new Date(2026, 9, 13, 9, 12).getTime();
    const s = formatSessionFullTime(ts, "zh-CN");
    expect(s).toContain("2026");
    expect(s).toContain("10月13日");
    expect(s).toContain("09:12");
    expect(formatSessionFullTime(ts, "en")).toContain("2026");
  });
});
