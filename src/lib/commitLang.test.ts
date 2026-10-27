// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  COMMIT_LANGS,
  commitContextArg,
  loadCommitLangPrefs,
  normalizeCommitLang,
  saveCommitLangPrefs,
} from "./commitLang";

beforeEach(() => {
  localStorage.clear();
});

describe("提交信息语言偏好（按项目）", () => {
  it("三档固定顺序（系统默认 / 中文 / 英文）", () => {
    expect([...COMMIT_LANGS]).toEqual(["system", "zh", "en"]);
  });

  it("normalizeCommitLang 丢弃坏值并回退系统默认", () => {
    expect(normalizeCommitLang("system")).toBe("system");
    expect(normalizeCommitLang("zh")).toBe("zh");
    expect(normalizeCommitLang("en")).toBe("en");
    for (const bad of [null, undefined, "", "cn", "ZH", 42]) {
      expect(normalizeCommitLang(bad), String(bad)).toBe("system");
    }
  });

  it("save / load 往返：只落已记住的项目，没配过就是空", () => {
    expect(loadCommitLangPrefs()).toEqual({});

    saveCommitLangPrefs({
      p1: { lang: "zh", remembered: true },
      p2: { lang: "en", remembered: false },
    });
    expect(loadCommitLangPrefs()).toEqual({ p1: { lang: "zh", remembered: true } });

    // 取消记住 = 从盘里删除（内存态由 store 管，不在这里留痕）
    saveCommitLangPrefs({ p1: { lang: "zh", remembered: false } });
    expect(loadCommitLangPrefs()).toEqual({});
  });

  it("load 丢弃坏数据（坏 JSON / 数组 / 未知档位 / 空 id）", () => {
    localStorage.setItem("omp.commitLang.v1", "{坏 json");
    expect(loadCommitLangPrefs()).toEqual({});

    localStorage.setItem("omp.commitLang.v1", JSON.stringify(["zh"]));
    expect(loadCommitLangPrefs()).toEqual({});

    localStorage.setItem("omp.commitLang.v1", JSON.stringify({ p1: "fr", "": "zh", p2: "en", p3: "system" }));
    expect(loadCommitLangPrefs()).toEqual({
      p2: { lang: "en", remembered: true },
      p3: { lang: "system", remembered: true },
    });
  });

  it("三档对应给 omp 的附加要求：系统默认不传，中文 / 英文各自带语言要求", () => {
    expect(commitContextArg("system")).toBeNull();
    expect(commitContextArg("zh")).toContain("简体中文");
    expect(commitContextArg("en")).toContain("英文");
    // 两份要求必须不同（否则档位形同虚设）
    expect(commitContextArg("zh")).not.toBe(commitContextArg("en"));
  });
});
