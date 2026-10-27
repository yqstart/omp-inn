#!/usr/bin/env node
/**
 * 本机发布构建入口（package.json 的 tauri:build）。
 *
 * 为什么需要包装：macOS 上要用「固定身份的自签名证书」签名——macOS 的 TCC 授权
 * （桌面 / 文稿 / 下载文件夹）按签名身份记，ad-hoc 签名的身份是每次构建都变的 cdhash，
 * 系统会当成新 app 反复弹授权；固定证书后授权跨构建与应用内更新保留。
 * 但没装证书的机器（他人 clone、新机器）必须还能正常构建，所以：
 *
 * - 找得到身份（登录钥匙串里有 CN = Apple Development: omp-inn Signing 的完整身份）
 *   → 注入 APPLE_SIGNING_IDENTITY 再构建（tauri 用它签名）；
 * - 找不到 / 非 macOS → 原样构建（tauri.conf.json 的 signingIdentity 是 "-"，
 *   即 ad-hoc 签名，行为与以往一致）。
 *
 * 证书的生成与安装见 scripts/make-signing-cert.sh（一次性）。
 * 参数透传给 `tauri build`（如 --bundles dmg）。
 */
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const IDENTITY = "Apple Development: omp-inn Signing";

const env = { ...process.env };
let found = false;
if (process.platform === "darwin") {
 try {
  const out = execFileSync("security", ["find-identity", "-p", "codesigning"], {
   encoding: "utf8",
  });
  found = out.includes(IDENTITY);
 } catch {
  found = false;
 }
}

if (found) {
 env.APPLE_SIGNING_IDENTITY = IDENTITY;
 console.log(`[tauri-build] 使用签名身份：${IDENTITY}`);
} else if (process.platform === "darwin") {
 console.log(
  "[tauri-build] 未找到签名证书，按 ad-hoc 构建（先跑 bash scripts/make-signing-cert.sh 可获得固定签名身份，TCC 授权不再反复弹）",
 );
}

// 走项目本地 CLI（@tauri-apps/cli 的 bin 是 tauri.js，跨平台无需处理 .cmd）
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve("@tauri-apps/cli/package.json")), "tauri.js");
const child = spawn(process.execPath, [cli, "build", ...process.argv.slice(2)], {
 stdio: "inherit",
 env,
});
child.on("exit", (code, signal) => {
 process.exit(signal ? 1 : (code ?? 0));
});
