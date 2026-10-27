import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TEXT } from "./locale";
import { viewMsgsFromJsonlLines } from "./viewmsg";

const zh = TEXT["zh-CN"];

/**
 * 长会话渲染的规模测量（V2 M8）。
 *
 * 用途：决定「要不要上 windowing 虚拟列表」时**先量**——用真实 agentDir 里最大的会话，
 * 量出「读盘 + 归一成 ViewMsg」的成本，以及会落进消息流的条数。
 *
 * 默认跳过（CI 上没有 ~/.omp，也不该让别人的机器数据影响结果）；
 * 需要时显式开：`OMP_BENCH=1 pnpm test src/lib/historyScale.test.ts`。
 * 与后端 `get_history` 的口径对齐：最多 5000 行、最多 2000 条 message/custom 系。
 */

const MAX_LINES = 5000;
const MAX_MSGS = 2000;

function agentDir(): string {
 const env = process.env.PI_CODING_AGENT_DIR?.trim();
 return env && env.length > 0 ? env : path.join(os.homedir(), ".omp", "agent");
}

/** 找最大的那个会话文件（按字节）；找不到返回 null（测试整组跳过）。 */
function largestSession(): { file: string; bytes: number } | null {
 const root = path.join(agentDir(), "sessions");
 let best: { file: string; bytes: number } | null = null;
 const entries = (() => {
  try {
   return fs.readdirSync(root);
  } catch {
   return null;
  }
 })();
 if (!entries) return null;
 for (const slug of entries) {
  const dir = path.join(root, slug);
  const files = (() => {
   try {
    return fs.readdirSync(dir);
   } catch {
    return [];
   }
  })();
  for (const f of files) {
   if (!f.endsWith(".jsonl")) continue;
   const full = path.join(dir, f);
   try {
    const bytes = fs.statSync(full).size;
    if (!best || bytes > best.bytes) best = { file: full, bytes };
   } catch {
    // 读不到就跳过这个文件
   }
  }
 }
 return best;
}

const biggest = largestSession();
const enabled = process.env.OMP_BENCH === "1" && biggest !== null;

describe.skipIf(!enabled)("长会话渲染规模（OMP_BENCH=1 才跑）", () => {
 it("最大会话的归一成本与消息条数在预算内", () => {
  const raw = fs.readFileSync(biggest!.file, "utf8");
  // 与后端 get_history 同口径：最多 5000 行、只回 message/custom/title_change 系、最多 2000 条
  const parsed: unknown[] = [];
  for (const l of raw.split("\n")) {
   if (!l.trim()) continue;
   if (parsed.length >= MAX_LINES) break;
   let v: Record<string, unknown>;
   try {
    v = JSON.parse(l) as Record<string, unknown>;
   } catch {
    continue;
   }
   const t = v.type;
   if (t === "message" || t === "custom" || t === "title_change" || t === "model_change" || t === "thinking_level_change") {
    parsed.push(v);
   }
   if (parsed.length >= MAX_MSGS) break;
  }
  const t0 = performance.now();
  const msgs = viewMsgsFromJsonlLines(parsed, zh);
  const ms = performance.now() - t0;
  const kinds = msgs.reduce<Record<string, number>>((acc, m) => {
   acc[m.kind] = (acc[m.kind] ?? 0) + 1;
   return acc;
  }, {});
  console.log(
   `[bench] ${path.basename(biggest!.file)}：${(biggest!.bytes / 1048576).toFixed(1)}MB / ${parsed.length} 块 → ` +
   `${msgs.length} 条 ViewMsg，归一耗时 ${ms.toFixed(0)}ms；分布 ${JSON.stringify(kinds)}`,
  );
  expect(msgs.length).toBeGreaterThan(0);
  // 归一必须远比渲染便宜：超过 1s 说明要么数据异常，要么归一逻辑退化了
  expect(ms).toBeLessThan(1000);
 });
});
