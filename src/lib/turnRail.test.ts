import { describe, expect, it } from "vitest";
import type { ViewMsg } from "@shared/types";
import { activeTurnAt, buildTurnRail, readingLine, turnJumpTop } from "./turnRail";

/** 一条用户消息（轮次锚点）。 */
const user = (id: string, text = id): ViewMsg => ({ kind: "user", id, text, mentions: [] });
/** 一条助手正文（回答）。 */
const answer = (id: string, text: string): ViewMsg => ({ kind: "text", id, seq: 0, text, complete: true });

describe("buildTurnRail", () => {
 it("一轮 = 一条用户消息：序号从 1 连续、预览取本轮最后一条助手正文", () => {
  const events: ViewMsg[] = [
   user("u1", "第一个问题"),
   answer("a1", "先查目录"),
   answer("a2", "最终回答"),
   user("u2", "第二个问题"),
   answer("a3", "第二轮的答案"),
  ];
  const items = buildTurnRail(events, 0);
  expect(items.map((i) => i.turn)).toEqual([1, 2]);
  expect(items.map((i) => i.id)).toEqual(["u1", "u2"]);
  expect(items.map((i) => i.index)).toEqual([0, 3]);
  // 回答不串轮：第一轮取自己最后一条，第二轮取自己那条
  expect(items.map((i) => i.response)).toEqual(["最终回答", "第二轮的答案"]);
  expect(items.every((i) => i.loaded)).toBe(true);
 });

 it("预览压掉换行 / 连续空白并限长（浮层按行截断，原文换行只会浪费行数）", () => {
  const events: ViewMsg[] = [user("u1", "  第一行\n\n 第二行\t结尾  "), answer("a1", "  回答\n里也有换行  ")];
  const items = buildTurnRail(events, 0);
  expect(items[0].prompt).toBe("第一行 第二行 结尾");
  expect(items[0].response).toBe("回答 里也有换行");
 });

 it("超长预览截到 240 字加省略号", () => {
  const items = buildTurnRail([user("u1", "啊".repeat(300))], 0);
  expect(items[0].prompt).toHaveLength(241);
  expect(items[0].prompt.endsWith("…")).toBe(true);
 });

 it("只有图片、没有文字的用户消息：提问预览为空（浮层回退成轮次号）", () => {
  const events: ViewMsg[] = [user("u1", ""), user("u2", "有字")];
  const items = buildTurnRail(events, 0);
  expect(items.map((i) => i.prompt)).toEqual(["", "有字"]);
 });

 it("流式中的半截正文不进预览（只认已完成的段落，且每段只归一一次）", () => {
  const events: ViewMsg[] = [
   user("u1", "问题"),
   answer("a1", "第一段完成"),
   { kind: "text", id: "a2", seq: 1, text: "半截流式", complete: false },
  ];
  expect(buildTurnRail(events, 0)[0].response).toBe("第一段完成");
 });

 it("空白完成段不把上一段回答覆盖成空（预览不留白）", () => {
  const events: ViewMsg[] = [user("u1", "问题"), answer("a1", "答案"), answer("a2", "   ")];
  expect(buildTurnRail(events, 0)[0].response).toBe("答案");
 });

 it("历史分页：渲染窗口之前的轮次标为未加载，序号与预览仍是完整会话的口径", () => {
  const events: ViewMsg[] = [user("u1", "旧问题"), answer("a1", "旧回答"), user("u2", "新问题"), answer("a2", "新回答")];
  const items = buildTurnRail(events, 2);
  expect(items.map((i) => i.loaded)).toEqual([false, true]);
  expect(items.map((i) => i.turn)).toEqual([1, 2]);
  expect(items.map((i) => i.response)).toEqual(["旧回答", "新回答"]);
 });

 it("没有轮次（空流 / 没有用户消息）返回空表", () => {
  expect(buildTurnRail([], 0)).toEqual([]);
  expect(buildTurnRail([answer("a1", "只有回答")], 0)).toEqual([]);
 });
});

describe("阅读线与当前轮次", () => {
 it("阅读线 = min(96px, 20% 视口高)，不给负数", () => {
  expect(readingLine(400)).toBe(80);
  expect(readingLine(1000)).toBe(96);
  expect(readingLine(0)).toBe(0);
  expect(readingLine(-20)).toBe(0);
 });

 it("取最后一个行顶不超过阅读线的轮次；阅读线在第一行之上时取第一轮", () => {
  const rows = [
   { turn: 1, top: 0 },
   { turn: 2, top: 200 },
   { turn: 3, top: 500 },
  ];
  expect(activeTurnAt(rows, 100)).toBe(1);
  expect(activeTurnAt(rows, 250)).toBe(2);
  expect(activeTurnAt(rows, 900)).toBe(3);
  expect(activeTurnAt(rows, -50)).toBe(1);
 });

 it("没有已加载轮次时为 null", () => {
  expect(activeTurnAt([], 100)).toBeNull();
 });
});

describe("turnJumpTop", () => {
 it("行顶放到视口顶下方 24px", () => {
  expect(turnJumpTop(500, 100, 2000)).toBe(576);
 });

 it("按滚动范围夹住两端（第一轮贴顶 / 最后一轮滚不过去）", () => {
  expect(turnJumpTop(-100, 50, 2000)).toBe(0);
  expect(turnJumpTop(5000, 100, 800)).toBe(800);
  // 不可滚动（maxTop ≤ 0）永远落在 0
  expect(turnJumpTop(0, 0, -5)).toBe(0);
 });
});
