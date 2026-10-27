import { describe, expect, it } from "vitest";
import {
 commandInsert,
 filterCommands,
 isCompleteCommand,
 normalizeCommands,
 type SlashCandidate,
} from "./slashCommands";
/** 样例取本机 omp 18.2.1 实测形状（`available_commands_update` 原样）。 */
const RAW = [
 { name: "see", source: "builtin", description: "See raw test output", input: { hint: "[tool-map]" } },
 {
  name: "compact",
  source: "builtin",
  description: "Compact the conversation",
  input: { hint: "[soft|remote|snapcompact] [focus]" },
  subcommands: [{ name: "soft", description: "Soft compact" }],
 },
 { name: "model", source: "builtin", aliases: ["models"], description: "Show current model selection" },
 { name: "context", source: "builtin", description: "Show context usage" },
 { name: "skill:code-simplifier", source: "skill", description: "Simplify complex code", input: { hint: "arguments" } },
 { name: "skill:vue-best-practices", source: "skill", description: "MUST be used for Vue.js tasks" },
];

const CMDS = normalizeCommands(RAW);

const names = (cs: { name: string }[]) => cs.map((c) => c.name);
const displays = (cs: SlashCandidate[]) => cs.map((c) => c.display);

describe("normalizeCommands", () => {
  it("折平 input.hint（线上形状），保留 source 与 subcommands", () => {
    const c = CMDS.find((x) => x.name === "compact");
    expect(c?.hint).toBe("[soft|remote|snapcompact] [focus]");
    expect(c?.source).toBe("builtin");
    expect(c?.subcommands).toEqual([{ name: "soft", description: "Soft compact", usage: undefined }]);
  });

  it("也认扁平的 hint（上游万一改回平铺）", () => {
    expect(normalizeCommands([{ name: "x", hint: "flat" }])[0].hint).toBe("flat");
  });

  it("丢缺 name 的坏项、非数组一律空，不让坏帧崩掉整个补全", () => {
    expect(normalizeCommands([{ description: "无名字" }, { name: "" }, null, 42])).toEqual([]);
    expect(normalizeCommands(null)).toEqual([]);
    expect(normalizeCommands({ name: "不是数组" })).toEqual([]);
  });

  it("别名过滤掉非字符串项", () => {
    expect(normalizeCommands([{ name: "a", aliases: ["b", 3, null] }])[0].aliases).toEqual(["b"]);
    // 过滤后为空就不留空数组
    expect(normalizeCommands([{ name: "a", aliases: [3] }])[0].aliases).toBeUndefined();
  });
});

describe("filterCommands", () => {
  it("空查询按 omp 原序返回全部", () => {
    expect(names(filterCommands(CMDS, ""))).toEqual(names(CMDS));
  });

  it("名字前缀命中排在前面，同分保持原序", () => {
    expect(names(filterCommands(CMDS, "co"))).toEqual(["compact", "context", "skill:code-simplifier"]);
  });

  it("技能组永远落在命令组之后，与匹配质量无关", () => {
    const got = filterCommands(CMDS, "");
    const firstSkill = got.findIndex((c) => c.group === "skill");
    const lastCmd = got.map((c) => c.group).lastIndexOf("command");
    expect(firstSkill).toBeGreaterThan(lastCmd);
    expect(firstSkill).toBeGreaterThan(-1);
  });

  it("技能行显示去掉 skill: 前缀，插入仍用完整名", () => {
    const got = filterCommands(CMDS, "code");
    expect(displays(got)).toContain("code-simplifier");
    expect(commandInsert(got.find((c) => c.display === "code-simplifier")!)).toBe("/skill:code-simplifier ");
  });

  it("别名命中（/models 找得到 /model）", () => {
    expect(names(filterCommands(CMDS, "models"))).toContain("model");
  });

  it("描述也进搜索面（记不住命令名时靠关键词找）", () => {
    expect(names(filterCommands(CMDS, "usage"))).toEqual(["context"]);
    expect(names(filterCommands(CMDS, "vue"))).toEqual(["skill:vue-best-practices"]);
  });

  it("大小写不敏感", () => {
    expect(names(filterCommands(CMDS, "COMPACT"))).toEqual(["compact"]);
  });

  it("零命中返回空数组", () => {
    expect(filterCommands(CMDS, "zzzz")).toEqual([]);
  });
});

describe("isCompleteCommand", () => {
  it("打全命令名 / 别名即视为完成（Enter 直接发送，补全不拦截）", () => {
    expect(isCompleteCommand(CMDS, "compact")).toBe(true);
    expect(isCompleteCommand(CMDS, "models")).toBe(true);
    expect(isCompleteCommand(CMDS, "skill:code-simplifier")).toBe(true);
  });

  it("只打了一半不算完成", () => {
    expect(isCompleteCommand(CMDS, "comp")).toBe(false);
    expect(isCompleteCommand(CMDS, "")).toBe(false);
  });

  it("大小写不敏感", () => {
    expect(isCompleteCommand(CMDS, "Compact")).toBe(true);
  });
});

describe("commandInsert", () => {
  it("补完整名 + 一个空格，便于接着打参数", () => {
    const c = filterCommands(CMDS, "context")[0];
    expect(commandInsert(c)).toBe("/context ");
  });
});
