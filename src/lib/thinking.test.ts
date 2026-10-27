import { describe, expect, it } from "vitest";
import { clampThinking, resolveThinking, thinkingLevelsOf, THINKING_ORDER } from "./thinking";

// efforts 取自 `omp models --json` 实测值（omp 18.1.22）
const OPUS5 = ["low", "medium", "high", "xhigh", "max"]; // Claude Opus 5
const GEMINI = ["low", "medium", "high"]; // google/gemini-3.5-flash
const DEEPSEEK_PRO = ["low", "high", "max"]; // deepseek-v4-pro（跳过 medium/xhigh）

describe("thinkingLevelsOf", () => {
  it("off 恒定在首位（omp 的 efforts 不含 off，但 off 可生效）", () => {
    expect(thinkingLevelsOf(OPUS5)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
    expect(thinkingLevelsOf(null)).toEqual(["off"]);
    expect(thinkingLevelsOf([])).toEqual(["off"]);
  });
  it("按强度序而非数组顺序排列", () => {
    expect(thinkingLevelsOf(["max", "low", "high"])).toEqual(["off", "low", "high", "max"]);
  });
  it("忽略未知档（含 auto：omp 会解析成具体档，不保留）", () => {
    expect(thinkingLevelsOf(["low", "bogus", "auto"])).toEqual(["off", "low"]);
  });
  it("全集序恒定（用于下拉渲染顺序）", () => {
    expect(THINKING_ORDER[0]).toBe("off");
    expect(THINKING_ORDER[THINKING_ORDER.length - 1]).toBe("max");
  });
});

describe("clampThinking（omp 默认档夹到模型支持集）", () => {
  it("配置默认档被该模型支持 → 原样", () => {
    expect(clampThinking("medium", OPUS5)).toBe("medium");
    expect(clampThinking("off", OPUS5)).toBe("off"); // off 恒定合法
  });
  it("配置默认档不被支持 / 没读到 / auto → 退回该模型最高档", () => {
    expect(clampThinking("max", GEMINI)).toBe("high");
    expect(clampThinking(null, OPUS5)).toBe("max");
    expect(clampThinking(undefined, DEEPSEEK_PRO)).toBe("max");
    expect(clampThinking("auto", OPUS5)).toBe("max");
    expect(clampThinking("medium", null)).toBe("off"); // 不支持思考
  });
});

describe("resolveThinking（fallback = omp 配置的默认档）", () => {
  it("真值合法即原样采用，不纠正", () => {
    expect(resolveThinking(OPUS5, "xhigh", "medium")).toEqual({ level: "xhigh", shouldSync: false });
    expect(resolveThinking(OPUS5, "off")).toEqual({ level: "off", shouldSync: false });
  });
  it("真值缺失（切模型后 omp 丢档）→ 落 omp 配置的默认档并纠正", () => {
    expect(resolveThinking(OPUS5, null, "medium")).toEqual({ level: "medium", shouldSync: true });
    expect(resolveThinking(GEMINI, undefined, "max")).toEqual({ level: "high", shouldSync: true });
  });
  it("没有配置默认档（没读到）→ 最高档兜底（旧口径不变）", () => {
    expect(resolveThinking(OPUS5, null)).toEqual({ level: "max", shouldSync: true });
    expect(resolveThinking(GEMINI, undefined)).toEqual({ level: "high", shouldSync: true });
  });
  it("真值非法（不在该模型 efforts）→ 落默认档并纠正", () => {
    expect(resolveThinking(GEMINI, "xhigh", "low")).toEqual({ level: "low", shouldSync: true });
    expect(resolveThinking(GEMINI, "xhigh")).toEqual({ level: "high", shouldSync: true });
    expect(resolveThinking(DEEPSEEK_PRO, "medium")).toEqual({ level: "max", shouldSync: true });
  });
  it("不支持思考的模型 → off，且无需下发", () => {
    expect(resolveThinking(null, null, "max")).toEqual({ level: "off", shouldSync: false });
    expect(resolveThinking(null, "high")).toEqual({ level: "off", shouldSync: false });
  });
});
