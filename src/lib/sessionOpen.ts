import { api } from "@shared/api";
import type { FallbackNotice, SessionView, ViewMsg } from "@shared/types";
import { useApp } from "../stores/app";
import { fmt, TEXT } from "./locale";
import { appendLocalNote } from "./localNote";
import { viewMsgsFromJsonlLines } from "./viewmsg";
import { mergeToolCard } from "./mergeEvents";
import { syncSessionRuntime, waitForSessionListeners } from "./useSessionEvents";
import { isRemoteClient } from "@shared/remote";

/** 发送前恢复进程；身份发生漂移时先切换视图并等事件监听完成。 */
export async function prepareSessionForSend(sid: string, moved: (id: string) => void): Promise<string> {
 const opened = await api.openSession(sid);
 if (opened.id === sid) {
  if (useApp.getState().activeSessionId === sid) await waitForSessionListeners(sid);
  return sid;
 }
 const st = useApp.getState();
 const sessions = st.sessions.some((s) => s.id === opened.id)
  ? st.sessions.map((s) => s.id === opened.id ? opened : s)
  : [opened, ...st.sessions];
 if (st.activeSessionId !== sid || st.settingsTabActive) {
  st.set({ sessions });
  throw new Error(TEXT[st.locale].sessionSwitchedBeforeSend);
 }
 moved(opened.id);
 st.set({ sessions, activeSessionId: opened.id });
 if (!useApp.getState().eventsBySession[opened.id]?.some((m) => m.id === "fork-note")) {
  useApp.getState().appendEvents(opened.id, [{ kind: "divider", id: "fork-note", divider: "reminder", text: TEXT[st.locale].dividerSessionForked }]);
 }
 st.pushNav(opened.id);
 if (isRemoteClient() && location.hash === `#/s/${sid}`) {
  history.replaceState(null, "", `#/s/${opened.id}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
 }
 await waitForSessionListeners(opened.id);
 if (useApp.getState().settingsTabActive) {
  throw new Error(TEXT[useApp.getState().locale].sessionSwitchedBeforeSend);
 }
 await openSessionWithHistory(opened.id, opened);
 if (useApp.getState().activeSessionId !== opened.id || useApp.getState().settingsTabActive) {
  throw new Error(TEXT[useApp.getState().locale].sessionSwitchedBeforeSend);
 }
 return opened.id;
}

/**
 * 历史行 ↔ 实时行的配对键（见 `openSessionWithHistory` 的说明）：
 * 类别 + 全文；`null` = 该类行不参与配对（工具卡按 toolCallId 天然同 id）。
 */
const localPairKey = (m: ViewMsg): string | null =>
 m.kind === "user"
  ? m.id.startsWith("u-local-") || m.id.startsWith("u-echo-")
   ? `user\u0000${m.sentText ?? m.text}`
   : null
  : m.kind === "text"
   ? `text\u0000${m.text}`
   : m.kind === "thinking"
    ? `thinking\u0000${m.text}`
    : null;
/** 历史侧同口径（user 行没有 `u-local-` / `u-echo-` 前缀，一律参与配对）。 */
const historyPairKey = (m: ViewMsg): string | null =>
 m.kind === "user"
  ? `user\u0000${m.text}`
  : m.kind === "text"
   ? `text\u0000${m.text}`
   : m.kind === "thinking"
    ? `thinking\u0000${m.text}`
    : null;

/** 向前读取一页，并把尚未出现的历史行放在现有消息之前。 */
export async function loadEarlierHistory(sid: string, beforeInsert: () => void): Promise<void> {
 const st = useApp.getState();
 const current = st.historyPages[sid];
 if (!current || current.before === null || current.loading) return;
 const before = current.before;
 const loadingState = { ...current, loading: true, error: null };
 st.set({ historyPages: { ...st.historyPages, [sid]: loadingState } });
 try {
  const page = await api.getHistory(sid, before);
  const latest = useApp.getState();
  const state = latest.historyPages[sid];
  if (state !== loadingState) return;
  const parsed = viewMsgsFromJsonlLines(page.lines, TEXT[latest.locale], { before: page.before ?? null, lineOffsets: page.lineOffsets });
  const olderHasUser = parsed.some((m) => m.kind === "user");
  const reachedStart = page.before == null && !state.skipped && !page.skipped;
  const records = { ...state.records };
  const existing = (latest.eventsBySession[sid] ?? []).flatMap((m) => {
   if (m.kind !== "divider" || !m.pendingPriorUser) return [m];
   if (olderHasUser) {
    const resolved = { ...m, pendingPriorUser: false };
    if (records[m.id] === m) records[m.id] = resolved;
    return [resolved];
   }
   if (reachedStart) {
    if (records[m.id] === m) delete records[m.id];
    return [];
   }
   return [m];
  });
  const byId = new Map(existing.map((m) => [m.id, m]));
  const moved = new Set<string>();
  const localByKey = new Map<string, string[]>();
  const parsedIds = new Set(parsed.map((m) => m.id));
  for (const m of existing) {
   if (state.records[m.id] === m || parsedIds.has(m.id)) continue;
   // 发送前尚未加载的更早页必然早于本地发送，不能仅因文本相同而配对。
   if (m.kind === "user" && m.historyBeforeSend != null && before <= m.historyBeforeSend) continue;
   const key = localPairKey(m);
   if (!key) continue;
   const ids = localByKey.get(key) ?? [];
   ids.push(m.id);
   localByKey.set(key, ids);
  }
  const rows = parsed.flatMap((m) => {
   const later = byId.get(m.id);
   if (!later) {
    const key = historyPairKey(m);
    const local = key ? localByKey.get(key)?.shift() : undefined;
    if (local) {
     moved.add(local);
     const original = byId.get(local);
     if (m.kind === "user" && original?.kind === "user") {
      return [{ ...m, text: original.text, mentions: original.mentions, sentText: m.text, awaitingEcho: original.awaitingEcho }];
     }
    }
    return [m];
   }
   // 调用和结果可能跨页：以较早的调用位置放合并卡，保留较晚的终态和输出。
   if (m.kind === "tool" && later.kind === "tool") {
    moved.add(m.id);
    return [mergeToolCard(m, later)];
   }
   return [];
  });
  for (const row of rows) records[row.id] = row;
  beforeInsert();
  latest.set({
   eventsBySession: { ...latest.eventsBySession, [sid]: [...rows, ...existing.filter((m) => !moved.has(m.id))] },
   historyPages: { ...latest.historyPages, [sid]: { ...state, before: page.before ?? null, records, skipped: state.skipped || !!page.skipped, loading: false, error: null } },
  });
 } catch (error) {
  const latest = useApp.getState();
  const state = latest.historyPages[sid];
  if (state === loadingState) {
   latest.set({ historyPages: { ...latest.historyPages, [sid]: { ...state, loading: false, error: error instanceof Error ? error.message : String(error) } } });
  }
 }
}

/**
 * 打开会话时调用方**手上已有的列表行**（左栏扫描行 / 归档行 / store 行 / 新建结果）：
 * `openSessionWithHistory` 先把它的 id / 项目 / 目录 / 标题落进 store，再等 `open_session` 收敛。
 * 只拿 id 打开是不够的——见 `openSessionWithHistory` 的说明。缺的字段按 `hintRow` 的默认值补。
 */
export type SessionHint = Pick<SessionView, "id" | "projectId" | "title" | "cwd"> & Partial<SessionView>;

/** 列表行 → store 行：缺的字段给安全默认值（时间用当下、`running` 缺省为「没在跑」——
 *  转圈只表示任务在跑，不猜「正要跑」；真在跑时扫描行自带 true），
 *  open 返回后由真值字段收敛（`running` / `archived` / 项目 / 目录）。 */
function hintRow(h: SessionHint): SessionView {
 return {
  id: h.id,
  projectId: h.projectId,
  title: h.title,
  cwd: h.cwd,
  timestamp: h.timestamp ?? Date.now(),
  archived: h.archived ?? false,
  corrupt: h.corrupt ?? false,
  note: h.note ?? null,
  running: h.running ?? false,
 };
}

/**
 * 消息流回底（Thread 的 `role="log"` 容器）：双 rAF 等首帧绘制完成再读底，
 * 否则新挂载的消息还没量出高度，scrollHeight 还是旧的。
 */
function scrollThreadToBottom() {
 requestAnimationFrame(() => {
  requestAnimationFrame(() => {
   const el = document.querySelector('[role="log"]');
   if (el) el.scrollTop = el.scrollHeight;
  });
 });
}

/**
 * 在某目录下新建聊天会话（目录行 / 会话弹窗的「新建」与空态共用）。
 *
 * 后端 `create_session` 已按该目录起长驻 RPC 并用 `get_state` 回填 sessionId；
 * 这里只负责把新会话补进 store、选中并拉一次历史（新会话为空，等于就绪态）。
 * 失败不抛：返回结果由调用方决定提示位置（左栏内联错误条 / 空态内联错误）。
 */
export async function createChatIn(
 cwd: string,
 opts: { projectName?: string; shouldActivate?: () => boolean } = {},
): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
 try {
  const created = await api.createSession(cwd);
  const st = useApp.getState();
  const known = st.sessions.some((s) => s.id === created.id);
  const activate = opts.shouldActivate?.() ?? true;
  st.set({
   ...(known ? {} : { sessions: [created, ...st.sessions] }),
   ...(activate ? { activeSessionId: created.id, sidebarOpen: false } : {}),
   statusBySession: { ...st.statusBySession, [created.id]: { state: "idle" } },
  });
  if (activate) await openSessionWithHistory(created.id, created);
  // 后端在「项目偏好的模型 / 思考档被 omp 拒了、这次改用默认档」时会带说明回来：
  // 落到消息流尾的本地说明行（会话内反馈位），否则用户只会觉得「模型怎么自己变了」。
  if (created.notice) appendLocalNote(created.id, fallbackNoticeText(created.notice));
  return { ok: true, id: created.id };
 } catch (e) {
  const t = TEXT[useApp.getState().locale];
  const reason = e instanceof Error ? e.message : null;
  const message = opts.projectName
   ? reason
    ? fmt(t.createChatFailedIn, opts.projectName, reason)
    : fmt(t.createChatFailedInShort, opts.projectName)
   : reason
    ? fmt(t.createChatFailed, reason)
    : t.createChatFailedShort;
  return { ok: false, message };
 }
}

/**
 * 降级说明的文案（`FallbackNotice` → 一条本地说明）。
 *
 * 分支口径：omp 连默认模型都没拿到（`fallbackModel` 为否）= 问题不在项目偏好上，
 * 如实说明并带上 omp 原话，别让用户以为是「模型被删了」；拿到了才按「模型 / 思考档
 * 哪个失效」给出具体那条。
 */
function fallbackNoticeText(n: FallbackNotice): string {
 const t = TEXT[useApp.getState().locale];
 if (!n.fallbackModel) return fmt(t.createChatFallbackNoModel, n.detail ?? "-");
 if (n.model && n.thinking) return fmt(t.createChatFallbackModelThinking, n.model, n.thinking);
 if (n.model) return fmt(t.createChatFallbackModel, n.model);
 if (n.thinking) return fmt(t.createChatFallbackThinking, n.thinking);
 return fmt(t.createChatFallbackNoModel, n.detail ?? "-");
}
/**
 * 重读一个会话的视图（备注改名后用）：`open_session` 对已运行的会话只读回视图、不重复 spawn。
 * 失败保留旧行（标题暂时旧着，不打断编辑动作）。
 */
export async function refreshSessionView(id: string): Promise<void> {
 try {
  const view = await api.openSession(id);
  const cur = useApp.getState();
  const known = cur.sessions.some((s) => s.id === view.id);
  cur.set({
   sessions: known ? cur.sessions.map((s) => (s.id === view.id ? view : s)) : [view, ...cur.sessions],
  });
 } catch {
  // 刷新失败保留旧行
 }
}

/**
 * 首条用户消息的本地标题回退（后端 `display_title` 对空标题会话也有同口径的派生兜底，
 * 这里服务的是「消息刚发出、jsonl 还没落盘」那一小段窗口）：取首条文本的前 12 个字符
 * （去空白折行），只写 `store.sessions` 的显示字段、不写盘不写备注。
 * 真标题由壳侧在会话进程里注入 omp 原生命令 `/rename` 补齐（见 `runtime.rs`
 * `maybe_auto_title`；rpc-ui 下 omp 自动标题被上游关闭），成功经 `session_info_update`
 * 帧 / 下次 `refreshSessionView` 覆盖它。
 */
export function fallbackTitleFromText(text: string): string | null {
 const clean = text.replace(/\s+/g, " ").trim();
 if (!clean) return null;
 return clean.length <= 12 ? clean : `${clean.slice(0, 12)}…`;
}

/** 首条发送后：本地回退先顶上（不闪「未命名」），再回读一次 omp 真值（有标题就覆盖）。 */
export async function refreshTitleAfterFirstSend(id: string, text: string): Promise<void> {
 const cur = useApp.getState().sessions.find((s) => s.id === id);
 // 已有备注 / 已有真标题的不碰：回退只服务「未命名」会话
 if (cur?.note?.trim() || (cur?.title && !isDefaultTitle(cur.title))) return;
 const fallback = fallbackTitleFromText(text);
 if (fallback) {
  const st = useApp.getState();
  st.set({ sessions: st.sessions.map((s) => (s.id === id ? { ...s, title: fallback } : s)) });
 }
 // 回读 omp 真值：补标题还没完成时保持回退（后端派生的同口径标题也在这里落位）
 await refreshSessionView(id);
 const latest = useApp.getState().sessions.find((s) => s.id === id);
 if (fallback && latest && isDefaultTitle(latest.title)) {
  useApp.getState().set({ sessions: useApp.getState().sessions.map((s) => (s.id === id ? { ...s, title: fallback } : s)) });
 }
}

/**
 * 默认标题的判定（会话还没起过轮次 / 还没改过名）：后端派生的兜底标题与本地回退都认这两种写法，
 * 两处判定（首条发送后的回退、新建会话时的「空会话」识别）共用一份，避免各写一半。
 */
export function isDefaultTitle(title: string | null | undefined): boolean {
 const s = title?.trim() ?? "";
 return s.length === 0 || s.startsWith("未命名会话") || s.startsWith("Untitled");
}

/**
 * 打开会话的**唯一实现**（会话弹窗 / 目录行 / 空态共用，避免两处漂移）：
 * 选中即读底 → 起/聚焦长驻 RPC → 补拉运行时真值 → 拉历史去重合并 → 再读底。
 *
 * `hint` = 调用方手上的列表行（左栏扫描行 / 归档行 / store 行 / 新建结果），**先落地再等 open**：
 * 上下文条的项目选择器、顶栏标题、消息列的 cwd 都读 `store.sessions`，而没开过的会话
 * `open_session` 要 spawn `omp --mode rpc-ui --resume` 并等握手（实测 1–3 s）、失败时这一行
 * 还会一直缺席——只拿 id 打开就会先显示「未归属 / 未命名会话」（用户实测：「点击已经存在的
 * 会话，输入框上方的项目有时展示不出来」）。hint 先顶上，`open_session` 返回后按真值收敛。
 *
 * `opts.trustView`（**只有「恢复上次选中的会话」用**）：这次的 hint 来自上一次运行的快照
 * （`lib/lastSession.ts`），标题 / 备注可能已经陈旧，`open_session` 返回的真值**整行收敛**
 * （默认口径是保留本地行标题——那是给「刚发首条消息的乐观标题」用的，恢复态不适用）。
 *
 * 全程不抛错：会话打不开（文件被删 / omp 缺失）时仍允许看旧缓存，
 * 左栏会话状态点与输入卡会体现 exited / omp 不可用，不由这里弹错——结果由返回值表达，恢复路径据此回到空态。
 */
export async function openSessionWithHistory(
 id: string,
 hint?: SessionHint,
 opts: { trustView?: boolean } = {},
): Promise<{ ok: boolean; id: string }> {
 // 换会话＝换消息流：把「首屏增量」窗口重置回第一页（否则沿用上一个会话的展开量）
 useApp.getState().resetThreadLimit(id);
 // 真实身份：open 返回前先按请求 id 走（失败时也用它读旧缓存）；open 成功后收敛为
 // omp 实际给出的身份——请求打开一个已被其他进程持有的会话时，omp 会保护性 fork
 // （open-elsewhere），真实身份 ≠ 请求 id，后续视图 / 历史 / 导航都必须用真实身份。
 let realId = id;
 let forked = false;
 // 会话导航栈（V40，⌘[ / ⌘]）在 open **成功后**按真实身份压栈（见 try 内）；
 // 打开失败的会话不该进导航历史。
 // 已知视图先落地（还没有这一行才落）：慢 open 期间项目 / 标题 / cwd 立刻就是对的
 const st0 = useApp.getState();
 if (hint && hint.id === id && !st0.sessions.some((s) => s.id === id)) {
  st0.set({ sessions: [hintRow(hint), ...st0.sessions] });
 }
 useApp.getState().set({ activeSessionId: id, sidebarOpen: false, settingsTabActive: false });
 // 切换即读底：新会话消息先落位，Thread 才有可滚内容
 scrollThreadToBottom();
 let ok = false;
 try {
  const opened = await api.openSession(id);
  // 身份漂移（omp 的保护性 fork：见后端 spawn_session_runtime 的 open-elsewhere 注释）：
  // 请求打开的会话已被**其他壳 / 进程**持有，omp 把这次打开分到了新副本。壳必须以
  // **真实身份**继续（视图行 / 激活 / 历史 / 导航全用 opened.id）——否则点开的明明
  // 是副本，消息列却去读原会话的历史，列表再点一次又拉起一个新进程。
  forked = opened.id !== id;
  realId = opened.id;
  const cur = useApp.getState();
  // 已有行（hint / 扫描行 / 之前打开过）只收敛后端说了算的四个字段——标题留给
  // open / title_change / 首条回退那几条既有路径（本地乐观标题不能被「未命名会话」顶掉）；
  // 搜索命中的会话可能落在扫描窗口之外（列表里没有这一行）：把它补进列表。
  // `trustView`（恢复上次会话）是例外：hint 是上一次运行的快照，标题与备注都按真值收敛。
  const rows = cur.sessions.some((s) => s.id === opened.id)
   ? cur.sessions.map((s) =>
    s.id === opened.id
     ? {
       ...s,
       running: opened.running,
       archived: opened.archived,
       projectId: opened.projectId,
       cwd: opened.cwd,
       ...(opts.trustView ? { title: opened.title, note: opened.note } : {}),
      }
     : s,
   )
   : [opened, ...cur.sessions];
  // 慢 open 期间用户可能已经切到别的会话：行照落，但**别把选中抢回来**（状态同理，
  // 那个会话可能真的在跑，不该被这里的「先按 idle 起手」抹掉）。
  // 状态也不许无条件压成 idle：只在**还没有任何状态记录**的新会话上起手，
  // 已有记录（running / awaiting-approval…）保持并等 `syncSessionRuntime` 的回读收敛——
  // 压 idle 会让切回一个正在跑的会话显示成「就绪」：指示不出现、下一条消息还会被当成
  // 新 prompt 发出去（运行中应当走排队 / 转向），一句追问就把进行中的轮次打断。
  // 打开期间用户没切走（activeSessionId 仍是本函数设置的请求 id）——漂移时也认：
  // 打开的虽是副本，用户要的就是「打开它」，激活跟着真实身份走。
  const stillActive = cur.activeSessionId === id;
  const knownStatus = cur.statusBySession[opened.id] !== undefined;
  cur.set({
   ...(stillActive
    ? {
     activeSessionId: opened.id,
     ...(knownStatus ? {} : { statusBySession: { ...cur.statusBySession, [opened.id]: { state: "idle" } } }),
    }
    : {}),
   sessions: rows,
  });
  // 导航栈（V40，⌘[ / ⌘]）：open 成功后按真实身份压栈（去重截断在 pushNav 内）；
  // 漂移时补重置一次真实会话的展开量（请求 id 那次重置作用在另一个会话上，无害）。
  useApp.getState().pushNav(opened.id);
  if (forked) useApp.getState().resetThreadLimit(opened.id);
  // 运行时真值：**必须等 open 返回之后再补拉**——resume 的长驻进程是在 `open_session`
  // 里 spawn 的，订阅建立时那次补拉必然早于它完成（拉不到），于是模型 / 思考档 /
  // 上下文占用一直空着，直到用户手动切一次模型。这里补拉时进程一定已在。
  await syncSessionRuntime(opened.id);
  ok = true;
 } catch {
  // 打不开时保留旧缓存可读，左栏会话状态点会报 exited / 不可用
 }
 try {
  const page = await api.getHistory(realId);
  let cur = useApp.getState();
  const previous = cur.historyPages[realId];
  // 新旧文件区间没有交集时，旧游标无法覆盖中间的记录；丢掉旧历史快照并从最新页重建。
  // 仅移除对象仍与快照相同的行：实时更新过的卡和未确认的乐观消息必须保留。
  const gap = previous && page.end !== undefined && previous.end > 0 &&
   (page.end < previous.end || (page.before != null && page.before > previous.end));
  if (gap) {
   const remaining = (cur.eventsBySession[realId] ?? []).filter((m) => previous.records[m.id] !== m);
   const historyPages = { ...cur.historyPages };
   delete historyPages[realId];
   cur.set({ eventsBySession: { ...cur.eventsBySession, [realId]: remaining }, historyPages });
   cur = useApp.getState();
  }
  // 同一会话重复打开不叠历史：tool 卡按 toolCallId 稳定 id，其余按行 id。
  // 乐观回显的 `u-local-*` 消息：历史里同一文本的 `u:<行id>` 到达时视为同一条，
  // 用历史版本替换本地版（行 id 稳定），不翻倍。
  const cur_list = cur.eventsBySession[realId] ?? [];
  const seen = new Set(cur_list.map((m) => m.id));
  let historyRows = viewMsgsFromJsonlLines(page.lines, TEXT[useApp.getState().locale], { before: page.before ?? null, lineOffsets: page.lineOffsets });
  const historyIds = new Set(historyRows.map((m) => m.id));
  // 新页之前已缓存到用户消息，则页首配置变更确定发生在首条用户消息之后。
  const olderUserCached = !gap && previous && Object.values(previous.records).some((m) => m.kind === "user" && !historyIds.has(m.id));
  if (olderUserCached) {
   historyRows = historyRows.map((m) => m.kind === "divider" && m.pendingPriorUser ? { ...m, pendingPriorUser: false } : m);
  }
  // 实时行与历史行**对不上 id**（实时 id 由会话 + 消息序号 + contentIndex 拼出，历史 id
  // 取自 jsonl 的行 id），但同一条消息会在两边各出现一次——不配对就会「重新打开会话，
  // 助手回复翻倍」（实时流过的会话切走再切回必然命中，V34 的历史 LRU 让缓存还留着）。
  // 配对键 = 类别 + 全文（每类各自按出现顺序逐个配对，队列而不是按文本去重——模型
  // 复述同一句话不会互相顶掉）；命中的历史行**替换**实时行（换成行 id 稳定的一版），
  // 实时行本身丢弃。已来自历史的行（id 在本次历史里）不参与配对，避免把一条历史行
  // 配到另一条同文本的历史行上。
  const localByKey = new Map<string, string[]>();
  const pushLocal = (key: string | null, id_: string) => {
   if (!key) return;
   const arr = localByKey.get(key) ?? [];
   arr.push(id_);
   localByKey.set(key, arr);
  };
  for (const m of cur_list) {
   if (historyIds.has(m.id) || previous?.records[m.id] === m) continue;
   pushLocal(localPairKey(m), m.id);
  }
  // 在一份快照上按历史顺序合并：未配对的旧历史必须先于请求期间到达的实时行。
  // 已加载的更早历史留在页前；实时行与历史锚点之间的原有相对顺序保留。
  const byId = new Map(cur_list.map((m) => [m.id, m]));
  const matched = new Map<string, number>();
  const rows = historyRows.map((m, index) => {
   const exact = byId.get(m.id);
   if (exact) {
    matched.set(exact.id, index);
    return m.kind === "tool" && exact.kind === "tool" ? mergeToolCard(m, exact) : exact;
   }
   const key = historyPairKey(m);
   const localId = key ? localByKey.get(key)?.shift() : undefined;
   if (localId) {
    matched.set(localId, index);
    const original = byId.get(localId);
    if (m.kind === "user" && original?.kind === "user") {
     return { ...m, text: original.text, mentions: original.mentions, sentText: m.text, awaitingEcho: original.awaitingEcho };
    }
   }
   return m;
  });
  const earlier: ViewMsg[] = [];
  const trailing: ViewMsg[] = [];
  const before = new Map<number, ViewMsg[]>();
  const after = new Map<number, ViewMsg[]>();
  let anchor: number | null = null;
  const lastAnchor = cur_list.reduce((last, m, index) => matched.has(m.id) ? index : last, -1);
  for (const [position, m] of cur_list.entries()) {
   const index = matched.get(m.id);
   if (index !== undefined) {
    anchor = index;
   } else if (previous?.records[m.id] === m && !historyIds.has(m.id) && !gap) {
    earlier.push(m);
   } else if (anchor !== null && position < lastAnchor) {
    const bucket = after.get(anchor) ?? [];
    bucket.push(m);
    after.set(anchor, bucket);
   } else {
    // 没有后续锚点时，仅在时间明确早于某条历史时插入其前；否则保留在最新历史之后。
    const next = m.at == null ? -1 : rows.findIndex((row, i) =>
     (anchor === null || i > anchor) && row.at != null && row.at > m.at!,
    );
    if (next < 0) trailing.push(m);
    else {
     const bucket = before.get(next) ?? [];
     bucket.push(m);
     before.set(next, bucket);
    }
   }
  }
  const merged = [...earlier];
  rows.forEach((row, index) => {
   merged.push(...(before.get(index) ?? []), row, ...(after.get(index) ?? []));
  });
  merged.push(...trailing);
  cur.set({ eventsBySession: { ...cur.eventsBySession, [realId]: merged } });
  // 重开时保留已经向前加载过的游标，避免重复加载已在缓存中的页。
  const latest = useApp.getState();
  const oldPage = latest.historyPages[realId];
  const records = { ...oldPage?.records };
  for (const m of latest.eventsBySession[realId] ?? []) {
   if (historyIds.has(m.id) && (!seen.has(m.id) || previous?.records[m.id] === m)) records[m.id] = m;
  }
  latest.set({ historyPages: { ...latest.historyPages, [realId]: {
   before: oldPage ? oldPage.before : page.before ?? null,
   end: page.end ?? oldPage?.end ?? 0,
   records,
   skipped: !!oldPage?.skipped || !!page.skipped,
   loading: false,
   error: null,
  } } });
  // 兼容尚未升级的旧回包。
  if (page.truncated && !cur_list.some((m) => m.id === "hist-truncated")) {
   useApp.getState().appendEvents(realId, [{ kind: "divider", id: "hist-truncated", divider: "turn", text: TEXT[useApp.getState().locale].historyTruncated }]);
  }
  // 身份漂移（forked）时的说明行：把「为什么列表里多了一个同名会话」讲清楚——
  // 那是 omp 在「会话已被别处打开」保护下自动分叉的副本，原会话不受影响。固定 id：
  // 重复打开同一副本不叠第二条（流里已有就跳过）。
  if (forked && !useApp.getState().eventsBySession[realId]?.some((m) => m.id === "fork-note")) {
   useApp.getState().appendEvents(realId, [
    {
     kind: "divider",
     id: "fork-note",
     divider: "reminder",
     text: TEXT[useApp.getState().locale].dividerSessionForked,
    },
   ]);
  }
  // 历史落位后再读一次底，保证停在最新处（慢历史期间用户已切走就别拽别人的消息列）
  if (useApp.getState().activeSessionId === realId) scrollThreadToBottom();
 } catch (error) {
  // 新会话在首轮前尚未落盘，找不到文件属于正常情况。
  const cause = error && typeof error === "object" && "cause" in error ? error.cause : error;
  if (!(cause && typeof cause === "object" && "code" in cause && cause.code === "NOT_FOUND")) {
   const latest = useApp.getState();
   const current = latest.historyPages[realId];
   latest.set({ historyPages: { ...latest.historyPages, [realId]: { before: current?.before ?? null, end: current?.end ?? 0, records: current?.records ?? {}, skipped: current?.skipped ?? false, loading: false, error: error instanceof Error ? error.message : String(error) } } });
  }
 }
 // 结果口径：`ok` 反映**打开本身**成不成（spawn / 握手），历史加载失败不算打开失败；
 // 身份漂移时返回真实身份（调用方要按它继续，见上面的说明）。
 return { ok, id: realId };
}
