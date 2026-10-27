import { describe, expect, it } from "vitest";
import { contextPercent, fmtPercent, fmtTokens, fmtWindow } from "./ctxUsage";

describe("contextPercent", () => {
 it("omp 的 percent 就是 0–100，不做任何区间换算", () => {
  // 真机 18.2.1：28529 / 1000000 → 2.8529
  expect(contextPercent({ tokens: 28529, contextWindow: 1000000, percent: 2.8529 })).toBeCloseTo(2.8529);
 });

 it("小于 1% 的占用不被放大（历史 bug：0.9% 被显示成 90%）", () => {
  expect(contextPercent({ tokens: 900, contextWindow: 1000000, percent: 0.9 })).toBeCloseTo(0.9);
  expect(contextPercent({ tokens: 9, contextWindow: 1000, percent: null })).toBeCloseTo(0.9);
 });

 it("没有 percent 时按 omp 同式补算，窗口为 0 时给 null", () => {
  expect(contextPercent({ tokens: 25, contextWindow: 100, percent: null })).toBeCloseTo(25);
  expect(contextPercent({ tokens: 25, contextWindow: 0, percent: null })).toBeNull();
  expect(contextPercent(null)).toBeNull();
  expect(contextPercent(undefined)).toBeNull();
 });
});

describe("格式化", () => {
 it("百分比：≥10% 取整，小比例一位小数", () => {
  expect(fmtPercent(16.4)).toBe("16%");
  expect(fmtPercent(2.8529)).toBe("2.9%");
  expect(fmtPercent(0.9)).toBe("0.9%");
 });

 it("token 量纲与使用统计页一致", () => {
  expect(fmtTokens(1_000_000)).toBe("1.00M");
  expect(fmtTokens(28_529)).toBe("28.5K");
  expect(fmtTokens(1200)).toBe("1,200");
 });

 it("窗口取整档位，与模型目录角标同一写法", () => {
  expect(fmtWindow(1_000_000)).toBe("1M");
  expect(fmtWindow(200_000)).toBe("200K");
  expect(fmtWindow(0)).toBe("");
 });
});
