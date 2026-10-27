import { api } from "@shared/api";
import { useApp } from "../stores/app";
import { forgetSession } from "./useSessionEvents";

/**
 * 会话批量操作的唯一实现（会话弹窗与设置页「已归档对话」共用）。
 *
 * 两处入口做的事完全一样：按 `BATCH_LIMIT` 分批调后端、逐批聚合失败明细。
 * 各家自己拼一遍等于给「一次上限」留两个会漂移的副本——后端超限会直接拒绝整批。
 */
export const BATCH_LIMIT = 200;

/** 批量结果：成功数 + 失败明细（`id` + 原因）。 */
export type BatchOutcome = { ok: number; failed: { id: string; message: string }[] };

export async function runSessionBatch(
 kind: "archive" | "unarchive" | "delete",
 ids: string[],
): Promise<BatchOutcome> {
 const failed: { id: string; message: string }[] = [];
 /** 真正成功的 id（跨批累积）：缓存清理与列表缓存同步都只认它。 */
 const done = new Set<string>();
 let ok = 0;
 for (let i = 0; i < ids.length; i += BATCH_LIMIT) {
  const chunk = ids.slice(i, i + BATCH_LIMIT);
  const res =
   kind === "archive"
    ? await api.archiveSessions(chunk)
    : kind === "unarchive"
     ? await api.unarchiveSessions(chunk)
     : await api.deleteSessions(chunk);
  ok += res.ok;
  failed.push(...res.failed);
  // 只认真正成功的 id：失败的那些保持可读（缓存行不动），列表缓存同步也用它
  const failedIds = new Set(res.failed.map((f) => f.id));
  for (const id of chunk) {
   if (failedIds.has(id)) continue;
   done.add(id);
   // 归档 / 删除后清前端缓存；恢复（unarchive）不清——会话正要重新用起来。
   if (kind !== "unarchive") forgetSession(id);
  }
 }
 syncStoreRows(kind, done);
 return { ok, failed };
}

/**
 * 列表缓存（`store.sessions`）同步——**不做这一步，删过 / 归档过的行会复活**。
 *
 * 左栏把 store 行当真相覆盖，并会把「扫描结果里没有的行」补回列表（见 `ChatSidebar` 的
 * `mergedSessions`）：后端删掉 jsonl 后，下一次刷新扫不到它，但缓存里那一行还在，
 * 于是整行（连标题）又出现在「未归属会话」里，看着像删除凭空造了个新会话
 * （2026-10-15 用户实测；归档同理——缓存里过期的 `archived: false` 会把扫描回传的
 * `archived: true` 顶掉，归档过的会话继续留在「进行中」）。
 *
 * 三种语义各按自己的真相改：删除 = 行不该再存在（缓存一起丢）；归档 / 恢复 = 改归档位
 * （行留着，标题 / 备注仍可用）。删除 / 归档当前会话时激活一并清掉——停在已删 /
 * 已收起的会话上，下一次发送会去把它 resume 起来。只动真正成功的 id（失败的保持可读）。
 */
function syncStoreRows(kind: "archive" | "unarchive" | "delete", done: Set<string>): void {
 if (done.size === 0) return;
 const st = useApp.getState();
 const sessions = st.sessions.flatMap((s) => {
  if (!done.has(s.id)) return [s];
  if (kind === "delete") return [];
  return [{ ...s, archived: kind === "archive" }];
 });
 st.set({
  sessions,
  ...(kind !== "unarchive" && st.activeSessionId && done.has(st.activeSessionId)
   ? { activeSessionId: null }
   : {}),
 });
}

