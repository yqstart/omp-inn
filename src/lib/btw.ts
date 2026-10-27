import { api } from "@shared/api";
import { useApp } from "../stores/app";

/**
 * 旁问（`/btw`）的前端编排（V40）：面板状态的打开 / 提问 / 取消 / 历史加载。
 *
 * 数据流：提问 → `btw_ask` 响应里的 record（running）先落 store → omp 随后推
 * `btw_record`（开始 / 完成各一帧）与 `btw_delta`（流式增量），由 `useSessionEvents`
 * 的 `applyBtwFrame` 更新（只在面板开着的会话上消费）。
 */

/** 打开面板并加载历史（`prefill` = 划选「旁问」带入的选区文本，覆盖输入框草稿）。 */
export async function openBtwPanel(sessionId: string, prefill?: string): Promise<void> {
 const st = useApp.getState();
 if (st.btw.open && st.btw.sessionId === sessionId) {
  if (prefill !== undefined) st.setBtw({ draft: prefill });
  return;
 }
 st.setBtw({
  open: true,
  sessionId,
  records: [],
  busyRecordId: null,
  error: null,
  // 新打开不携带旧会话的草稿；划选进来的 prefill 直接成为草稿
  draft: prefill ?? "",
 });
 try {
  const { records } = await api.getBtwHistory(sessionId);
  // 慢回包不抢：期间用户可能切了面板/会话
  const cur = useApp.getState();
  if (!cur.btw.open || cur.btw.sessionId !== sessionId) return;
  cur.setBtw({
   records,
   // 运行中的记录（含部分答案）也回读得到——重连后视图即可重建
   busyRecordId: records.find((r) => latestStatus(r) === "running")?.id ?? null,
  });
 } catch {
  // 拉不到历史不阻塞面板（新问题照常可问）
 }
}

/** 提问；`recordId` 时是对该话题的追问（omp 侧把话题历史作为上下文回放）。 */
export async function askBtw(sessionId: string, question: string, recordId?: string): Promise<void> {
 const q = question.trim();
 if (!q) return;
 try {
  const { record } = await api.btwAsk(sessionId, q, recordId);
  const cur = useApp.getState();
  if (cur.btw.sessionId !== sessionId) return;
  // 响应先落（running）；随后的 btw_record / btw_delta 帧接管更新
  const records = cur.btw.records.some((r) => r.id === record.id)
   ? cur.btw.records.map((r) => (r.id === record.id ? record : r))
   : [record, ...cur.btw.records];
  cur.setBtw({ records, busyRecordId: record.id });
 } catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  const cur = useApp.getState();
  if (cur.btw.sessionId === sessionId) cur.setBtw({ error: message });
 }
}

/** 取消正在跑的旁问（omp 侧 cancel；面板的取消按钮）。 */
export async function cancelBtw(sessionId: string): Promise<void> {
 const st = useApp.getState();
 const rid = st.btw.busyRecordId ?? undefined;
 try {
  await api.btwCancel(sessionId, rid);
 } catch {
  // 取消失败静默：记录状态最终由 omp 帧收敛
 }
}

/** 话题的「最新一轮」的状态（有 followUps 取最后一项，omp 口径）。 */
export function latestStatus(r: { status: string; followUps?: { status: string }[] }): string {
 const fus = r.followUps ?? [];
 return fus.length > 0 ? fus[fus.length - 1].status : r.status;
}
