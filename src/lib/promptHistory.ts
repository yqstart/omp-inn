/**
 * 输入框的「已发送 prompt 历史」（V41，对标 codex 的 ↑↓ 调回草稿历史）：按会话记最近 N 条，
 * localStorage 持久化。纯数据层——浏览交互（↑↓ / 编辑退出 / 发送重置）在 Composer。
 *
 * 去重规则：与**上一条完全相同**的连续重复不记（连发同一句话不堆叠）；不相邻的重复照记
 * （用户可能刻意重发）。空文本不记。
 */
const KEY = "omp.promptHistory.v1";
const MAX = 50;

type Store = Record<string, string[]>;

function load(): Store {
 try {
  const raw = localStorage.getItem(KEY);
  const v = raw ? (JSON.parse(raw) as unknown) : null;
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Store;
 } catch {
  // 坏数据按空处理（历史是锦上添花，不值得打断任何流程）
 }
 return {};
}

/** 读一个会话的历史（时间序：旧的在前、最近的在后）。 */
export function loadHistory(sid: string): string[] {
 const list = load()[sid];
 return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

/** 发送后记一条（空文本与「与上一条相同的连续重复」跳过；超限保尾）。 */
export function pushHistory(sid: string, text: string): void {
 const t = text.trim();
 if (!t) return;
 const all = load();
 const list = all[sid] ?? [];
 if (list.length > 0 && list[list.length - 1] === t) return;
 all[sid] = [...list, t].slice(-MAX);
 try {
  localStorage.setItem(KEY, JSON.stringify(all));
 } catch {
  // 写失败不影响本次运行（下次仍从旧快照读）
 }
}
