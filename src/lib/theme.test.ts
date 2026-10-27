import { describe, expect, it } from "vitest";
import { THEMES, normalizeTheme, resolveTheme } from "./theme";

describe("皮肤模式", () => {
  it("THEMES 三档固定顺序（跟随系统 / 深色 / 浅色）", () => {
    expect([...THEMES]).toEqual(["system", "dark", "light"]);
  });

  it("normalizeTheme 丢弃坏值并回退跟随系统", () => {
    expect(normalizeTheme("system")).toBe("system");
    expect(normalizeTheme("dark")).toBe("dark");
    expect(normalizeTheme("light")).toBe("light");
    expect(normalizeTheme("blue")).toBe("system");
    expect(normalizeTheme(null)).toBe("system");
    expect(normalizeTheme(undefined)).toBe("system");
    expect(normalizeTheme(1)).toBe("system");
  });

  it("resolveTheme：system 跟随系统，深/浅强制覆盖系统", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    // 显式档不受系统偏好影响（系统深色时选浅色仍是浅色）
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
