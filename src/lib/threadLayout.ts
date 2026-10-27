import type { ViewMsg } from "@shared/types";

/** 工具侧消息（聚合与时长行只看它）。 */
type ToolMsg = Extract<ViewMsg, { kind: "tool" }>;

/** 摘要式折叠行的三类（v2 §2.1）：命令批 / 编辑卡 / 任务清单批。 */
export type ToolGroupKind = "commands" | "edits" | "plans";

/** 轮时长的完整跨度（展开态显示起止时刻用）。 */
export type TurnSpan = { ms: number; startAt: number; endAt: number };

/** 消息列的渲染条目：单条消息 / 聚合折叠行 / 轮时长行。 */
export type LayoutItem =
 | { kind: "msg"; m: ViewMsg }
 | { kind: "run"; group: ToolGroupKind; id: string; items: ToolMsg[] }
 | { kind: "turn"; id: string; span: TurnSpan };

/**
 * 一条工具行是否属于某类聚合（不属 = null，保持单行渲染）：
 * - `commands`：bash 类调用（命令批 `Ran N commands`）；
 * - `edits`：写 / 改文件且带行数增量的调用（编辑卡 `Edited N files +X −Y`）；
 * - `plans`：todo 工具调用（任务清单批）——清单**当前状态**由消息列右上角浮卡承载，
 *   这些行只是「动过清单」的痕迹，连成一段折叠。
 */
function groupKindOf(m: ToolMsg): ToolGroupKind | null {
 if (m.name === "bash") return "commands";
 if ((m.name === "edit" || m.name === "write") && m.diffStat) return "edits";
 if (m.name === "todo") return "plans";
 return null;
}

/**
 * 轮时长（v2 §2.1 的 `Worked for …` 行）：每轮 = 一条用户消息到下一次用户消息之前。
 * 返回「该轮最后一条带时间戳的消息的下标 → 时长（毫秒）」，下标只在时长 > 0 时登记。
 * 历史消息的 `at` 来自 jsonl 的 `timestamp`（`lib/viewmsg.ts` 归一），实时消息为到达时刻。
 */
function turnEnds(items: ViewMsg[]): Map<number, TurnSpan> {
 const out = new Map<number, TurnSpan>();
 let startAt: number | null = null;
 let lastAt: number | null = null;
 let lastIdx = -1;
 const flush = () => {
  if (startAt != null && lastAt != null && lastIdx >= 0 && lastAt > startAt) {
   out.set(lastIdx, { ms: lastAt - startAt, startAt, endAt: lastAt });
  }
 };
 for (let i = 0; i < items.length; i++) {
  if (items[i].kind === "user") {
   flush();
   startAt = items[i].at ?? null;
   lastAt = null;
   lastIdx = -1;
   continue;
  }
  const at = items[i].at;
  if (at != null) {
   lastAt = at;
   lastIdx = i;
  }
 }
 flush();
 return out;
}

/**
 * 消息列布局（v2 §2.1 摘要式表达，纯函数、可单测）：
 *
 * 1. **聚合**：相邻的同类工具行（bash ≥2 条 = 命令批；带行数增量的 edit / write ≥2 条 = 编辑卡）
 *    折叠成一条摘要行；单条不聚合（「运行了 1 条命令」比原样一行更啰嗦）。
 * 2. **轮时长**：每个已结束的轮次在其末尾追加一条时长行。`running`（本轮还在跑）时
 *    跳过压在流尾的那一轮——进行中的轮次没有时长可报。
 *
 * 其余消息原样透传（顺序不变），渲染侧只按 `kind` 分发。
 */
export function buildThreadLayout(items: ViewMsg[], running: boolean): LayoutItem[] {
 const ends = turnEnds(items);
 const tailIdx = items.length - 1;
 const out: LayoutItem[] = [];
 const pushTurn = (idx: number) => {
  const span = ends.get(idx);
  if (!span) return;
  if (running && idx === tailIdx) return;
  out.push({ kind: "turn", id: `turn:${idx}`, span });
 };
 let i = 0;
 while (i < items.length) {
  const m = items[i];
  const gk = m.kind === "tool" ? groupKindOf(m) : null;
  if (gk) {
   const run: ToolMsg[] = [];
   let j = i;
   while (j < items.length) {
    const n = items[j];
    if (n.kind !== "tool" || groupKindOf(n) !== gk) break;
    run.push(n);
    j++;
   }
   if (run.length >= 2) {
    out.push({ kind: "run", group: gk, id: `run:${run[0].id}`, items: run });
    pushTurn(j - 1);
    i = j;
    continue;
   }
  }
  out.push({ kind: "msg", m });
  pushTurn(i);
  i++;
 }
 return out;
}

/** 编辑卡 / 命令批的行数增量汇总（`+X −Y`）。 */
export function sumDiff(items: ToolMsg[]): { added: number; removed: number } {
 let added = 0;
 let removed = 0;
 for (const m of items) {
  added += m.diffStat?.added ?? 0;
  removed += m.diffStat?.removed ?? 0;
 }
 return { added, removed };
}
