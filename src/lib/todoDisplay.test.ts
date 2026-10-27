import { describe, expect, it } from "vitest";
import type { TodoPhase } from "@shared/types";
import { TEXT } from "./locale";
import { countTodos, todoStatsText } from "./todoDisplay";

const zh = TEXT["zh-CN"];
const en = TEXT.en;

describe("任务清单计数与统计文案", () => {
 it("按状态清点（未知状态并入待处理档）", () => {
  const phases: TodoPhase[] = [
   {
    name: "阶段一",
    tasks: [
     { content: "甲", status: "completed" },
     { content: "乙", status: "in_progress" },
     { content: "丙", status: "pending" },
     { content: "丁", status: "blocked", blocker: "等上游" },
     { content: "戊", status: "weird" },
    ],
   },
   { name: "阶段二", tasks: [{ content: "己", status: "in_progress" }] },
  ];
  expect(countTodos(phases)).toEqual({ total: 6, done: 1, inProgress: 2, pending: 2, blocked: 1 });
  expect(countTodos([])).toEqual({ total: 0, done: 0, inProgress: 0, pending: 0, blocked: 0 });
 });

 it("统计只列未完成档位（进行中 · 待处理 · 受阻），零计数不出现", () => {
  expect(todoStatsText({ total: 11, done: 0, inProgress: 1, pending: 10, blocked: 0 }, zh)).toBe(
   "1 进行中 · 10 待处理",
  );
  expect(todoStatsText({ total: 12, done: 1, inProgress: 1, pending: 9, blocked: 1 }, zh)).toBe(
   "1 进行中 · 9 待处理 · 1 受阻",
  );
 });

 it("全部完成给完成计数（三档都为零时的唯一分支）", () => {
  expect(todoStatsText({ total: 3, done: 3, inProgress: 0, pending: 0, blocked: 0 }, zh)).toBe("3 已完成");
  expect(todoStatsText({ total: 0, done: 0, inProgress: 0, pending: 0, blocked: 0 }, zh)).toBe("0 已完成");
 });

 it("英文同口径", () => {
  expect(todoStatsText({ total: 2, done: 0, inProgress: 0, pending: 2, blocked: 0 }, en)).toBe("2 to do");
  expect(todoStatsText({ total: 2, done: 2, inProgress: 0, pending: 0, blocked: 0 }, en)).toBe("2 done");
 });
});
