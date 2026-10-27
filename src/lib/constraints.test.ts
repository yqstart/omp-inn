import { describe, expect, it } from "vitest";
import {
  MAX_CONSTRAINT_BYTES,
  constraintKey,
  defaultRuleFields,
  newRuleName,
  parseRuleDoc,
  ruleDescriptionOf,
  ruleDisplayName,
  ruleKindOf,
  splitFrontmatter,
  validateConstraintText,
} from "./constraints";

describe("splitFrontmatter", () => {
  it("没有 frontmatter 时正文就是全文", () => {
    const text = "# 全局约束\n\n正文\n";
    expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
  });

  it("拆出 frontmatter 与正文（正文偏移不动）", () => {
    const text = "---\ndescription: 测试\n---\n\n正文\n";
    expect(splitFrontmatter(text)).toEqual({
      frontmatter: "description: 测试",
      body: "\n正文\n",
    });
  });

  it("支持 CRLF 与 `...` 结束行、空 frontmatter", () => {
    expect(splitFrontmatter("---\r\na: 1\r\n---\r\n正文").frontmatter).toBe("a: 1");
    expect(splitFrontmatter("---\na: 1\n...\n正文").frontmatter).toBe("a: 1");
    expect(splitFrontmatter("---\n---\n正文")).toEqual({ frontmatter: "", body: "正文" });
  });

  it("未闭合时给出错误、正文保持原文", () => {
    const text = "---\ndescription: 测试\n正文";
    const split = splitFrontmatter(text);
    expect(split.frontmatter).toBeNull();
    expect(split.body).toBe(text);
    expect(split.error).toContain("结束行");
  });

  it("正文里的 `---` 不是 frontmatter 分隔线", () => {
    expect(splitFrontmatter("# 标题\n---\n正文").frontmatter).toBeNull();
  });
});

describe("parseRuleDoc", () => {
  it("没有 frontmatter 时给默认字段", () => {
    const parsed = parseRuleDoc("规则正文\n");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.doc.fields).toEqual(defaultRuleFields());
    expect(parsed.doc.body).toBe("规则正文\n");
  });

  it("解析全部已知字段（单字符串写成数组）", () => {
    const parsed = parseRuleDoc(`---
description: 禁止 any
enabled: false
alwaysApply: true
globs: src/**/*.ts
condition:
  - ": any"
astCondition: ["func $F() {}"]
question: 这段代码有问题吗？
scope: ["tool:edit(*.ts)"]
agents: [reviewer]
interruptMode: prose-only
unknownField: 保留
---
正文
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.doc.fields).toEqual({
      description: "禁止 any",
      enabled: false,
      alwaysApply: true,
      globs: ["src/**/*.ts"],
      condition: [": any"],
      astCondition: ["func $F() {}"],
      question: "这段代码有问题吗？",
      scope: ["tool:edit(*.ts)"],
      agents: ["reviewer"],
      interruptMode: "prose-only",
    });
    expect(parsed.doc.extraFields).toEqual(["unknownField"]);
    expect(parsed.doc.body).toBe("正文\n");
  });

  it("非法 interruptMode 退回未设置；坏 YAML 给错误", () => {
    const badMode = parseRuleDoc("---\ninterruptMode: sometimes\n---\n正文");
    expect(badMode.ok && badMode.doc.fields.interruptMode).toBe("");

    const broken = parseRuleDoc("---\na: [\n---\n正文");
    expect(broken.ok).toBe(false);
    if (!broken.ok) {
      expect(broken.error.length).toBeGreaterThan(0);
      expect(broken.body).toBe("正文");
    }
  });

  it("frontmatter 不是映射时报错", () => {
    expect(parseRuleDoc("---\n- a\n- b\n---\n正文").ok).toBe(false);
  });
});

describe("ruleKindOf / 展示", () => {
  it("alwaysApply 优先；有条件 = 实时注入；否则规则手册", () => {
    expect(ruleKindOf(defaultRuleFields())).toBe("rulebook");
    expect(ruleKindOf({ ...defaultRuleFields(), alwaysApply: true })).toBe("always");
    expect(ruleKindOf({ ...defaultRuleFields(), condition: ["x"] })).toBe("ttsr");
    expect(ruleKindOf({ ...defaultRuleFields(), astCondition: ["x"] })).toBe("ttsr");
    expect(ruleKindOf({ ...defaultRuleFields(), question: "x" })).toBe("ttsr");
    expect(ruleKindOf({ ...defaultRuleFields(), condition: ["x"], alwaysApply: true })).toBe("always");
  });

  it("规则名去扩展名，键稳定", () => {
    expect(ruleDisplayName("no-any.md")).toBe("no-any");
    expect(ruleDisplayName("no-any.mdc")).toBe("no-any");
    expect(ruleDisplayName("no-any.MD")).toBe("no-any");
    expect(constraintKey("rule", "no-any.md")).toBe("rule:no-any.md");
  });
});

describe("newRuleName", () => {
  it("补 .md、保留已有扩展名", () => {
    expect(newRuleName("no-any")).toEqual({ name: "no-any.md", error: null });
    expect(newRuleName("no-any.mdc")).toEqual({ name: "no-any.mdc", error: null });
    expect(newRuleName("中文 规则")).toEqual({ name: "中文 规则.md", error: null });
  });

  it("拒绝空名与路径形状", () => {
    expect(newRuleName("  ").error).toBe("empty");
    expect(newRuleName("../x").error).toBe("invalid");
    expect(newRuleName(".hidden").error).toBe("invalid");
    expect(newRuleName("a/b").error).toBe("invalid");
    expect(newRuleName("a\\b").error).toBe("invalid");
    expect(newRuleName("a:b").error).toBe("invalid");
    expect(newRuleName("a*b").error).toBe("invalid");
    expect(newRuleName(`${"a".repeat(96)}`).error).toBe("invalid");
  });
});

describe("validateConstraintText", () => {
  it("过大 / NUL / 未闭合 frontmatter", () => {
    expect(validateConstraintText("rule", "a".repeat(MAX_CONSTRAINT_BYTES + 1))).toMatchObject({ kind: "tooLarge" });
    expect(validateConstraintText("rule", "a\0b")).toMatchObject({ kind: "nul" });
    expect(validateConstraintText("rule", "---\na: 1\n正文")).toMatchObject({ kind: "frontmatter" });
    expect(validateConstraintText("agents", "---\n不是规则 frontmatter 也允许")).toBeNull();
    expect(validateConstraintText("rule", "---\na: 1\n---\n正文")).toBeNull();
  });

  it("搜索用描述解析失败时为空串", () => {
    expect(ruleDescriptionOf("---\ndescription: x\n---\n正文")).toBe("x");
    expect(ruleDescriptionOf("---\na: [\n---\n正文")).toBe("");
  });
});
