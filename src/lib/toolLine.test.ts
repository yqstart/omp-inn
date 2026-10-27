import { describe, expect, it } from "vitest";
import { TEXT } from "./locale";
import { splitPath, splitRange, toolLineParts } from "./toolLine";

const zh = TEXT["zh-CN"];

/** 造一条工具 ViewMsg（只带工具行用得到的字段）。 */
const tool = (name: string, argsSummary: string) =>
 ({
  kind: "tool" as const,
  id: `tool:${name}`,
  toolCallId: name,
  name,
  intent: "",
  argsSummary,
  state: "ok" as const,
  output: "",
  streamIndex: 0,
 });

describe("splitRange", () => {
 it("拆出 path 与行号后缀", () => {
  expect(splitRange("src/a.ts:1-120")).toEqual({ path: "src/a.ts", range: "1-120" });
 });
 it("omp 的读法后缀（`:行号:模式`）一并剥掉", () => {
  expect(splitRange("src/a.ts:295-351:raw")).toEqual({ path: "src/a.ts", range: "295-351:raw" });
  expect(splitRange("src/a.ts:raw")).toEqual({ path: "src/a.ts", range: "raw" });
 });
 it("没有行号时原样作 path", () => {
  expect(splitRange("src/a.ts")).toEqual({ path: "src/a.ts", range: "" });
  expect(splitRange("")).toEqual({ path: "", range: "" });
 });
 it("不误切 Windows 盘符路径", () => {
  expect(splitRange("C:\\proj\\a.ts")).toEqual({ path: "C:\\proj\\a.ts", range: "" });
 });
});

describe("splitPath", () => {
 it("目录保留结尾斜杠", () => {
  expect(splitPath("src-tauri/src/usage.rs")).toEqual({ base: "usage.rs", dir: "src-tauri/src/" });
 });
 it("裸文件名没有目录", () => {
  expect(splitPath("package.json")).toEqual({ base: "package.json", dir: "" });
 });
 it("Windows 反斜杠同样能拆", () => {
  expect(splitPath("C:\\proj\\src\\a.ts")).toEqual({ base: "a.ts", dir: "C:\\proj\\src\\" });
 });
});

describe("toolLineParts", () => {
 it("read/write/edit 拆成基名 + 目录（行号 / 读法不进行内）", () => {
  expect(toolLineParts(tool("read", "src/lib/viewmsg.ts:1-120"), zh)).toMatchObject({
   icon: "read",
   verb: "读取",
   main: "viewmsg.ts",
   sub: "src/lib/",
   pathLike: true,
  });
  expect(toolLineParts(tool("read", "src/components/settings/ModelsPanel.tsx:295-351:raw"), zh)).toMatchObject({
   main: "ModelsPanel.tsx",
   sub: "src/components/settings/",
  });
  expect(toolLineParts(tool("edit", "src-tauri/src/usage.rs"), zh)).toMatchObject({
   icon: "edit",
   verb: "编辑",
   main: "usage.rs",
   sub: "src-tauri/src/",
  });
  expect(toolLineParts(tool("write", "package.json"), zh)).toMatchObject({
   icon: "write",
   verb: "写入",
   main: "package.json",
   sub: "",
  });
 });
 it("bash 整条命令进主片段（可截断，不作为路径）", () => {
  expect(toolLineParts(tool("bash", "cargo test --all"), zh)).toMatchObject({
   icon: "bash",
   verb: "终端",
   main: "cargo test --all",
   sub: "",
   pathLike: false,
  });
 });
 it("grep/glob 拆成模式 + 路径", () => {
  expect(toolLineParts(tool("grep", "useApp · src/"), zh)).toMatchObject({
   icon: "search",
   verb: "搜索",
   main: "useApp",
   sub: "src/",
  });
 });
 it("未知工具用 omp 的意图当主片段（原始参数串糊在行上太吵）", () => {
  expect(
   toolLineParts({ ...tool("hub", '{"i":"停掉 dev server","op":"stop"}'), intent: "停掉 dev server" }, zh),
  ).toMatchObject({ icon: "other", verb: "hub", main: "停掉 dev server", pathLike: false });
 });
 it("未知工具没有意图时退回原始参数（上游数据不翻译）", () => {
  expect(toolLineParts(tool("web_search", "oh-my-pi"), zh)).toMatchObject({
   icon: "other",
   verb: "web_search",
   main: "oh-my-pi",
   pathLike: false,
  });
 });
 it("参数还没到手时主片段为空（由渲染层按状态兜底）", () => {
  expect(toolLineParts(tool("tool", ""), zh)).toMatchObject({ icon: "other", main: "" });
 });
});
