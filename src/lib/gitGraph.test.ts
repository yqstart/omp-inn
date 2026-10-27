import { describe, expect, it } from "vitest";
import type { GitGraphCommit } from "@shared/types";
import { graphColumnWidth, laneX, layoutGraph } from "./gitGraph";

const commit = (hash: string, parents: string[] = []): GitGraphCommit => ({
 hash,
 parents,
 author: "A",
 email: "a@b.c",
 at: 0,
 subject: hash,
 refs: [],
});

describe("layoutGraph", () => {
 it("线性历史：单 lane，逐行一条竖线", () => {
  const { rows, lanes } = layoutGraph([commit("c", ["b"]), commit("b", ["a"]), commit("a")]);
  expect(lanes).toBe(1);
  expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
  expect(rows[0].edges).toEqual([{ from: null, to: 0 }]);
  expect(rows[1].edges).toEqual([{ from: 0, to: null }, { from: null, to: 0 }]);
  expect(rows[2].edges).toEqual([{ from: 0, to: null }]);
 });

 it("分支 + 合并：合并提交分叉到两条 lane，旁支再并回主干", () => {
  // m (merge) -> a, b；a/b -> r
  const { rows, lanes } = layoutGraph([
   commit("m", ["a", "b"]),
   commit("a", ["r"]),
   commit("b", ["r"]),
   commit("r"),
  ]);
  expect(lanes).toBe(2);
  expect(rows.map((r) => r.lane)).toEqual([0, 0, 1, 0]);
  expect(rows[0].edges).toEqual([
   { from: null, to: 0 },
   { from: null, to: 1 },
  ]);
  expect(rows[1].edges).toEqual([
   { from: 1, to: 1 },
   { from: 0, to: null },
   { from: null, to: 0 },
  ]);
  // b 在 lane 1 画完，父提交 r 已经在 lane 0 等待：斜线并入，不复制节点
  expect(rows[2].edges).toEqual([
   { from: 0, to: 0 },
   { from: 1, to: null },
   { from: null, to: 0 },
  ]);
 });

 it("筛选 / 分页边界：不可见父提交不占 lane，也不挂悬空线", () => {
  const { rows, lanes } = layoutGraph([commit("m", ["a", "ghost"]), commit("a")]);
  expect(lanes).toBe(1);
  expect(rows[0].edges).toEqual([{ from: null, to: 0 }]);
  expect(rows[1].edges).toEqual([{ from: 0, to: null }]);
 });

 it("无提交时仍是 1 lane（组件据此给空态占位）", () => {
  expect(layoutGraph([])).toEqual({ rows: [], lanes: 1 });
 });

 it("同一父提交被多个子提交登记时只保留一条 lane（不重复节点）", () => {
  // x/y 是两个独立 tip，都指向 r；r 第一次登记在 lane 0，y 并入 lane 0
  const { rows, lanes } = layoutGraph([commit("x", ["r"]), commit("y", ["r"]), commit("r")]);
  expect(lanes).toBe(2);
  expect(rows.map((r) => r.lane)).toEqual([0, 1, 0]);
  expect(rows[1].edges).toEqual([
   { from: 0, to: 0 },
   { from: null, to: 0 },
  ]);
  // 两个 tip 都结束后 r 只画一次
  expect(rows[2].lane).toBe(0);
 });
});

describe("图谱列几何", () => {
 it("列宽随 lane 数增长且有上下限", () => {
  expect(graphColumnWidth(1)).toBe(28);
  expect(graphColumnWidth(3)).toBe(52);
  expect(graphColumnWidth(20)).toBe(120);
 });

 it("laneX 在单 lane 时居中，多 lane 时两端留白", () => {
  expect(laneX(0, 1, 28, 10)).toBe(14);
  expect(laneX(0, 2, 40, 10)).toBe(10);
  expect(laneX(1, 2, 40, 10)).toBe(30);
 });
});
