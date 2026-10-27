import { describe, expect, it } from "vitest";
import { joinSelector, splitSelector, withLevel } from "./modelSelector";

// selector 取自本机 omp 18.2.1 配置与模型目录实测值
describe("splitSelector", () => {
  it("拆出已知档位后缀，模型部分原样", () => {
    expect(splitSelector("opencode-go/deepseek-v4.1-flash:max")).toEqual({
      base: "opencode-go/deepseek-v4.1-flash",
      level: "max",
    });
    // id 里带 `/`（provider 下还有一层命名空间）也不受影响
    expect(splitSelector("commandcode/meta/muse-spark-1.3-contributor:xhigh")).toEqual({
      base: "commandcode/meta/muse-spark-1.3-contributor",
      level: "xhigh",
    });
    expect(splitSelector("anthropic/claude-sonnet-5:off")).toEqual({
      base: "anthropic/claude-sonnet-5",
      level: "off",
    });
  });

  it("没有后缀 / 后缀不是档位 → 整串当模型部分（不许把 id 里的冒号切坏）", () => {
    expect(splitSelector("opencode-go/deepseek-v4.1-flash")).toEqual({
      base: "opencode-go/deepseek-v4.1-flash",
      level: null,
    });
    // `:beta` 不是 omp 的档位，属于模型 id 本身
    expect(splitSelector("vendor/model:beta")).toEqual({ base: "vendor/model:beta", level: null });
    // auto 是「自动决定」，不是 selector 后缀（omp 会解析成具体档，不保留）
    expect(splitSelector("vendor/model:auto")).toEqual({ base: "vendor/model:auto", level: null });
    // 大小写敏感：档位只有小写形态
    expect(splitSelector("vendor/model:HIGH")).toEqual({ base: "vendor/model:HIGH", level: null });
  });

  it("畸形形态不误拆（空串 / 只有档位 / 冒号结尾）", () => {
    expect(splitSelector("")).toEqual({ base: "", level: null });
    expect(splitSelector(":high")).toEqual({ base: ":high", level: null });
    expect(splitSelector("vendor/model:")).toEqual({ base: "vendor/model:", level: null });
    // 只切最后一个冒号：前面那截原样留着
    expect(splitSelector("vendor/a:b:low")).toEqual({ base: "vendor/a:b", level: "low" });
  });
});

describe("joinSelector / withLevel", () => {
  it("level 为空写裸 selector（= 用 omp 自己的默认档）", () => {
    expect(joinSelector("a/b", "high")).toBe("a/b:high");
    expect(joinSelector("a/b", null)).toBe("a/b");
    expect(joinSelector("a/b", "")).toBe("a/b");
  });

  it("withLevel 只换档、保留模型部分（含摘掉后缀）", () => {
    expect(withLevel("a/b:max", "low")).toBe("a/b:low");
    expect(withLevel("a/b:max", null)).toBe("a/b");
    expect(withLevel("a/b", "medium")).toBe("a/b:medium");
  });

  it("拆合往返一致（含 id 里带冒号的情形）", () => {
    for (const sel of ["a/b:high", "a/b", "commandcode/meta/x:xhigh", "vendor/model:beta"]) {
      const { base, level } = splitSelector(sel);
      expect(joinSelector(base, level)).toBe(sel);
    }
  });
});
