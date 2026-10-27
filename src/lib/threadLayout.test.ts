import { describe, expect, it } from "vitest";
import type { ViewMsg } from "@shared/types";
import { buildThreadLayout, sumDiff } from "./threadLayout";

/** 构造一条工具消息（默认 bash，成功态）。 */
const tool = (id: string, over: Partial<Extract<ViewMsg, { kind: "tool" }>> = {}): ViewMsg => ({
 kind: "tool",
 id,
 toolCallId: id,
 name: "bash",
 intent: "",
 argsSummary: `cmd-${id}`,
 state: "ok",
 output: "",
 streamIndex: 0,
 ...over,
});

const user = (id: string, at?: number): ViewMsg => ({ kind: "user", id, text: id, mentions: [], ...(at != null ? { at } : {}) });
const text = (id: string, at?: number): ViewMsg => ({ kind: "text", id, seq: 0, text: id, complete: true, ...(at != null ? { at } : {}) });

describe("buildThreadLayout 聚合", () => {
 it("相邻 ≥2 条 bash 聚合成一条命令批（单条不聚合）", () => {
  const items = [tool("a"), tool("b"), text("t1"), tool("c")];
  const out = buildThreadLayout(items, false);
  expect(out.map((i) => i.kind)).toEqual(["run", "msg", "msg"]);
  const run = out[0];
  expect(run.kind === "run" && run.group).toBe("commands");
  expect(run.kind === "run" && run.items.map((m) => m.id)).toEqual(["a", "b"]);
  // 单条 bash（c）不聚合，保持单行
  expect(out[2].kind === "msg" && out[2].m.id).toBe("c");
 });

 it("相邻 ≥2 条带行数增量的 edit / write 聚合成编辑卡，总和 +X −Y 由 sumDiff 给出", () => {
  const e1 = tool("e1", { name: "edit", diffStat: { added: 3, removed: 1 } });
  const e2 = tool("e2", { name: "write", diffStat: { added: 10, removed: 0 } });
  const out = buildThreadLayout([e1, e2], false);
  expect(out).toHaveLength(1);
  const run = out[0];
  expect(run.kind === "run" && run.group).toBe("edits");
  expect(run.kind === "run" && sumDiff(run.items)).toEqual({ added: 13, removed: 1 });
 });

 it("类型不同不混聚：bash 与 edit 各成一段（各 1 条时不聚合）", () => {
  const items = [tool("a"), tool("e", { name: "edit", diffStat: { added: 1, removed: 0 } }), tool("b")];
  const out = buildThreadLayout(items, false);
  expect(out.map((i) => i.kind)).toEqual(["msg", "msg", "msg"]);
 });

 it("相邻 ≥2 条 todo 聚合成任务清单批（单条不聚合）", () => {
  const items = [tool("p1", { name: "todo" }), tool("p2", { name: "todo" }), text("t1")];
  const out = buildThreadLayout(items, false);
  expect(out.map((i) => i.kind)).toEqual(["run", "msg"]);
  expect(out[0]).toMatchObject({ kind: "run", group: "plans" });
 });

 it("无 diffStat 的 edit（拿不到行数）不参与聚合，保持单行", () => {
  const items = [tool("e1", { name: "edit" }), tool("e2", { name: "edit" })];
  const out = buildThreadLayout(items, false);
  expect(out.map((i) => i.kind)).toEqual(["msg", "msg"]);
 });

 it("读 / 搜类工具不聚合（保持逐条原样）", () => {
  const items = [tool("r1", { name: "read" }), tool("r2", { name: "read" })];
  const out = buildThreadLayout(items, false);
  expect(out.map((i) => i.kind)).toEqual(["msg", "msg"]);
 });
});

describe("buildThreadLayout 轮时长", () => {
 it("一轮（user → 下一次 user 之前）产出时长行，收在该轮末尾", () => {
  const items = [user("u1", 1000), tool("a", { at: 3000 }), text("t1", 61000), user("u2", 90000), text("t2", 95000)];
  const out = buildThreadLayout(items, false);
  const kinds = out.map((i) => i.kind);
  expect(kinds).toEqual(["msg", "msg", "msg", "turn", "msg", "msg", "turn"]);
  const first = out[3];
  expect(first.kind === "turn" && first.span).toEqual({ ms: 60000, startAt: 1000, endAt: 61000 });
  const last = out[6];
  expect(last.kind === "turn" && last.span.ms).toBe(5000);
 });

 it("running 时跳过压在流尾的进行中轮次（没有时长可报）", () => {
  const items = [user("u1", 1000), text("t1", 61000), user("u2", 90000), text("t2", 95000)];
  const out = buildThreadLayout(items, true);
  expect(out.filter((i) => i.kind === "turn")).toHaveLength(1);
  expect(out[out.length - 1].kind).toBe("msg");
 });

 it("没有时间戳（老数据）不产时长行", () => {
  const items = [user("u1"), text("t1")];
  const out = buildThreadLayout(items, false);
  expect(out.map((i) => i.kind)).toEqual(["msg", "msg"]);
 });
});
