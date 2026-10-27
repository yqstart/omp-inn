import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { changelogSection, readChangelogSection } from "./changelog-notes.mjs";

const SAMPLE = [
 "# 更新日志",
 "",
 "## [Unreleased]",
 "",
 "## [2.0.0] - 2026-10-01",
 "",
 "### Added",
 "- 三号版本的新东西。",
 "",
 "## [1.1.0] - 2026-09-23",
 "",
 "### Added",
 "- 二号版本的新东西。",
 "",
 "### Changed",
 "- 二号版本的改动。",
 "",
 "## [1.0.0] - 2026-09-22",
 "",
 "首个版本。",
 "",
].join("\n");

describe("CHANGELOG 版本节抽取", () => {
 it("只取目标版本那一节，剥掉版本标题与相邻版本", () => {
  expect(changelogSection(SAMPLE, "1.1.0")).toBe("### Added\n- 二号版本的新东西。\n\n### Changed\n- 二号版本的改动。");
 });

 it("接受带前导 v 的版本号", () => {
  expect(changelogSection(SAMPLE, "v1.0.0")).toBe("首个版本。");
 });

 it("版本号不被前缀匹配：查 1.1 不命中 1.1.0", () => {
  expect(() => changelogSection(SAMPLE, "1.1")).toThrow(/没有 1\.1 的版本节/);
 });

 it("版本节缺失时报错并列出已有版本", () => {
  expect(() => changelogSection(SAMPLE, "9.9.9")).toThrow(/现有：Unreleased \/ 2\.0\.0 \/ 1\.1\.0 \/ 1\.0\.0/);
 });

 it("版本节没有正文时报错（发版守卫要挡住「空说明」）", () => {
  const empty = "# 更新日志\n\n## [1.0.0] - 2026-01-01\n\n## [0.9.0] - 2025-12-01\n\n- 旧版。\n";
  expect(() => changelogSection(empty, "1.0.0")).toThrow(/版本节是空的/);
 });

 it("真实 CHANGELOG.md 能抽出当前版本，正文里没有二级标题", () => {
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const notes = readChangelogSection(version);
  expect(notes.length).toBeGreaterThan(80);
  expect(notes.split("\n").filter((line) => /^##\s/.test(line))).toEqual([]);
 });
});
