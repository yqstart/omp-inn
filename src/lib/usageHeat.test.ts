import { describe, expect, it } from "vitest";
import type { UsageHeatRow } from "@shared/types";
import { heatLevel, heatModels, heatThresholds, heatValues, monthTicks } from "./usageHeat";

/** 从 `start`（周日）起造一段连续日历，只关心日期。 */
function calendar(start: string, days: number): UsageHeatRow[] {
  const [y, m, d] = start.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d);
  return Array.from({ length: days }, (_, i) => ({
    date: new Date(base + i * 86_400_000).toISOString().slice(0, 10),
    total: 0,
    models: [],
  }));
}

describe("色档（GitHub 四分位口径）", () => {
  it("0 直接落 0 档，任何阈值都一样", () => {
    expect(heatLevel(0, [1, 2, 3])).toBe(0);
    expect(heatLevel(0, heatThresholds([]))).toBe(0);
  });

  it("阈值边界归入较浅一档", () => {
    const t = heatThresholds([0, 1, 2, 3, 4]);
    expect([1, 2, 3, 4, 5].map((v) => heatLevel(v, t))).toEqual([1, 2, 3, 4, 4]);
  });

  it("分位按非零值取：大量零日不把阈值拉到 0", () => {
    const t = heatThresholds([...Array(96).fill(0), 10, 20, 30, 40]);
    expect(heatLevel(10, t)).toBe(1);
    expect(heatLevel(20, t)).toBe(2);
    expect(heatLevel(40, t)).toBe(4);
  });

  it("整年没有用量时任何正数都落最浅一档", () => {
    const t = heatThresholds([0, 0, 0]);
    expect(t).toEqual([Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]);
    expect(heatLevel(1, t)).toBe(1);
  });
});

describe("三档取值", () => {
  it("每日 = 当天；每周 = 整周合计（同列同值）；累计 = 窗口起点到当天", () => {
    // 2026-09-06 是周日：前 7 格一周、后 4 格是不满一周的尾列
    const cells = calendar("2026-09-06", 11).map((c, i) => ({ ...c, total: i + 1 }));
    expect(heatValues(cells, "day")).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(heatValues(cells, "week")).toEqual([28, 28, 28, 28, 28, 28, 28, 38, 38, 38, 38]);
    expect(heatValues(cells, "cumulative")).toEqual([1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 66]);
  });

  it("三档长度都与格子对齐（不丢格、不补格）", () => {
    const cells = calendar("2025-09-14", 368);
    for (const mode of ["day", "week", "cumulative"] as const) {
      expect(heatValues(cells, mode).length, mode).toBe(cells.length);
    }
  });
});

describe("悬停明细（按模型拆分）", () => {
  const cells: UsageHeatRow[] = [
    { date: "2026-09-13", total: 30, models: [{ model: "sonnet", total: 20 }, { model: "gpt-5", total: 10 }] },
    { date: "2026-09-14", total: 5, models: [{ model: "gpt-5", total: 5 }] },
    { date: "2026-09-15", total: 7, models: [{ model: "sonnet", total: 7 }] },
    { date: "2026-09-16", total: 100, models: [{ model: "sonnet", total: 100 }] },
  ];

  it("每日 = 当天；每周 = 整周合并后按 token 降序；累计 = 起点到当天", () => {
    expect(heatModels(cells, "day", 3)).toEqual([{ model: "sonnet", total: 100 }]);
    expect(heatModels(cells, "week", 3)).toEqual([
      { model: "sonnet", total: 127 },
      { model: "gpt-5", total: 15 },
    ]);
    expect(heatModels(cells, "cumulative", 1)).toEqual([
      { model: "sonnet", total: 20 },
      { model: "gpt-5", total: 15 },
    ]);
  });

  it("没有用量的格子没有明细", () => {
    expect(heatModels(calendar("2026-09-13", 7), "day", 2)).toEqual([]);
    expect(heatModels(calendar("2026-09-13", 7), "cumulative", 6)).toEqual([]);
  });
});

describe("月份刻度", () => {
  it("在包含 1 号（或跨月）的列标月份，起点所在的月中那一列不标", () => {
    const cells = calendar("2025-09-14", 368); // 周日 → 2026-09-16（周三）
    const ticks = monthTicks(cells, "zh-CN");
    expect(ticks.map((t) => t.label)).toEqual([
      "10月", "11月", "12月", "1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月",
    ]);
    // 10 月从 2025-09-28 那一列（第 3 列）开始：窗口起点在 9 月中，那一列不标 9 月
    expect(ticks[0].col).toBe(2);
  });
});
