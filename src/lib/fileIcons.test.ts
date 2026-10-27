import { describe, expect, it } from "vitest";
import { iconDataUrl, iconIdFor } from "./fileIcons";
import { MATERIAL_ICON_SVG } from "./materialIcons.generated";

/**
 * Material Icon 取词：完整文件名 → 多段扩展名 → 扩展名 → 默认。
 * 生成表本身是脚本产物，这里只验**回退链**不越界（永远给得出一个存在的图标 id）。
 */
describe("文件图标取词", () => {
 it("扩展名决定图标，大小写不敏感", () => {
  expect(iconIdFor("a.ts", false)).toBe("typescript");
  expect(iconIdFor("A.TSX", false)).toBe("react_ts");
  expect(iconIdFor("notes.md", false)).toBe("markdown");
  expect(iconIdFor("logo.svg", false)).toBe("svg");
 });

 it("完整文件名优先于扩展名", () => {
  // package.json 是 node 图标、readme.md 是 readme 图标，都不是扩展名图标
  expect(iconIdFor("package.json", false)).toBe("nodejs");
  expect(iconIdFor("package.json", false)).not.toBe(iconIdFor("other.json", false));
  expect(iconIdFor("README.md", false)).toBe("readme");
 });

 it("多段扩展名先长后短", () => {
  expect(iconIdFor("types.d.ts", false)).toBe("typescript-def");
  // 退不到 `d.ts` 时退到 `ts`（不是直接回默认图标）
  expect(iconIdFor("index.ts", false)).toBe("typescript");
 });

 it("前导点的隐藏文件不当扩展名", () => {
  // `.gitignore` 按文件名命中；退不到扩展名链时也只回默认图标
  expect(iconIdFor(".gitignore", false)).toBe("git");
  expect(iconIdFor(".unknown-hidden", false)).toBe("file");
 });

 it("目录走目录表，展开态换 open 变体，认不出退回默认", () => {
  expect(iconIdFor("src", true)).toBe("folder-src");
  expect(iconIdFor("src", true, true)).toBe("folder-src-open");
  expect(iconIdFor("项目目录", true)).toBe("folder");
  expect(iconIdFor("项目目录", true, true)).toBe("folder-open");
 });

 it("认不出的名字一律回退默认图标（表里一定存在）", () => {
  for (const [name, isDir] of [["weird.zzz", false], ["无扩展名", false], ["whatever", true]] as const) {
   const id = iconIdFor(name, isDir);
   expect(MATERIAL_ICON_SVG[id]).toBeTruthy();
  }
 });

 it("data URL 是 svg 且带缓存（同一 id 同值、不重复编码）", () => {
  const url = iconDataUrl("typescript");
  expect(url.startsWith("data:image/svg+xml;utf8,")).toBe(true);
  expect(decodeURIComponent(url.split(",")[1] ?? "")).toContain("<svg");
  expect(iconDataUrl("typescript")).toBe(url);
  // 查不到的 id 回退默认文件图标，不抛
  expect(iconDataUrl("__nope__")).toBe(iconDataUrl("file"));
 });
});
