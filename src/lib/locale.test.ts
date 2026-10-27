import { describe, expect, it } from "vitest";
import { LOCALES, LOCALE_MODES, TEXT, normalizeLocaleMode, resolveLocale } from "./locale";

describe("界面语言字典", () => {
  it("两套字典键完全一致（增删文案必须中英同键）", () => {
    const zh = Object.keys(TEXT["zh-CN"]).sort();
    const en = Object.keys(TEXT.en).sort();
    expect(en).toEqual(zh);
    // 全界面文案（侧栏 / 消息流 / 输入区 / 设置页）都在这里，键数过少说明有整块漏迁
    expect(zh.length).toBeGreaterThan(150);
  });
  it("LOCALES 只含已落字典的语言", () => {
    expect([...LOCALES].sort()).toEqual(["en", "zh-CN"]);
  });
  it("无空文案（避免切英文后出现空白按钮）", () => {
    for (const locale of LOCALES) {
      for (const [key, text] of Object.entries(TEXT[locale])) {
        expect(text.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });
  it("英文词典不含中文（漏译立刻暴露）", () => {
    for (const [key, text] of Object.entries(TEXT.en)) {
      expect(/[\u4e00-\u9fff]/.test(text), `en.${key}`).toBe(false);
    }
  });
});

describe("界面语言偏好（跟随系统 / 简体中文 / English）", () => {
  it("三档顺序固定，且两个具体语言与 LOCALES 对齐", () => {
    expect([...LOCALE_MODES]).toEqual(["system", "zh-CN", "en"]);
    for (const l of LOCALES) expect([...LOCALE_MODES]).toContain(l);
  });
  it("resolveLocale：显式档位不听系统语言", () => {
    expect(resolveLocale("zh-CN", "en-US")).toBe("zh-CN");
    expect(resolveLocale("en", "zh-CN")).toBe("en");
  });
  it("resolveLocale：system 档按系统语言判定（zh* 中文，其余英文，大小写与空格容错）", () => {
    for (const zh of ["zh", "zh-CN", "zh-Hans-CN", "zh-TW", " ZH-cn "]) {
      expect(resolveLocale("system", zh), zh).toBe("zh-CN");
    }
    for (const other of ["en", "en-US", "ja-JP", "de", ""]) {
      expect(resolveLocale("system", other), other).toBe("en");
    }
  });
  it("normalizeLocaleMode：坏值回退跟随系统；老版本存的 zh-CN / en 照旧生效", () => {
    expect(normalizeLocaleMode("zh-CN")).toBe("zh-CN");
    expect(normalizeLocaleMode("en")).toBe("en");
    expect(normalizeLocaleMode("system")).toBe("system");
    for (const bad of [null, undefined, "", "fr", "System", 42]) {
      expect(normalizeLocaleMode(bad), String(bad)).toBe("system");
    }
  });
});
