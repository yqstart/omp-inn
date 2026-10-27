import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TEXT } from "./locale";
import { viewMsgsFromJsonlLines } from "./viewmsg";
import type { ViewMsg } from "@shared/types";

const zh = TEXT["zh-CN"];

/**
 * DoD §13「`omp render --plain` 对拍：同一会话文本一致」。
 *
 * 做法：取本机真实会话 jsonl，用我们的归一路径（`viewMsgsFromJsonlLines`，历史回放与
 * 实时流共用）抽出用户/助手文本，再断言这些片段确实出现在 `omp render --plain` 的
 * 输出里。对拍的意义是证明「app 里的文本 = omp 自己认的文本」，不是逐字节相同——
 * 终端渲染有宽度截断与省略号，所以按片段命中率判定（阈值 0.8）。
 *
 * **只对拍「会话头 + 前 `HEAD_ENTRIES` 条」这个切片，且样例也只从这份切片里取**：
 * `omp render --plain` 是**视口渲染**——它拼一帧就 emit，超长线程的后续内容根本不出现
 * （实测 1.9MiB 会话：`-w 200` 下 emit 到十几万字符就停住，越靠后的内容越可能缺席，而
 * emit 长度还随调用方进程的 TTY/终端尺寸而异）。对着整份长会话断言「每条用户消息都出现」，
 * 等于把「样例是否命中」变成线程长度与运行环境的函数：同一份数据在本机 vitest 里时红时绿
 * （`pnpm check` 会莫名失败）。切到定长头部切片后，每个环境拿到的是同一份短线程，断言恢复
 * 确定性；代价是不再比对被截掉的历史中段。
 *
 * 本机没有 omp / 没有会话目录时整组跳过（CI 上无 omp，不因环境缺依赖失败）。
 */
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME ?? "", ".omp", "agent");
const SESSIONS = path.join(AGENT_DIR, "sessions");
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 对拍切片长度：够覆盖用户消息 + 工具调用，又短到视口渲染能整段 emit 出来。 */
const HEAD_ENTRIES = 40;

function collectSessions(): string[] {
 if (!fs.existsSync(SESSIONS)) return [];
 const out: string[] = [];
 for (const slug of fs.readdirSync(SESSIONS)) {
  const dir = path.join(SESSIONS, slug);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
   if (!f.endsWith(".jsonl")) continue;
   const p = path.join(dir, f);
   const size = fs.statSync(p).size;
   if (size === 0 || size > MAX_FILE_BYTES) continue;
   out.push(p);
  }
 }
 return out.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

const hasOmp = (() => {
 try {
  execFileSync("omp", ["--version"], { stdio: "ignore" });
  return true;
 } catch {
  return false;
 }
})();

const norm = (s: string) => s.replace(/\s+/g, "");

/**
 * 正文比对专用归一：只留文字与数字（连标点一起去掉）。
 *
 * 原因：`omp render --plain` 把消息按 **Markdown 渲染**，格式字符在渲染侧消失——
 * jsonl 里的 ``Use parallel `task` research agents`` 渲染出来是 `Use parallel task research agents`。
 * 逐字符比对只要样例里出现反引号 / 加粗星号 / 链接括号就必然假阴性（实测本机会话里就有）。
 * 工具名比对仍用 `norm`：它依赖「• <name>」里的 `•` 这个标点。
 *
 * **图片标记要先抹掉再比**：omp 自己的转录（jsonl 文本）里是 `[Image #1, 1159x200]`，
 * 而它自己的 `omp render --plain` 把它画成 `🖼 #1`——同一处内容两种写法（实测：本机一条
 * 首条消息带粘贴图片的会话里，样例开头正好是「如图[Image #1, 1159x200]…」，
 * 渲染输出里却只有「如图🖼 #1…」，于是硬断言必然假阴性）。两边各自抹掉自己的写法。
 */
const content = (s: string) =>
 s
  .replace(/\[Image #\d+[^\]]*\]/g, "")
  .replace(/🖼\s*#\d+/gu, "")
  .replace(/[^\p{L}\p{N}]+/gu, "");

/** 会话头 + 前 `HEAD_ENTRIES` 条的定长切片（对拍输入与取样判据共用同一份）。 */
function sliceOf(file: string): string[] {
 const all = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
 // 会话头（`type:"session"`）必带：渲染与归一路径都靠它认 cwd / id / 起始时间
 const header = all.find((l) => l.includes('"type":"session"'));
 return header ? [header, ...all.filter((l) => l !== header).slice(0, HEAD_ENTRIES)] : all.slice(0, HEAD_ENTRIES);
}

function parseSlice(lines: string[]): unknown[] {
 return lines
  .map((l) => {
   try {
    return JSON.parse(l) as unknown;
   } catch {
    return null;
   }
  })
  .filter((v): v is unknown => v !== null);
}

/** 切片里是否有够长的用户文本（对拍的硬断言以此为前提）。 */
function hasUserSample(file: string): boolean {
 const ours = viewMsgsFromJsonlLines(parseSlice(sliceOf(file)), zh);
 return ours.some((m) => m.kind === "user" && content(m.text).length >= 12);
}

/**
 * 取样：最近 `CANDIDATES` 个会话里挑出「切片内确有用户文本」的最多 3 个。
 * 跳过刚建好还没说话的会话（新建会话可能只写了头，前 40 条里一条 user 文本都没有）——
 * 否则「必须有用户样例」的断言会随本机会话目录的状态时红时绿（与切片长度同理）。
 */
const CANDIDATES = 20;
const cases = collectSessions()
 .slice(0, CANDIDATES)
 .filter((f) => {
  try {
   return hasUserSample(f);
  } catch {
   return false;
  }
 })
 .slice(0, 3);

describe.skipIf(!hasOmp || cases.length === 0)("omp render --plain 对拍", () => {
 for (const file of cases) {
  it(`会话 ${path.basename(file).slice(0, 22)}… 文本与 omp 渲染一致`, () => {
   const lines = sliceOf(file);
   const ours = viewMsgsFromJsonlLines(parseSlice(lines), zh);
   // 切片写进临时文件再渲染：渲染输出只取决于线程长度，不再取决于调用方终端
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-parity-"));
   const head = path.join(dir, path.basename(file));
   fs.writeFileSync(head, `${lines.join("\n")}\n`);
   let rendered: string;
   try {
    // 宽度拉大：终端默认宽度会折行/省略，容易把片段切碎（但长消息仍可能被 omp 折叠）
    rendered = execFileSync("omp", ["render", "--plain", "-w", "200", head], {
     encoding: "utf8",
     maxBuffer: 64 * 1024 * 1024,
     timeout: 60_000,
    });
   } finally {
    fs.rmSync(dir, { recursive: true, force: true });
   }
   const hay = norm(rendered);
   // omp 渲染会把 Markdown 格式字符吃掉，正文比对降到「只留文字数字」层（见 content 的说明）
   const hayContent = content(rendered);
   // 用户消息在 omp 渲染里总是完整出现：必须全部命中
   const userSamples = ours
    .filter((m): m is Extract<ViewMsg, { kind: "user" }> => m.kind === "user")
    .map((m) => content(m.text))
    .filter((t) => t.length >= 12)
    .map((t) => t.slice(0, 20));
   expect(userSamples.length).toBeGreaterThan(0);
   const userHit = userSamples.filter((s) => hayContent.includes(s));
   expect(userHit.length).toBe(userSamples.length);
   // 工具调用：omp 的 transcript 用「• <name>」标出，我们归一出的是同一批 tool 卡
   const toolNames = [
    ...new Set(
     ours
      .filter((m) => m.kind === "tool")
      .map((m) => (m as { name: string }).name)
      .filter((n) => n && n !== "tool"),
    ),
   ];
   if (toolNames.length > 0) {
    // render 会把同名工具折叠成「• Read (2)」这类汇总行、被中断 turn 里的工具也不显示，
    // 所以按命中率判（真实会话实测约 0.5–1.0），不作为硬性一致条件。
    // 标点有两副：`•`（汇总行）与 `●`（单条调用带参数）——实测同一会话里两种并存，
    // 只认 `•` 会在「这个切片里唯一的工具调用恰好画成 ●」时假阴性（本机一条最小会话即如此）。
    const toolHit = toolNames.filter((n) => {
     const name = n.toLowerCase();
     return hay.toLowerCase().includes(`•${name}`) || hay.toLowerCase().includes(`●${name}`);
    });
    expect(toolHit.length).toBeGreaterThanOrEqual(1);
   }
   // 助手正文不做断言：`omp render` 对长回复有折叠（⟦Ctrl+O: Expand⟧）、被中断的
   // 回复甚至不进 transcript，逐片段比对会假阴性。用户消息 + 工具名已能证明
   // 「app 解析出的会话内容 = omp 自己认的内容」。
  });
 }
});
