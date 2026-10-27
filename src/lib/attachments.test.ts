import { describe, expect, it } from "vitest";
import type { ImageAttachment } from "@shared/types";
import { TEXT } from "./locale";
import { ATTACH_MAX_BYTES, bytesToBase64, checkImage, dataUrl, imagesFromContent, mimeFromName, withSlots } from "./attachments";

const zh = TEXT["zh-CN"];
const en = TEXT.en;

/**
 * V2 M6：图片附件的纯逻辑。
 * 关键口径：只认 png/jpeg/webp/gif、单张 ≤ 10MB、历史回放不无上限常驻 base64。
 */
describe("图片附件：类型与体积校验", () => {
 it("由扩展名推 mime，未知扩展名给 null", () => {
  expect(mimeFromName("shot.PNG")).toBe("image/png");
  expect(mimeFromName("a.jpeg")).toBe("image/jpeg");
  expect(mimeFromName("x.webp")).toBe("image/webp");
  expect(mimeFromName("readme.md")).toBeNull();
  expect(mimeFromName("noext")).toBeNull();
 });

 it("非图片类型与超限体积按当前语言给出提示", () => {
  expect(checkImage("a.png", "image/png", 1024, zh)).toBeNull();
  expect(checkImage("a.svg", "image/svg+xml", 1024, zh)).toContain("只支持 PNG");
  expect(checkImage("big.png", "image/png", ATTACH_MAX_BYTES + 1, zh)).toContain("超过 10MB");
  expect(checkImage("a.svg", "image/svg+xml", 1024, en)).toContain("only PNG");
 });
});

describe("图片附件：base64 与 data URL", () => {
 it("bytesToBase64 与已知编码一致（含 padding）", () => {
  expect(bytesToBase64(new Uint8Array([]))).toBe("");
  expect(bytesToBase64(new Uint8Array([104, 105]))).toBe("aGk=");
  expect(bytesToBase64(new Uint8Array([104, 105, 33]))).toBe("aGkh");
  expect(bytesToBase64(new Uint8Array([0xff, 0xd8, 0xff]))).toBe("/9j/");
 });

 it("dataUrl 同时接受 data 与 dataBase64 两种字段名", () => {
  expect(dataUrl({ mimeType: "image/png", data: "AAA" })).toBe("data:image/png;base64,AAA");
  expect(dataUrl({ mimeType: "image/jpeg", dataBase64: "BBB" })).toBe("data:image/jpeg;base64,BBB");
 });
});

describe("图片附件：内容块提取", () => {
 it("只认 image 块，文本/思考块不进图片列表", () => {
  const { images, omitted } = imagesFromContent([
   { type: "text", text: "看图" },
   { type: "image", data: "AAA", mimeType: "image/png" },
   { type: "thinking", thinking: "…" },
  ]);
  expect(images).toEqual([{ mimeType: "image/png", data: "AAA" }]);
  expect(omitted).toBe(0);
 });

 it("兼容 anthropic 风格 source.data / media_type", () => {
  const { images } = imagesFromContent([{ type: "image", source: { data: "ZZZ", media_type: "image/webp" } }]);
  expect(images).toEqual([{ mimeType: "image/webp", data: "ZZZ" }]);
 });

 it("超大块省略并计数（历史回放不许把几十 MB base64 常驻内存）", () => {
  const big = "A".repeat(64);
  const { images, omitted } = imagesFromContent(
   [
    { type: "image", data: big, mimeType: "image/png" },
    { type: "image", data: "small", mimeType: "image/png" },
   ],
   32,
  );
  expect(images).toHaveLength(1);
  expect(images[0].data).toBe("small");
  expect(omitted).toBe(1);
 });

 it("历史 jsonl 的 blob 引用只留 hash，不当 base64 处理", () => {
  const hash = "0123456789abcdef".repeat(4);
  const { images, omitted } = imagesFromContent(
   [
    { type: "image", data: `blob:sha256:${hash}`, mimeType: "image/webp" },
    { type: "image", data: "blob:sha256:XYZ", mimeType: "image/png" },
   ],
   16,
  );
  // blob 引用不受 base64 长度上限影响（实体在 blobs 目录，渲染时才读）
  expect(images).toEqual([{ mimeType: "image/webp", blob: hash }]);
  // 形状不对的 blob 引用无法还原：记省略，不落成坏图
  expect(omitted).toBe(1);
 });

 it("非数组内容（缺失/异常）安全返回空", () => {
  expect(imagesFromContent(undefined)).toEqual({ images: [], omitted: 0 });
  expect(imagesFromContent("nope")).toEqual({ images: [], omitted: 0 });
 });
});

/**
 * 稳定编号（文字里的 `#N` 占位与缩略图角标同源，见 `withSlots` / store `addAttachments`）：
 * 删除图片不重排、不重编号——已经写在正文里的 `#N` 永远指同一张图（编号只在附件清空后从 1 重开）。
 */
describe("图片附件：稳定编号", () => {
 const img = (name: string): ImageAttachment => ({ name, mimeType: "image/png", dataBase64: "", bytes: 0 });

 it("从当前最大编号往后递增；删除后的编号不重用", () => {
  const a = withSlots([], [img("a")]);
  expect(a.map((x) => x.slot)).toEqual([1]);
  const b = withSlots(a, [img("b"), img("c")]);
  expect(b.map((x) => x.slot)).toEqual([2, 3]);
  // 删掉 #1 后再添加（existing 里只剩 #2/#3）：新图接 #4，不回收 #1
  const c = withSlots(b, [img("d")]);
  expect(c.map((x) => x.slot)).toEqual([4]);
 });

 it("已带编号的项原样保留，新项不与之撞号（发送失败回滚 / 队列还原路径）", () => {
  const kept = { ...img("k"), slot: 7 };
  const r = withSlots([{ ...img("x"), slot: 2 }], [kept, img("n")]);
  expect(r[0]).toBe(kept);
  expect(r[1].slot).toBe(8);
 });

 it("附件清空后编号从 1 重开（发送成功即清空）", () => {
  const r = withSlots([], [img("a"), img("b")]);
  expect(r.map((x) => x.slot)).toEqual([1, 2]);
 });
});
