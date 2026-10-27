import { describe, expect, it } from "vitest";
import {
 clampToGrapheme,
 nextRevealLength,
 REVEAL_CATCHUP_FRAMES,
 REVEAL_FLUSH_CHARS,
 REVEAL_SNAP_CHARS,
} from "./streamReveal";

describe("nextRevealLength", () => {
 it("complete 立即全量；文本被替换（target < shown）直接收敛", () => {
  expect(nextRevealLength(0, 100, true)).toBe(100);
  expect(nextRevealLength(100, 40, false)).toBe(40);
  expect(nextRevealLength(100, 100, false)).toBe(100);
 });

 it("小积压（≤ 落定阈值）直接显示全量：连续流零滞后", () => {
  expect(nextRevealLength(0, 1, false)).toBe(1);
  expect(nextRevealLength(0, REVEAL_SNAP_CHARS, false)).toBe(REVEAL_SNAP_CHARS);
  expect(nextRevealLength(10, 10 + REVEAL_SNAP_CHARS, false)).toBe(10 + REVEAL_SNAP_CHARS);
 });

 it("超大积压（> 整段落定阈值）整段落下：不逐帧倾倒", () => {
  expect(nextRevealLength(0, REVEAL_FLUSH_CHARS + 1, false)).toBe(REVEAL_FLUSH_CHARS + 1);
 });

 it("中间档积压按 8 帧追赶：每帧至少 1 字符、至多 backlog/8", () => {
  const gap = REVEAL_SNAP_CHARS + 1; // 刚过落定阈值：步长 = ceil(gap/8)
  expect(nextRevealLength(0, gap, false)).toBe(Math.ceil(gap / REVEAL_CATCHUP_FRAMES));
  expect(nextRevealLength(0, 80, false)).toBe(10);
  expect(nextRevealLength(90, 170, false)).toBe(100);
 });

 it("中间档积压在 ~32 帧内完全落定（有界倾倒，不含尾部爬行）", () => {
  let shown = 0;
  const target = REVEAL_FLUSH_CHARS;
  let frames = 0;
  while (shown < target && frames < 60) {
   shown = nextRevealLength(shown, target, false);
   frames++;
  }
  expect(frames).toBeLessThanOrEqual(32);
 });

 it("连续小增量（每帧到达 1–4 字符）不产生可感知滞后", () => {
  // 模拟：目标每帧 +4，揭示每帧推进一步（4 ≤ 落定阈值 → 每帧直接追平）
  let target = 0;
  let shown = 0;
  for (let i = 0; i < 60; i++) {
   target += 4;
   shown = nextRevealLength(shown, target, false);
   expect(target - shown).toBe(0);
  }
 });
});

describe("clampToGrapheme", () => {
 it("普通文本原样返回；越界原样返回", () => {
  expect(clampToGrapheme("你好世界", 2)).toBe(2);
  expect(clampToGrapheme("abc", 0)).toBe(0);
  expect(clampToGrapheme("abc", 3)).toBe(3);
 });

 it("不切代理对（emoji）", () => {
  const s = "a😀b";
  // "😀" 占两个 UTF-16 码元：[1,3)；切在 2 会把代理对劈开 → 收到 1
  expect(clampToGrapheme(s, 2)).toBe(1);
  expect(clampToGrapheme(s, 1)).toBe(1);
  expect(clampToGrapheme(s, 3)).toBe(3);
 });

 it("不切组合记号（音标 / 变体选择符）", () => {
  const s = "e\u0301x"; // é = e + combining acute
  expect(clampToGrapheme(s, 1)).toBe(0);
  const vs = "❤\ufe0fx"; // 心 + 变体选择符
  expect(clampToGrapheme(vs, 1)).toBe(0);
 });

 it("不切 ZWJ 序列（家庭 emoji）", () => {
  const family = "👨\u200d👩\u200dx";
  // 切在 ZWJ 之后（index 2 处是 ZWJ）不允许
  const cut = clampToGrapheme(family, 2);
  expect(cut).toBe(0);
 });
});
