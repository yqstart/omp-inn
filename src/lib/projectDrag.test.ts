import { describe, expect, it } from "vitest";
import type { ProjectView } from "@shared/types";
import { pickDropTarget, planProjectMove, type ProjectDropHit } from "./projectDrag";

const P = (id: string, workspaceId: string | null = null): ProjectView => ({
 id,
 path: `/${id}`,
 name: id.toUpperCase(),
 missing: false,
 sessionCount: 0,
 workspaceId,
});

/** 一行（视觉顺序里必须与容器一起喂入）。 */
const row = (projectId: string, containerId: string | null, top: number, bottom: number): ProjectDropHit =>
 ({ kind: "row", projectId, containerId, top, bottom });
/** 容器（组头 / 空组 / 组的空白区）。 */
const box = (containerId: string | null, top: number, bottom: number): ProjectDropHit =>
 ({ kind: "container", containerId, top, bottom });

describe("落点判定（指针位置 → 目标容器 / 边界）", () => {
 it("行内上半 → 插到该行之前；下半 → 插到下一行之前", () => {
  const hits = [box(null, 0, 90), row("a", null, 0, 30), row("b", null, 30, 60), row("c", null, 60, 90)];
  expect(pickDropTarget(hits, 10, "c")).toEqual({ containerId: null, beforeId: "a" });
  // 拖 b 悬在 a 的下半：下一个是 b 自己（跳过）→ c
  expect(pickDropTarget(hits, 25, "b")).toEqual({ containerId: null, beforeId: "c" });
  // 拖动行占位也在列表里，但判定永远把它跳过去
  expect(pickDropTarget(hits, 70, "b")).toEqual({ containerId: null, beforeId: "c" });
 });

 it("悬在被拖项目自己身上 = 不定落点（松开原地不动）", () => {
  const hits = [row("a", null, 0, 30), row("b", null, 30, 60)];
  expect(pickDropTarget(hits, 40, "b")).toBeNull();
 });

 it("悬在最后一行下半 → 容器末尾（beforeId = null）", () => {
  const hits = [row("a", null, 0, 30), row("b", null, 30, 60)];
  expect(pickDropTarget(hits, 55, "a")).toEqual({ containerId: null, beforeId: null });
 });

 it("容器命中（组头 / 空组 / 组的空白）→ 容器末尾", () => {
  const hits = [box("w1", 0, 200), row("b", "w1", 40, 70)];
  expect(pickDropTarget(hits, 20, "a")).toEqual({ containerId: "w1", beforeId: null });
  expect(pickDropTarget(hits, 180, "a")).toEqual({ containerId: "w1", beforeId: null });
  // 悬在别的容器的行上 → 落点跟着那一行走（含归属切换）
  expect(pickDropTarget(hits, 50, "a")).toEqual({ containerId: "w1", beforeId: "b" });
 });

 it("缝隙（组间距 / 列表底部留白）归上方最近的一条", () => {
  const hits = [box("w1", 0, 100), row("a", "w1", 20, 50), box(null, 104, 200), row("d", null, 120, 150)];
  // 两组之间的 4px 缝隙：归 w1 的最后一行之后（= w1 末尾）
  expect(pickDropTarget(hits, 102, "z")).toEqual({ containerId: "w1", beforeId: null });
  // 列表底部留白：归未分组容器末尾
  expect(pickDropTarget(hits, 300, "z")).toEqual({ containerId: null, beforeId: null });
  // 整个列表上方 → 无落点
  const noAbove = [row("a", null, 100, 130)];
  expect(pickDropTarget(noAbove, 50, "z")).toBeNull();
 });
});

describe("落地计划（新顺序 + 新归属）", () => {
 it("同容器重排：插到目标行之前", () => {
  const plan = planProjectMove([P("a"), P("b"), P("c")], "a", { containerId: null, beforeId: "c" });
  expect(plan.order).toEqual(["b", "a", "c"]);
  expect(plan.containerId).toBeNull();
  expect(plan.changed).toBe(true);
 });

 it("原地松开（顺序与归属都没变）→ changed = false", () => {
  const plan = planProjectMove([P("a"), P("b"), P("c")], "a", { containerId: null, beforeId: "b" });
  expect(plan.order).toEqual(["a", "b", "c"]);
  expect(plan.changed).toBe(false);
  const tail = planProjectMove([P("a"), P("b")], "b", { containerId: null, beforeId: null });
  expect(tail.order).toEqual(["a", "b"]);
  expect(tail.changed).toBe(false);
 });

 it("拖进工作区（指定位置）：顺序里插到目标行之前，归属改为该组", () => {
  const plan = planProjectMove([P("a", "w1"), P("b", "w1"), P("c")], "c", { containerId: "w1", beforeId: "a" });
  expect(plan.order).toEqual(["c", "a", "b"]);
  expect(plan.containerId).toBe("w1");
  expect(plan.changed).toBe(true);
 });

 it("拖进工作区（容器末尾）：排在组内最后一个成员之后；组里没有别的成员 → 数组末尾", () => {
  const into = planProjectMove([P("a", "w1"), P("b", "w1"), P("c")], "c", { containerId: "w1", beforeId: null });
  expect(into.order).toEqual(["a", "b", "c"]);
  expect(into.containerId).toBe("w1");
  expect(into.changed).toBe(true); // 顺序没变，归属变了
  const empty = planProjectMove([P("a", "w1"), P("b")], "b", { containerId: "w2", beforeId: null });
  expect(empty.order).toEqual(["a", "b"]);
  expect(empty.containerId).toBe("w2");
 });

 it("拖出工作区（未分组容器末尾）：排在未分组最后一个成员之后", () => {
  const plan = planProjectMove([P("a", "w1"), P("b", "w1"), P("c")], "a", { containerId: null, beforeId: null });
  expect(plan.order).toEqual(["b", "c", "a"]);
  expect(plan.containerId).toBeNull();
  expect(plan.changed).toBe(true);
 });

 it("beforeId 指向别的容器的项目（脏输入）→ 退回目标容器末尾规则", () => {
  const plan = planProjectMove([P("a", "w1"), P("b"), P("c")], "c", { containerId: "w1", beforeId: "b" });
  // b 不在 w1：按「w1 末尾」算 → 排在 a 之后
  expect(plan.order).toEqual(["a", "c", "b"]);
  expect(plan.containerId).toBe("w1");
 });

 it("被拖项目不存在 → 原样返回（changed = false）", () => {
  const plan = planProjectMove([P("a"), P("b")], "ghost", { containerId: "w1", beforeId: null });
  expect(plan.order).toEqual(["a", "b"]);
  expect(plan.changed).toBe(false);
 });
});
