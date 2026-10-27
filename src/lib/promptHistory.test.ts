// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { loadHistory, pushHistory } from "./promptHistory";

/**
 * prompt 历史（V41）：按会话存放、相邻去重、上限保尾、坏数据容错。
 */
beforeEach(() => {
 localStorage.removeItem("omp.promptHistory.v1");
});

describe("promptHistory", () => {
 it("push / load：按会话隔离、时间序（旧在前）", () => {
  pushHistory("s1", "第一条");
  pushHistory("s1", "第二条");
  pushHistory("s2", "别的会话");
  expect(loadHistory("s1")).toEqual(["第一条", "第二条"]);
  expect(loadHistory("s2")).toEqual(["别的会话"]);
  expect(loadHistory("nope")).toEqual([]);
 });

 it("相邻重复不记；不相邻的重复照记；空文本与纯空白不记", () => {
  pushHistory("s1", "a");
  pushHistory("s1", "a");
  pushHistory("s1", "b");
  pushHistory("s1", "a");
  pushHistory("s1", "   ");
  expect(loadHistory("s1")).toEqual(["a", "b", "a"]);
 });

 it("超过上限保尾（最近 50 条）", () => {
  for (let i = 0; i < 60; i++) pushHistory("s1", `t${i}`);
  const list = loadHistory("s1");
  expect(list).toHaveLength(50);
  expect(list[0]).toBe("t10");
  expect(list[49]).toBe("t59");
 });

 it("落盘在 localStorage（跨实例可见）；坏数据按空处理不抛", () => {
  pushHistory("s1", "持久化");
  expect(localStorage.getItem("omp.promptHistory.v1")).toContain("持久化");
  localStorage.setItem("omp.promptHistory.v1", "not-json{");
  expect(loadHistory("s1")).toEqual([]);
  localStorage.setItem("omp.promptHistory.v1", JSON.stringify(["not-an-object"]));
  expect(loadHistory("s1")).toEqual([]);
  localStorage.setItem("omp.promptHistory.v1", JSON.stringify({ s1: ["ok", 3, null] }));
  expect(loadHistory("s1")).toEqual(["ok"]);
 });
});
