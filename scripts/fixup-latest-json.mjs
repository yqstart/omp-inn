#!/usr/bin/env node
/**
 * 把 latest.json 里的 GitHub 资产 API 链接改写为公开下载直链。
 *
 * 为什么需要它：tauri-action v1 生成的 latest.json 里，资产 url 是
 *   https://api.github.com/repos/{owner}/{repo}/releases/assets/{id}
 * REST API 域对匿名请求限流 60 次/小时/**出口 IP**。应用内 updater 的 reqwest
 * 默认启用 `system-proxy`（走系统代理），共享节点 IP 上配额早已被耗尽，
 * 下载就会拿到 403 "API rate limit exceeded"；而检查更新走 github.com 网页域
 * （无限流），于是表现为「检查更新正常、下载 403」。
 *
 * 因此发版后统一改写为 asset 的 browser_download_url（releases/download 直链，
 * GitHub CDN 无限流），由 Release 工作流的 fixup job 调用；已发布版本的存量
 * latest.json 也用同一脚本修补。幂等：非 API 形式的 URL 原样保留。
 *
 * 同一趟里还做一件事：把 `notes` 换成 CHANGELOG 里该版本的整节说明
 * （见 scripts/changelog-notes.mjs）。tauri-action 写的 notes 只是 Release 的
 * releaseBody，应用内更新弹窗拿它当「这次改了什么」显示，等于什么都没说。
 *
 * 用法：node scripts/fixup-latest-json.mjs <latest.json 路径> <tag> [owner/repo]
 *   owner/repo 缺省取 GITHUB_REPOSITORY，再缺省从 git origin 解析。
 *   需要 GITHUB_TOKEN / GH_TOKEN（或已登录的 gh CLI）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { readChangelogSection } from "./changelog-notes.mjs";

/** 只匹配 tauri-action 生成的资产 API 链接；其余 URL 原样保留。 */
const API_ASSET_URL = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/;

function gh(args) {
 try {
  return execFileSync("gh", args, { encoding: "utf8" });
 } catch (e) {
  if (e?.code === "ENOENT") {
   throw new Error("找不到 gh CLI（需要安装并登录，或设置 GH_TOKEN）", { cause: e });
  }
  const detail = e?.stderr?.toString().trim() || e?.message || String(e);
  throw new Error(`gh ${args[0]} 失败：${detail}`, { cause: e });
 }
}

function resolveRepo(repoArg) {
 if (repoArg) return repoArg;
 if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
 const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
 const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
 if (!m) throw new Error(`无法从 origin 解析 owner/repo：${url}`);
 return `${m[1]}/${m[2]}`;
}

function main() {
 const [file, tag, repoArg] = process.argv.slice(2);
 if (!file || !tag) {
  console.error("用法：node scripts/fixup-latest-json.mjs <latest.json 路径> <tag> [owner/repo]");
  process.exit(1);
 }

 const repo = resolveRepo(repoArg);
 const content = JSON.parse(readFileSync(file, "utf8"));
 const platforms = Object.entries(content.platforms ?? {});
 if (platforms.length === 0) throw new Error(`${file} 里没有 platforms 条目`);

 // asset 数字 id → browser_download_url（releases/download 公开直链）
 const releaseId = gh(["api", `repos/${repo}/releases/tags/${tag}`, "--jq", ".id"]).trim();
 const byId = new Map();
 const listing = gh([
  "api",
  `repos/${repo}/releases/${releaseId}/assets?per_page=100`,
  "--paginate",
  "--jq",
  '.[] | "\\(.id)\\t\\(.browser_download_url)"',
 ]);
 for (const line of listing.split("\n")) {
  if (!line) continue;
  const tab = line.indexOf("\t");
  byId.set(line.slice(0, tab), line.slice(tab + 1));
 }
 if (byId.size === 0) throw new Error(`release ${tag} 里没有资产`);

 // notes：换成 CHANGELOG 里该版本的整节说明（应用内更新弹窗显示的就是它）。
 // 版本节缺失会直接抛错——「发版但忘了写更新日志」挡在这里。
 const notes = readChangelogSection(String(content.version ?? tag.replace(/^v/, "")));
 content.notes = notes;

 let rewritten = 0;
 for (const [key, platform] of platforms) {
  const id = typeof platform?.url === "string" ? platform.url.match(API_ASSET_URL)?.[1] : undefined;
  if (!id) continue;
  const direct = byId.get(id);
  if (!direct) {
   throw new Error(`latest.json 的 ${key} 指向资产 ${id}，但 release ${tag} 里不存在（latest.json 与 release 不同步？）`);
  }
  platform.url = direct;
  rewritten += 1;
 }

 writeFileSync(file, JSON.stringify(content, null, 2));
 console.log(`latest.json 资产 URL：${rewritten}/${platforms.length} 个改写为公开直链（${file}）`);
}

try {
 main();
} catch (e) {
 console.error(e instanceof Error ? e.message : String(e));
 process.exit(1);
}
