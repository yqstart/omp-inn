#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 抽出某个版本的更新说明（整节正文，去掉版本标题行本身）。
 *
 * 为什么需要它：tauri-action 生成的 latest.json 里 notes 原先只是 Release 的
 * releaseBody（一句「见 CHANGELOG.md。」），应用内更新弹窗拿到它等于什么都没说
 * ——用户看不到这个版本到底改了什么。发版工作流改用本脚本抽出的版本节喂给
 * releaseBody，末尾的 fixup job 再用同一个函数把 notes 回填进 latest.json；
 * 存量 release 的 latest.json 也用同一路径修补。
 *
 * 用法：node scripts/changelog-notes.mjs [version] [changelog 路径]
 *   version 缺省取 package.json 的版本；changelog 缺省取仓库根的 CHANGELOG.md。
 *   版本节不存在、或该节没有正文 → 非零退出（把坏说明挡在发布之前）。
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = new URL("..", import.meta.url);

/**
 * 抽出 `## [x.y.z] - date` 这一节的正文（到下一个二级标题为止，两端去空行）。
 * 找不到版本节或正文为空时抛错。
 * @param {string} markdown CHANGELOG 全文
 * @param {string} version 目标版本（可带前导 `v`）
 * @returns {string} 该版本的更新说明（Markdown）
 */
export function changelogSection(markdown, version) {
 const wanted = version.replace(/^v/, "");
 const heading = new RegExp(`^##\\s*\\[?v?${wanted.replace(/\./g, "\\.")}\\]?(?=\\s|$)`);
 const lines = markdown.split(/\r?\n/);
 const start = lines.findIndex((line) => heading.test(line));
 if (start < 0) {
  const known = lines
   .map((line) => line.match(/^##\s+\[?([^\]\s]+)\]?/)?.[1])
   .filter(Boolean)
   .join(" / ");
  throw new Error(`CHANGELOG 里没有 ${wanted} 的版本节（现有：${known || "无二级标题"}）`);
 }
 let end = lines.length;
 for (let i = start + 1; i < lines.length; i += 1) {
  if (/^##\s/.test(lines[i])) {
   end = i;
   break;
  }
 }
 const body = lines.slice(start + 1, end).join("\n").trim();
 if (!body) throw new Error(`CHANGELOG 里 ${wanted} 的版本节是空的——先把这一版改了什么写进去`);
 return body;
}

/**
 * 读 CHANGELOG 文件并抽出目标版本的说明。
 * @param {string} version 目标版本
 * @param {string} [file] CHANGELOG 路径（缺省 = 仓库根 CHANGELOG.md）
 * @returns {string}
 */
export function readChangelogSection(version, file = fileURLToPath(new URL("CHANGELOG.md", REPO_ROOT))) {
 return changelogSection(readFileSync(file, "utf8"), version);
}

/** CLI 入口：把版本节写到 stdout（被 import 时不执行）。 */
function main() {
 const [versionArg, file] = process.argv.slice(2);
 try {
  const version = versionArg ?? JSON.parse(readFileSync(fileURLToPath(new URL("package.json", REPO_ROOT)), "utf8")).version;
  process.stdout.write(`${readChangelogSection(version, file)}\n`);
 } catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
 }
}

/**
 * 是否是「直接执行本文件」——被 import（如 fixup-latest-json.mjs、omp 自己的 bun 运行时）时不跑 CLI。
 * `realpathSync` 包 try：argv[1] 可能是 Bun 单文件二进制里的虚拟路径（/$bunfs/...）而非真实文件。
 */
function isDirectRun() {
 const arg = process.argv[1];
 if (!arg) return false;
 try {
  if (import.meta.url === pathToFileURL(realpathSync(arg)).href) return true;
 } catch {
  // 不落地于真实文件系统的 argv[1]，退回字面比较
 }
 return import.meta.url === pathToFileURL(arg).href;
}

if (isDirectRun()) main();
