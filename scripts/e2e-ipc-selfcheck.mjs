#!/usr/bin/env node
/**
 * e2e:ipc 自检：校验前后端 IPC 契约（命令名 / 事件名）的**双向一致性**。
 *
 * 三个来源互为真相，任一方向断链都失败：
 *   1. `src/shared/ipc.ts` 的命令常量表（前端 API 层 `api.ts` 只用它，不再写裸字符串）；
 *   2. `src-tauri/src/main.rs` 的 `generate_handler![...]` 注册表；
 *   3. 后端各 `.rs` 文件里的 `fn <命令名>` 实现。
 *
 * 纯静态检查（读文件，不启动进程）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fail = (msg) => {
 console.error(`e2e:ipc 失败：${msg}`);
 process.exit(1);
};

const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const ipc = read("src/shared/ipc.ts");
const api = read("src/shared/api.ts");
const mainRs = read("src-tauri/src/main.rs");
const rsFiles = ["commands/mod.rs", "providers.rs", "memories.rs", "usage.rs", "settings.rs", "system_permissions.rs", "models_config.rs", "constraints.rs", "provider_models.rs", "git_commit.rs", "git_ops.rs", "git_graph.rs", "commit_msg.rs", "provider_usage.rs", "title_prompt.rs", "project_files.rs", "plugins.rs", "skills.rs", "omp_update.rs", "context.rs", "pty.rs", "workspace_fs.rs", "project_scripts.rs", "live_stats.rs", "images.rs", "storage.rs", "remote/mod.rs"]
 .map((f) => read(`src-tauri/src/${f}`));
const providersRs = rsFiles[1];

// 1) ipc.ts 的命令常量（`// commands` 到 `// events` 之间）：key -> 命令名
const cmdSection = ipc.split("// commands")[1]?.split("// events")[0];
if (!cmdSection) fail("ipc.ts 里找不到命令常量区段（// commands ... // events）");
const ipcCmds = new Map();
for (const m of cmdSection.matchAll(/^\s*([A-Za-z0-9_]+):\s*"([a-z0-9_]+)",/gm)) {
 ipcCmds.set(m[1], m[2]);
}
if (ipcCmds.size < 30) fail(`ipc.ts 命令常量过少（${ipcCmds.size}），解析可能失效`);

// 2) main.rs 注册表：generate_handler![...] 内的命令（允许 `mod::name` 前缀；末项无逗号）
//    先剥行注释与块注释：注释里的版本号（如「V32」）会被逐词扫描误当命令名（真出过一次）
const handlerBlock = mainRs
 .match(/generate_handler!\[([\s\S]*?)\]/)?.[1]
 ?.replace(/\/\/[^\n]*/g, "")
 .replace(/\/\*[\s\S]*?\*\//g, "");
if (!handlerBlock) fail("main.rs 里找不到 generate_handler![...]");
const registered = new Set(
 [...handlerBlock.matchAll(/(?:[a-z_]+::)?([a-z0-9_]+)/g)].map((m) => m[1]),
);

// 3) 双向核对
for (const [key, name] of ipcCmds) {
 if (!registered.has(name)) fail(`ipc.ts 有 ${key}("${name}")，但 main.rs 未注册`);
}
for (const name of registered) {
 if (![...ipcCmds.values()].includes(name)) {
  fail(`main.rs 注册了 ${name}，但 ipc.ts 命令常量里没有（前端没有契约锚点）`);
 }
}
// 4) 每个命令必须有后端实现
for (const name of registered) {
 const hasImpl = rsFiles.some((f) => new RegExp(`fn ${name}\\s*[(<]`).test(f));
 if (!hasImpl) fail(`后端缺少实现 fn ${name}`);
}
// 5) api.ts 只用 IPC 常量，不许写裸命令名字符串
for (const [key, name] of ipcCmds) {
 if (api.includes(`"${name}"`)) fail(`api.ts 仍写死裸命令名 "${name}"（应改用 IPC.${key}）`);
}

// 6) 供应商登录进度事件：常量在 ipc.ts，字面量在后端 providers.rs，两边必须一致
const LOGIN_EVENT = "omp-provider://login";
if (!ipc.includes(`providerLogin: "${LOGIN_EVENT}"`)) fail(`ipc.ts 缺少供应商登录事件 ${LOGIN_EVENT}`);
if (!providersRs.includes(`PROVIDER_LOGIN_EVENT: &str = "${LOGIN_EVENT}"`)) {
 fail(`providers.rs 的登录事件通道与 ipc.ts 不一致`);
}
// 6b) 模型目录刷新事件（后端单飞 + 缓存后广播成绩快照）：常量在 ipc.ts，字面量在 commands/mod.rs
const commandsRs = rsFiles[0];
const MODELS_EVENT = "omp-models://catalog";
if (!ipc.includes(`modelsRefreshed: "${MODELS_EVENT}"`)) fail(`ipc.ts 缺少模型目录事件 ${MODELS_EVENT}`);
if (!commandsRs.includes(`MODELS_EVENT: &str = "${MODELS_EVENT}"`)) {
 fail(`commands/mod.rs 的目录事件通道与 ipc.ts 不一致`);
}
// 7) 登录 / 登出必须走 auth-broker CLI（RPC 模式在"一个都没登录"的环境里起不来）
for (const sub of ['"auth-broker", "login"', '"auth-broker", "logout"', '"auth-broker", "list"']) {
 if (!providersRs.includes(sub)) fail(`providers.rs 未按 auth-broker CLI 调 ${sub}`);
}
console.log(`e2e:ipc 通过：${ipcCmds.size} 命令 × 双向一致（ipc.ts ↔ main.rs ↔ 实现）+ 事件 3 项`);
