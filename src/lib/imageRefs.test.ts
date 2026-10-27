import { describe, expect, it } from "vitest";
import type { ImageAttachment } from "@shared/types";
import { imageOrderNote, stripImageOrderNote, withImageOrderNote } from "./imageRefs";

const img = (slot: number): ImageAttachment => ({
 name: `img-${slot}.png`,
 mimeType: "image/png",
 dataBase64: "AAAA",
 bytes: 3,
 slot,
});

describe("图片附件 #N 的发送侧顺序注记", () => {
 it("正文引用 #N → 按图片数组顺序补注记（含删除后的空洞）", () => {
  const images = [img(1), img(3)];
  expect(imageOrderNote("如图#1，另见 #3", images)).toBe("\n\n[omp image order: #1=image 1, #3=image 2]");
 });

 it("正文没引用附件编号 / 没有图片 → 不补注记", () => {
  expect(imageOrderNote("看看这两张图", [img(1), img(2)])).toBe("");
  expect(imageOrderNote("如图#1", [])).toBe("");
 });

 it("只列被引用到的附件，且按图片顺序（不是正文出现顺序）", () => {
  expect(imageOrderNote("先看 #3 再看 #1", [img(1), img(2), img(3)])).toBe(
   "\n\n[omp image order: #1=image 1, #3=image 3]",
  );
  expect(imageOrderNote("只看 #2", [img(1), img(2), img(3)])).toBe("\n\n[omp image order: #2=image 2]");
 });

 it("不去碰色值 / issue 号 / 路径里的 #", () => {
  // #123456 不是附件编号；@foo#1.png 的 # 前面是字母（路径的一部分）
  expect(imageOrderNote("颜色 #123456，见 @foo#1.png 和 issue #1", [img(1)])).toBe(
   "\n\n[omp image order: #1=image 1]",
  );
  expect(imageOrderNote("见 @foo#1.png", [img(1)])).toBe("");
  // 标签 / 带前导零的写法不是壳分配的 #N
  expect(imageOrderNote("见 #1a 和 #01", [img(1)])).toBe("");
 });

 it("重复引用只列一次；中文紧邻 # 也能识别", () => {
  expect(imageOrderNote("如图#1、再如图 #1 和#2", [img(1), img(2)])).toBe(
   "\n\n[omp image order: #1=image 1, #2=image 2]",
  );
 });

 it("withImageOrderNote = 正文 + 注记；无引用时原样", () => {
  expect(withImageOrderNote("如图#1", [img(1)])).toBe("如图#1\n\n[omp image order: #1=image 1]");
  expect(withImageOrderNote("你好", [img(1)])).toBe("你好");
 });

 it("stripImageOrderNote 只剥我们补的那一行（历史 / 队列展示用）", () => {
  const text = "如图#1\n\n[omp image order: #1=image 1, #3=image 2]";
  expect(stripImageOrderNote(text)).toBe("如图#1");
  // 用户自己写的普通结尾不受影响
  expect(stripImageOrderNote("普通文本\n\n第二段")).toBe("普通文本\n\n第二段");
  expect(stripImageOrderNote("如图#1 [omp image order: 随便写的]")).toBe("如图#1 [omp image order: 随便写的]");
 });
});
