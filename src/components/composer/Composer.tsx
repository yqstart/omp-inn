import {
 useCallback,
 useEffect,
 useLayoutEffect,
 useMemo,
 useRef,
 useState,
 type ClipboardEvent as ReactClipboardEvent,
 type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowUp, Hourglass, PenLine, Plus, Timer, TriangleWarning, X } from "reicon-react";
import type { ImageAttachment, ViewMsg } from "@shared/types";
import { useApp } from "../../stores/app";
import { api } from "@shared/api";
import { attachmentFromFile, attachmentFromOmpImage, dataUrl } from "../../lib/attachments";
import { fmt } from "../../lib/locale";
import { extractMentions, rewriteMentions } from "../../lib/mentions";
import { cycleSessionApproval } from "../../lib/sessionApproval";
import { loadHistory, pushHistory } from "../../lib/promptHistory";
import { commandInsert, filterCommands, isCompleteCommand, normalizeCommands, SKILL_PREFIX, type SlashCandidate } from "../../lib/slashCommands";
import { createChatIn, refreshTitleAfterFirstSend } from "../../lib/sessionOpen";
import { resolveNewChatCheckout } from "../../lib/checkouts";
import { useText } from "../../lib/useText";
import { ProjectPicker } from "../pickers/ProjectPicker";
import { BranchPicker } from "../pickers/BranchPicker";
import { CommitButton } from "./CommitButton";
import { SessionStatsBar } from "../thread/SessionStatsBar";
import { CompactButton, QueueBadge } from "../thread/StatusBar";
import { resolveContext } from "../../lib/context";
import { useGitInfo } from "../../lib/useGitInfo";
import { MentionList, type MentionRow, type PathCandidate } from "./MentionList";
import { DraftEditor, type DraftEditorHandle, type DraftTextSource } from "./draft/DraftEditor";
import { hasWorkspaceRefs, referenceTarget } from "../../lib/workspaceFiles";
import { useOutsideDismiss } from "../../lib/useDropdown";
import { restoreImageOrder, stripImageOrderNote, withImageOrderNote } from "../../lib/imageRefs";
import { SlashMenu, type SlashAction } from "./SlashMenu";
import { ApprovalModeMenu } from "./ApprovalModeMenu";
import { FastMenu } from "./FastMenu";
import { ModelMenu } from "./ModelMenu";
import { ThinkingMenu } from "./ThinkingMenu";

/** 大段粘贴转文件引用的阈值（字符数；V41，zcode 同款——超过就存文件 + `@` 注入）。 */
const PASTE_FILE_MIN = 2000;

/** 空态输入卡的草稿键：`activeSessionId === null` 时也要有草稿，发送时再新建会话。 */
const NEW_DRAFT = "__new__";
const NEW_DRAFT_RECOVERY = "omp.newDraftRecovery.v1";

/**
 * 会话输入卡（v2 §3 形态，对齐 Codex / ZCode 的输入卡）：
 * **卡内顶行**（2026-10-22 用户口径：从卡外搬回卡内）= 项目 + 分支选择器 + 提交键，
 * 卡片自己就是这一行与输入区的共同外框（不再有卡片外那根孤零零的裸行）；
 * 任务清单浮卡因此直接叠在卡片上方，与卡面同一套圆角 / 描边 / 浮起层级；
 * **输入区** = 附件条 + 提及芯片 + 待发区 + 自动增高输入框；
 * **卡底工具行** = 左「`+` 菜单（文件 / 工作区文件 / 压缩）+ 执行模式菜单」，
 * 右「压缩行动点 + Fast 服务档位 + 模型 · 思考档 ▾ + 圆形发送 / 停止」；**卡底统计条** = `SessionStatsBar`，
 * **在输入卡外部、卡片下方独立一行**（2026-10-20 用户口径：从卡片内部移出；不在工具行的
 * `flex-wrap` 容器里）——会话统计 /
 * Token 用量 / 上下文占用 / 供应商用量（2026-10-16 对齐 DeepSeek Harness 的 composer dock）——
 * 「我要不要再开一轮」的读数（跑了多少步、烧了多少 token、上下文还剩多少、配额还剩多少）都在那一行里，
 * 点开各自给明细。上下文容量环与供应商用量 2026-10-14 从顶栏右端搬进输入卡、2026-10-16 从工具行挪进统计条；
 * 提交入口 = 卡内顶行的提交键（与右栏「变更」区块同一浮层链路）。
 * `@` / `/` 补全浮层 2026-10-20 也移到卡片外部（卡片上方的独立块，不再撑高卡片）。
 * 待发区（V40）：omp 的队列真值（`queue_update`）——可撤回 / 编辑 / 提升，Esc 中断还原
 * （「排队」按钮 2026-10-13 按用户口径退场，排队只走 Tab / ⌘Ctrl+Enter）。
 *
 * 图片附件（V2 M6）：粘贴 / 拖拽 / `+` 菜单三条入口，全部读成 base64 存在内存里，
 * 发送时随 `prompt.images` 一次性交给 omp——应用不落盘、不写覆盖层。
 * 三条入口都在光标处留下 `#N` 占位（N = 附件稳定编号，`commitImages` 唯一收尾）：文字与图片
 * 的对应关系写在正文里（「如图#1」），缩略图角标同编号。实测核对（omp 18.10.4 rpc-ui）：
 * 文本原样进 user 消息、图片按数组序追加为 image 块，`#N` 只是普通文本、上游不做特殊解析。
 * 2026-10-21 起发送侧补**附件顺序注记**（`lib/imageRefs.ts`）：正文引用了已附带附件的 `#N` 时，
 * 在 wire text 末尾追加 `[omp image order: #1=image 1, …]`（按图片数组顺序），让模型能按编号
 * 对位；注记只给模型看，乐观回显 / 历史 / 队列行展示都剥离。
 *
 * 2026-10-20：`+` 菜单的「文件」按类型分流（图片 → 附件，其他文件 → `@` 引用）；
 * `@` 浮层顶部多一行「工作区文件」入口。
 */
export function Composer() {
 const t = useText();
 const { activeSessionId, draftOf, setDraft, statusBySession, sessions, attachmentsOf, addAttachments, removeAttachment, clearAttachments, queuedOf, currentModel, currentRuntime, models, composerFocusSeq, checkouts, workspaceGroups } =
  useApp();
 /** 草稿编辑器句柄（Lexical；不受控——编辑器状态是权威，store 里的草稿是它的投影）。 */
 const editorRef = useRef<DraftEditorHandle | null>(null);
 /** 编辑器当前承载的会话和最近一次已同步文本。 */
 const editorSessionRef = useRef(activeSessionId ?? NEW_DRAFT);
 const editorProjectionRef = useRef("");
 const syncEditor = useCallback((text: string) => {
  editorProjectionRef.current = text;
  editorRef.current?.setText(text);
 }, []);
 /** `+` / `/` 共用面板与 `@` 补全的容器（点外部关闭时判断「里面」）。 */
 const panelRef = useRef<HTMLDivElement>(null);
 const mentionRef = useRef<HTMLDivElement>(null);
 /** `+` 触发按钮：同上（它自己 onClick 负责开合，不能被 pointerdown 先关掉）。 */
 const plusBtnRef = useRef<HTMLButtonElement>(null);
 /** 引用浮层注入草稿后回到输入框接着写（序号信号：同一会话反复注入也能重新聚焦）。 */
 useEffect(() => {
  if (composerFocusSeq > 0) editorRef.current?.focus();
 }, [composerFocusSeq]);
 const persistDraft = useCallback((sid: string | null, text: string, source: "editor" | "external" = "external") => {
  if (source === "external" && sid && editorSessionRef.current === sid) {
   syncEditor(text);
  }
  setDraft(sid, text);
  if (sid) {
   try {
    const raw = localStorage.getItem("omp.drafts.v1");
    const all = (raw ? JSON.parse(raw) : {}) as Record<string, string>;
    if (text) all[sid] = text;
    else delete all[sid];
    localStorage.setItem("omp.drafts.v1", JSON.stringify(all));
   } catch {
    // 持久化失败不阻断输入
   }
  }
 }, [setDraft, syncEditor]);
 /** 读指定编辑器；外部草稿与尚未提交的输入同时变化时，两者都保留。 */
 const readEditorDraft = useCallback((sid: string, handle: DraftEditorHandle): string => {
   const stored = useApp.getState().draftOf(sid);
   const projected = editorProjectionRef.current;
   if (stored !== projected) {
    const pending = handle.peekText();
    if (pending !== projected && pending !== stored) {
     handle.getText();
     return stored.trim() && pending.trim() ? `${stored}\n\n${pending}` : stored + pending;
    }
    return stored;
   }
   return handle.getText();
 }, []);
 /** 编辑器可能还属于刚切走的会话，按其实际所属读取。 */
 const currentDraft = useCallback((sid: string): string => {
  if (editorSessionRef.current === sid && editorRef.current) return readEditorDraft(sid, editorRef.current);
  return useApp.getState().draftOf(sid);
 }, [readEditorDraft]);
 const draft = draftOf(activeSessionId ?? NEW_DRAFT);
 /** 空态草稿键（没有活动会话时不落到 `drafts[null]`，否则输入会丢）。 */
 const draftKey = activeSessionId ?? NEW_DRAFT;
 const archived = sessions.find((s) => s.id === activeSessionId)?.archived;
 // 切会话或归档导致编辑器卸载前，先提交旧编辑器尚未上报的内容。
 useLayoutEffect(() => {
  const handle = editorRef.current;
  const sid = draftKey;
  return () => {
   const state = useApp.getState();
   const switched = (state.activeSessionId ?? NEW_DRAFT) !== sid;
   const nowArchived = state.sessions.some((session) => session.id === sid && session.archived);
   if (!handle || editorSessionRef.current !== sid || (!switched && !nowArchived)) return;
   const text = readEditorDraft(sid, handle);
   if (text !== useApp.getState().draftOf(sid)) persistDraft(sid, text);
  };
 }, [draftKey, archived, readEditorDraft, persistDraft]);
 /**
  * 草稿投影同步：store 里的草稿是**外部写入**的入口（队列退回 / 历史调回 / 切会话），
  * 与编辑器当前全文不一致时才灌进去（编辑器自己打字时两者一致，不会重置光标）。
  * 高度不再手工算——编辑器是真实 DOM（CSS 封顶 `max-h-44` 后内部滚动）。
  */
 useLayoutEffect(() => {
  const handle = editorRef.current;
  if (!handle) {
   editorSessionRef.current = draftKey;
   // 编辑器未挂载，不把待恢复草稿误认为已投影。
   editorProjectionRef.current = "";
   return;
  }
  if ((useApp.getState().activeSessionId ?? NEW_DRAFT) !== draftKey) return;
  if (editorSessionRef.current !== draftKey) {
   const previousSid = editorSessionRef.current;
   const previous = currentDraft(previousSid);
   if (previous !== useApp.getState().draftOf(previousSid)) persistDraft(previousSid, previous);
   editorSessionRef.current = draftKey;
   syncEditor(useApp.getState().draftOf(draftKey));
   return;
  }
  const next = currentDraft(draftKey);
  if (next !== useApp.getState().draftOf(draftKey)) persistDraft(draftKey, next);
  else if (handle.peekText() !== next) syncEditor(next);
 }, [draft, draftKey, archived, currentDraft, persistDraft, syncEditor]);
 const attachments = attachmentsOf(activeSessionId);
 /** 待发队列真值（V40）：omp 的 steering / followUp 芯片文本（`queue_update` 驱动）。 */
 const queued = queuedOf(activeSessionId);
 const status = activeSessionId ? statusBySession[activeSessionId]?.state : undefined;
 const running = status === "running" || status === "awaiting-approval";
 const awaiting = status === "awaiting-approval";
 // @文件 提及（V2 M6b）：展开由 omp 做，这里只把草稿里的提及显示成芯片并问一次「路径存在吗」
 const cwd = sessions.find((s) => s.id === activeSessionId)?.cwd ?? "";
 // 卡内顶行（2026-10-22 从卡外搬回卡内）：项目 + 分支 + 提交；git 查询与右栏共用 `useGitInfo`
 const projects = useApp((s) => s.projects);
 const { project } = resolveContext(projects, sessions, activeSessionId);
 /**
  * 「引用工作区文件」的可用性（2026-10-22 用户口径）：**项目没进入工作区就不能引用工作区文件**。
  * 口径 = `referenceScope` 里有可引用的其他成员项目（未分组 / 单成员工作区 / 不属任何项目 → false）；
  * `+` 与 `/` 面板的操作行、`@` 浮层的入口都按它决定是否出现。
  */
 const workspaceRefAvailable = useMemo(
  () => cwd !== "" && hasWorkspaceRefs(cwd, workspaceGroups, checkouts, projects),
  [cwd, workspaceGroups, checkouts, projects],
 );
 const { info: git, loading: gitLoading, reload: reloadGit } = useGitInfo(cwd);
 // 空态（v2 §4）：本会话还没有任何消息 → 输入卡上移，与问候语一起构成居中的「问候 + 输入卡」
 const empty = useApp((s) => (s.activeSessionId ? (s.eventsBySession[s.activeSessionId]?.length ?? 0) === 0 : false));
 const mentions = useMemo(() => extractMentions(draft), [draft]);
 const mentionKey = `${cwd}\u0000${mentions.join("\u0000")}`;
 /** 提及的存在性回执（`check_paths`）：芯片据此标「缺失 / 目录 / 文件」。 */
 const [checks, setChecks] = useState<{
  key: string;
  info: Record<string, { exists: boolean; isDir: boolean; resolved: string | null }>;
 }>({
  key: "",
  info: {},
 });
 /** 解析不到的引用：只给这些留一行提示（正常的引用已经融入正文，不再单独排芯片）。 */
 const missingMentions = useMemo(
  () => (checks.key === mentionKey ? mentions.filter((p) => checks.info[p]?.exists === false) : []),
  [checks, mentionKey, mentions],
 );
 /** 输入框的悬停提示：`@标签 → 真实相对路径`（正常态不占版面，要查全路径就悬浮一下）。 */
 const mentionTitles = useMemo(() => {
  if (checks.key !== mentionKey) return "";
  return mentions
   .map((p) => {
    const full = checks.info[p]?.resolved;
    return full ? `@${p} → ${full}` : null;
   })
   .filter((line): line is string => line !== null)
   .join("\n");
 }, [checks, mentionKey, mentions]);
 const [attachError, setAttachError] = useState<string | null>(null);
 const [recoveredDraft, setRecoveredDraft] = useState(() => {
  try { return localStorage.getItem(NEW_DRAFT_RECOVERY) ?? ""; } catch { return ""; }
 });
 const saveRecoveredDraft = (text: string) => {
  setRecoveredDraft((previous) => {
   const next = previous.trim() && text.trim() ? `${previous}\n\n${text}` : previous + text;
   try { localStorage.setItem(NEW_DRAFT_RECOVERY, next); } catch { /* 保留在本次内存中 */ }
   return next;
  });
 };
 /** 空态首条消息「先新建会话」在飞：防重复点击，发送键在此期间禁用。 */
 const [creating, setCreating] = useState(false);
 const creatingRef = useRef(false);
 const sendingRef = useRef(new Set<string>());
 const [sending, setSending] = useState<Set<string>>(() => new Set());
 const [dragging, setDragging] = useState(false);
 // `@` 补全状态：mentionIdx 为高亮下标，-1 = 无补全；mentionToken 是 `@` 后的路径前缀。
 const [mentionIdx, setMentionIdx] = useState(-1);
 const [mentionCands, setMentionCands] = useState<PathCandidate[]>([]);
 /** 光标前的那一段文本（编辑器每次 selection 变化上报）：`/` 与 `@` 补全都从它取词。 */
 const [caretBefore, setCaretBefore] = useState("");

 useEffect(() => {
  if (mentions.length === 0 || !cwd) return;
  let alive = true;
  // 打字期间不做请求：停 300ms 再问后端（只 stat，无副作用）
  const timer = setTimeout(() => {
   void api
    .checkPaths(cwd, mentions)
    .then((rs) => {
     if (alive) {
      setChecks({
       key: mentionKey,
       info: Object.fromEntries(
        rs.map((r) => [r.path, { exists: r.exists, isDir: r.isDir, resolved: r.resolved }]),
       ),
      });
     }
    })
    .catch(() => undefined);
  }, 300);
  return () => {
   alive = false;
   clearTimeout(timer);
  };
 }, [mentionKey, cwd, mentions]);

 // 补全浮层有两套：`/` 命令面（数据是 omp 自己的 `available_commands_update`）与 `@` 路径。
 // 两者互斥——草稿以 `/` 开头时整条就是一条命令，不该再冒出路径候选。
 // 2026-10-20 用户口径：壳本地命令组（/goal /status /btw …）不再注入 `/` 面板，
 // 2026-10-20 用户口径：`/` 面板不再列 omp 的命令（噪音），只留技能命令
 // （`skill:<名>`）；手打其它 `/xxx` 仍走 omp 的 run_slash，由它自己裁决。
 const commands = useMemo(
  () => normalizeCommands(currentRuntime?.commands).filter((c) => c.source === "skill" || c.name.startsWith(SKILL_PREFIX)),
  [currentRuntime?.commands],
 );
 // `/` 补全只在草稿是单条命令、光标还在首个 token 内时开。**流式中不开**：那时 Enter 走 steer
 // 插话，`/xxx` 是当文本发出去的，弹出补全等于暗示它能当命令跑。
 const slashToken = (() => {
  if (running || !activeSessionId) return null;
  const m = /^\/(\S*)$/.exec(caretBefore);
  return m ? m[1] : null;
 })();
 // Esc 关掉后记住当时的 token：token 一变（继续打字）就重新打开，不用手动清标记
 const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
 /** `+` 按钮打开的工具面板（与 `/` 共用同一个 `SlashMenu`）：Esc / 再点关闭。 */
 const [toolsOpen, setToolsOpen] = useState(false);
 const slashOpen = slashToken !== null && slashToken !== slashDismissed;
 const slashCands = useMemo(
  () => (slashOpen ? filterCommands(commands, slashToken ?? "") : []),
  [slashOpen, commands, slashToken],
 );
 /** `+` 面板的候选（全部技能）；`/` 面板用 `slashCands`（按输入过滤）。 */
 const toolCands = useMemo(() => filterCommands(commands, ""), [commands]);
 const panelOpen = toolsOpen || slashOpen;
 const panelCands = slashOpen ? slashCands : toolCands;
 // 高亮跟着输入走：slashKey 一变（继续打字 / 命令面刷新）就当回到第一条。
 // 不用 effect 重置——effect 里同步 setState 会多打一轮渲染，react-hooks 规则也不让。
 const slashKey = `${slashToken ?? ""}\u0000${commands.length}`;
 const [slashNav, setSlashNav] = useState<{ key: string; idx: number }>({ key: "", idx: 0 });
 const slashIdx = slashNav.key === slashKey ? slashNav.idx : 0;
 const hoverSlash = (idx: number) => setSlashNav({ key: slashKey, idx });
 const moveSlash = (step: number) =>
  setSlashNav({ key: slashKey, idx: (slashIdx + step + slashCands.length) % (slashCands.length || 1) });

 // `@` 补全：取光标前 `@` 起的路径前缀，300ms 防抖问后端（一层列举 / 递归搜名字，见 `complete_path`）。
 const mentionToken = (() => {
  const m = /@([^\s@]*)$/.exec(caretBefore);
  return m ? m[1] : null;
 })();
 const mentionEmpty = mentionToken == null || !cwd || !activeSessionId || slashToken !== null;
 /** 当前补全的取词 key（`cwd\0token`）：与 `mentionLoadedKey` 对不上 = 还在搜。 */
 const mentionQueryKey = `${cwd}\u0000${mentionToken ?? ""}`;
 /** ESC 关掉后记住当时的 key：继续打字（key 变）就重新打开，与 `/` 命令面同一口径。 */
 const [mentionDismissed, setMentionDismissed] = useState<string | null>(null);
 /** 已取完词的 key：对不上就渲染「搜索中」，**不许让浮层无声消失**（用户实测的坑）。 */
 const [mentionLoadedKey, setMentionLoadedKey] = useState<string | null>(null);
 const mentionOpen = !mentionEmpty && mentionDismissed !== mentionQueryKey;
 // 点浮层外关闭（2026-10-21 用户实测：`+` / `/` 共用面板与 `@` 补全此前只能 Esc 关）：
 // 面板自身 + 各自触发件算「里面」，其余 pointerdown（消息列 / 工具行 / 输入框）一律关。
 // 与 `useDropdown` 同一 document pointerdown 口径，但不抢焦点（键盘由编辑器转交）。
 useOutsideDismiss(
  panelOpen,
  () => {
   setToolsOpen(false);
   if (slashOpen) setSlashDismissed(slashToken);
  },
  (target) => !!panelRef.current?.contains(target) || !!plusBtnRef.current?.contains(target),
 );
 useOutsideDismiss(
  mentionOpen,
  () => setMentionDismissed(mentionQueryKey),
  (target) => {
   if (mentionRef.current?.contains(target)) return true;
   // 编辑器里点光标 = 接着改这枚 `@`，不算外部（token 真没了浮层会自然关）
   const el = target instanceof Element ? target : target.parentElement;
   return !!el?.closest("[data-draft-editor]");
  },
 );
 useEffect(() => {
  if (mentionEmpty) return;
  let alive = true;
  const key = mentionQueryKey;
  const token = mentionToken ?? "";
  const timer = setTimeout(() => {
   void api
    .completePath(cwd, mentionToken)
    .then((rs) => {
     if (!alive) return;
     setMentionCands(rs);
     // 默认落点 = 第一条**路径**；空 token 时浮层最上面还有一行「工作区文件」入口，
     // 只在没有路径可落时才落到入口上——打 `@` 的主诉求是引用文件，不是打开选择器。
     const entry = token === "" ? 1 : 0;
     setMentionIdx(rs.length > 0 ? entry : token === "" ? 0 : -1);
     setMentionLoadedKey(key);
    })
    .catch(() => undefined);
  }, 300);
  return () => {
   alive = false;
   clearTimeout(timer);
  };
 }, [mentionQueryKey, mentionToken, cwd, activeSessionId, mentionEmpty]);

 /** 浮层行：路径候选 + 刚打 `@`（token 为空）且当前项目在工作区里时插在最前面的「工作区文件」入口。 */
 const mentionRows = useMemo<MentionRow[]>(() => {
  if (!mentionOpen) return [];
  const paths: MentionRow[] = mentionCands.map((cand) => ({ kind: "path", cand }));
  return mentionToken === "" && workspaceRefAvailable ? [{ kind: "workspace" }, ...paths] : paths;
 }, [mentionOpen, mentionCands, mentionToken, workspaceRefAvailable]);

 // 选中一行（点击、Tab、Enter 三个入口共用）：
 // - **工作区文件** → 收掉刚打出的 `@`，打开跨项目引用浮层（⌘⇧P 同一入口，选完由它投递芯片）；
 // - **文件** → 换成引用芯片（`ReferenceChipNode`）：显示短标签，序列化出去的是真路径 `c.real`；
 // - **目录** → 换成一段**路径文本** `@<短标签>/`（光标停在其后）：这就是「往下钻一层」——
 //   浮层立刻接着列该目录里的东西，想引用整个目录时直接发送这段文本即可。
 //   （插成芯片的话光标被原子节点挡住、打不出下一段路径，用户实测「进不了文件夹」。）
 const pickMention = (row: MentionRow) => {
  if (row.kind === "workspace") {
   // 不记 `mentionDismissed`：删掉这枚 `@` 后 token 自然变空，浮层自己会关；
   // 记了的话 key（`cwd\0`）不变，用户下一次打 `@` 会被这条标记挡住。
   setMentionCands([]);
   setMentionIdx(-1);
   // 这一枚 `@` 只是入口开关：ReferencePicker 选完直接插芯片，留着会变成 `@@标签`
   editorRef.current?.replaceMentionWithText("", "");
   if (activeSessionId) useApp.getState().set({ refPickerTarget: { sessionId: activeSessionId } });
   return;
  }
  const c = row.cand;
  const token = mentionToken ?? "";
  if (c.isDir) editorRef.current?.replaceMentionWithText(token, `@${c.label}/`);
  else editorRef.current?.replaceMention(token, { path: c.real, label: c.label, isDir: false });
  setMentionIdx(-1);
  setMentionCands([]);
 };

 // 选中一条命令：整条草稿就是这条命令（`/` 开头的语法如此），所以直接换成完整名 + 一个空格；
 // 若首个 token 之后还有内容（在 token 中间补全），接到命令后面而不是丢掉。
 const pickCommand = (c: SlashCandidate) => {
  const sp = draft.search(/\s/);
  const tail = sp >= 0 ? draft.slice(sp).trimStart() : "";
  persistDraft(activeSessionId, commandInsert(c) + tail);
  setSlashDismissed(slashToken);
  setToolsOpen(false);
 };

 // 外部投递的引用（右栏文件树 / 快速过滤 / ⌘⇧P 引用浮层）：插进编辑器后立刻清掉请求。
 // 编辑器非受控，所以引用只能这样进来（改草稿文本只会显示成长路径文本，不是芯片）。
 const pendingReference = useApp((s) => s.pendingReference);
 useEffect(() => {
  if (!pendingReference) return;
  if (pendingReference.sessionId !== activeSessionId) {
   useApp.getState().selectPendingReference(activeSessionId);
   return;
  }
  const handle = editorRef.current;
  if (!handle || editorSessionRef.current !== pendingReference.sessionId) return;
  if (pendingReference.kind === "quote") {
   const text = currentDraft(pendingReference.sessionId);
   if (handle.peekText() !== text) persistDraft(pendingReference.sessionId, text);
   handle.appendQuote(pendingReference.text);
  } else {
   handle.insertReference({ path: pendingReference.path, label: pendingReference.label, isDir: pendingReference.isDir });
  }
  useApp.getState().clearPendingReference(pendingReference.seq);
 }, [pendingReference, activeSessionId, archived, currentDraft, persistDraft]);

 /**
  * 草稿文本变化（编辑器每次 update 上报）：落 store + localStorage；
  * 用户编辑即退出历史浏览（文本保留，下次 ↑ 从最近一条重新开始）。
  */
 const handleText = (text: string, source: DraftTextSource) => {
  editorProjectionRef.current = text;
  // `sync` = 把 store 的草稿投影进编辑器，store 本来就是权威：不回写
  // （回写会让迟到的投影通知覆盖更新的草稿，例如发送失败后的回滚）
  if (source === "sync") return;
  persistDraft(editorSessionRef.current, text, "editor");
  // 只有用户敲的才算「编辑」；壳插入引用不该打断历史浏览（否则 ↑ 调回后被立刻清掉）
  if (source === "user" && browsing) setHist(null);
 };

 /** 输入框占位文案（按当前状态切换；审批中最优先）。 */
 const placeholder = awaiting
  ? t.resolveApprovalFirst
  : dragging
   ? t.placeholderDragging
   : running
    ? t.placeholderRunning
    : empty
     ? t.placeholderNew
     : t.placeholderIdle;

 /** 粘贴（编辑器 capture 阶段先问这里）：图片走附件、大段文本转文件引用、其余交给编辑器。 */
 const handlePaste = (e: ReactClipboardEvent<HTMLElement>): boolean => {
  const files = Array.from(e.clipboardData?.files ?? []);
  if (files.length === 0) {
   // 纯文本粘贴：大段文本转文件引用（V41，zcode 同款）——输入框不被几万字撑爆，
   // omp 侧按 `@file` 提及把内容读进上下文；短文本照常走浏览器默认粘贴。
   const text = e.clipboardData?.getData("text/plain") ?? "";
   if (text.length > PASTE_FILE_MIN) {
    void pasteAsFile(text);
    return true;
   }
   if (text.includes("\n")) {
    // 多行文本走 LineBreakNode（编辑器恒定一个段落；不让粘贴造出段落结构）
    editorRef.current?.insertText(text);
    return true;
   }
   return false;
  }
  // 只拦截图片：文字照常粘贴，图文混贴时文字不丢
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (images.length === 0) {
   if (files.length > 0) setAttachError(t.attachOnlyImages);
   return false;
  }
  // 图文混贴（截图工具常同时给 text+image）：剪贴板文字在前、`#N` 占位紧随其后，
  // 拼成**一次**插入——顺序与光标定位都不依赖两段异步插入的先后。
  const text = e.clipboardData?.getData("text/plain") ?? "";
  void readImages(files).then((added) => commitImages(added, text));
  return true;
 };

 /**
  * 键盘（编辑器 capture 阶段先问这里，返回 true = 这个键归壳处理）：
  * `/` 与 `@` 补全 → 发送 / 插话 / 排队 → 历史浏览 → Shift+Tab 执行模式。
  * 语义与旧 textarea 版逐条对应，只是「光标在开头」改问编辑器（多行编辑时不该抢方向键）。
  */
 // `+` 面板打开时焦点在按钮上（编辑器的 capture 收不到），Esc 用 window 兜底关闭
 useEffect(() => {
  if (!toolsOpen) return;
  const onKey = (e: KeyboardEvent) => {
   if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
   e.preventDefault();
   setToolsOpen(false);
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
 }, [toolsOpen]);

 const handleKeyDown = (e: ReactKeyboardEvent<HTMLElement>): boolean => {
  // 共用面板（`/` 或 `+`）打开时先接管键盘：Esc 关掉它（零命中时面板也在，也该关得掉）。
  if (panelOpen && e.key === "Escape") {
   setSlashDismissed(slashToken);
   setToolsOpen(false);
   return true;
  }
  const slashActive = slashOpen && slashCands.length > 0;
  if (slashActive && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
   moveSlash(e.key === "ArrowDown" ? 1 : -1);
   return true;
  }
  if (slashActive && e.key === "Tab") {
   // 没有高亮（slashIdx = -1）时补第一项：Tab 在补全里不该"什么都不做"
   const c = slashCands[Math.max(0, slashIdx)];
   if (c) pickCommand(c);
   return true;
  }
  if (slashActive && e.key === "Enter" && !e.shiftKey && !(e.metaKey || e.ctrlKey)) {
   // **打全即发**：首 token 已是完整命令名（含别名）时不拦，交给下面的发送逻辑；
   // 否则补全——不然打 `/comp` 回车会被当成把半截命令发出去。
   if (!isCompleteCommand(commands, slashToken ?? "")) {
    const c = slashIdx >= 0 ? slashCands[slashIdx] : undefined;
    if (c) {
     pickCommand(c);
     return true;
    }
   }
  }
  // `@` 补全打开时：上下键导航、Tab/Enter 选中、Esc 关闭（优先于发送）。
  // 行数取 `mentionRows`——空 token 时最上面还有「工作区文件」入口，没有路径候选也能用
  // ↑↓ 停到它上面（`completing` 用 cands 判定会让入口永远键盘够不着）。
  const completing = mentionRows.length > 0;
  if (completing && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
   setMentionIdx((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + mentionRows.length) % mentionRows.length);
   return true;
  }
  if (completing && e.key === "Tab") {
   // 没有高亮（mentionIdx = -1）时补第一项：Tab 在补全里不该"什么都不做"
   const row = mentionRows[Math.max(0, mentionIdx)];
   if (row) pickMention(row);
   return true;
  }
  // Esc 关浮层也认「正在取词」这一态（此时还没有候选，completing 为假）
  if (e.key === "Escape" && mentionOpen) {
   setMentionDismissed(mentionQueryKey);
   setMentionCands([]);
   setMentionIdx(-1);
   return true;
  }
  if (completing && e.key === "Enter" && !e.shiftKey && !(e.metaKey || e.ctrlKey)) {
   const row = mentionIdx >= 0 ? mentionRows[mentionIdx] : undefined;
   if (row) {
    pickMention(row);
    return true;
   }
  }
  // ↑↓ 调回已发送的 prompt 历史（V41，codex 的「Press Up or Down to restore draft history」）：
  // ↑ 只在光标位于**整段开头**（或正在浏览）时接管——多行编辑中照常移动光标；↓ 只在浏览态接管。
  if (e.key === "ArrowUp" && !e.shiftKey && !slashOpen && !completing && activeSessionId) {
   if (browsing || editorRef.current?.isCaretAtStart() === true) {
    browseHistory(-1);
    return true;
   }
  }
  if (e.key === "ArrowDown" && !e.shiftKey && !slashOpen && !completing && browsing) {
   browseHistory(1);
   return true;
  }
  // Shift+Tab = 执行模式循环（V40，对齐 codex / zcode 的 Shift+Tab；补全浮层开着时放行）
  if (e.key === "Tab" && e.shiftKey && !slashOpen && mentionEmpty && activeSessionId && !archived) {
   void cycleApproval();
   return true;
  }
  // Tab = 排队（V39/V40）：流式中且有内容时把草稿排进本轮之后。
  if (
   e.key === "Tab" &&
   !e.shiftKey &&
   running &&
   activeSessionId &&
   !archived &&
   !slashOpen &&
   mentionEmpty &&
   (currentDraft(activeSessionId).trim() || useApp.getState().attachmentsOf(activeSessionId).length > 0)
  ) {
   void sendQueued("follow_up");
   return true;
  }
  if (e.key === "Enter" && !e.shiftKey && !(e.metaKey || e.ctrlKey)) {
   void send();
   return true;
  }
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && running && activeSessionId) {
   // 流式中 Cmd/Ctrl+Enter = 排队（follow_up，本轮后执行）——与 omp 终端的 ctrl+enter / ctrl+q 对齐
   void sendQueued("follow_up");
   return true;
  }
  if (e.key === "Escape" && running && activeSessionId) {
   // Esc = 中断并交还队列（V40；omp TUI 的 Esc 等价物）
   void abortAndRestore(activeSessionId);
   return true;
  }
  // Shift+Enter = 软换行（插入 LineBreakNode；段落只在草稿里有一个，见 `DraftEditor` 的口径）
  if (e.key === "Enter" && e.shiftKey && !(e.metaKey || e.ctrlKey)) {
   editorRef.current?.insertLineBreak();
   return true;
  }
  // 其余按键（普通字符、输入法组合、方向键）交给编辑器
  return false;
 };

 // 模型是否支持图片（模型目录里 `input` 含 image）；目录没加载出来时不做判断，不误报
 const model = models?.models.find((m) => `${m.provider}/${m.id}` === currentModel);
 const imageUnsupported = attachments.length > 0 && !!model?.input && !model.input.includes("image");

 /**
  * 在光标处插入纯文本：`#N` 图片占位与「大段粘贴转文件」的 `@路径` 共用。
  * 光标定位交给编辑器（Lexical 自己把 caret 放到插入段之后），不再手工 setSelectionRange。
  */
 const insertAtCaret = (_sid: string, insert: string) => {
  if (!insert) return;
  editorRef.current?.insertText(insert);
 };

 /** File[] → 附件对象（只收图片，非图片给提示）。不落库、不插占位——由 `commitImages` 收尾。 */
 const readImages = async (files: File[]): Promise<ImageAttachment[]> => {
  const skipped = files.filter((f) => !f.type.startsWith("image/"));
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (images.length === 0) {
   if (skipped.length > 0) setAttachError(t.attachOnlyImages);
   return [];
  }
  setAttachError(skipped.length > 0 ? t.attachSomeIgnored : null);
  const added: ImageAttachment[] = [];
  for (const f of images) {
   try {
    added.push(await attachmentFromFile(f, t));
   } catch (e) {
    setAttachError(e instanceof Error ? e.message : t.attachReadFailed);
   }
  }
  return added;
 };

 /** 图片入口的统一收尾（粘贴 / 拖拽 / `+` 菜单）：附件入库（store 分配稳定编号）并在光标处
  *  插入 `#N` 占位（多张空格分隔）。`prefix` = 图文混贴时剪贴板附带的文字——文字在前、占位紧随
  *  其后，拼成**一次**插入（顺序不依赖两段异步插入的先后，光标也只定位一次）。 */
 const commitImages = (items: ImageAttachment[], prefix = "") => {
  const sid = activeSessionId;
  if (!sid) return;
  const assigned = addAttachments(sid, items);
  insertAtCaret(sid, prefix + assigned.map((a) => `#${a.slot}`).join(" "));
 };

 /** 大段粘贴转文件引用（V41，zcode 同款）：存临时文件 + 在光标处插入 `@<绝对路径> `。
  *  之后走 omp 原生的 `@file` 提及（发送时展开成 fileMention 读进上下文），壳侧零自定义协议。 */
 const pasteAsFile = async (text: string) => {
  const sid = activeSessionId;
  if (!sid) return;
  try {
   const { path } = await api.savePaste(text);
   // 大段粘贴落成临时文件后直接插一枚引用芯片（显示文件名，序列化出绝对路径）
   editorRef.current?.insertReference({
    path,
    label: path.split("/").pop() ?? path,
    isDir: false,
   });
   setAttachError(fmt(t.pasteAsFile, path.split("/").pop() ?? path));
  } catch (e) {
   setAttachError(e instanceof Error ? e.message : String(e));
  }
 };

 /**
  * `+` 菜单「文件」：系统文件选择器，**按类型分流**——
  * - 图片（png / jpg / jpeg / webp / gif）→ 附件（`prompt.images`，与粘贴 / 拖拽同一条路）；
  * - 其他文件 → 在光标处插一枚引用芯片，写的是 `referenceTarget` 的路径（会话目录内相对、
  *   目录外绝对——与右栏文件树 / ⌘⇧P 引用浮层同一条投递口径），omp 按 `@file` 读进上下文。
  * 不设过滤器：omp 的附件只吃图片，非图片文件走 mention 才是它们进上下文的正确方式。
  */
 const pickFiles = async () => {
  const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
  try {
   const picked = await open({ multiple: true, title: t.plusFilePickTitle });
   if (!picked) return;
   const paths = Array.isArray(picked) ? picked : [picked];
   setAttachError(null);
   const added: ImageAttachment[] = [];
   for (const p of paths) {
    if (IMAGE.test(p)) {
     try {
      added.push(await api.readImageFile(p));
     } catch (e) {
      setAttachError(e instanceof Error ? e.message : t.attachReadFailed);
     }
     continue;
    }
    // 跨平台取基名：Tauri 在 Windows 上给的是反斜杠路径（芯片 label 不该是整条路径）
    const name = p.split(/[\\/]/).filter(Boolean).pop() ?? p;
    editorRef.current?.insertReference({ path: referenceTarget(cwd, p), label: name, isDir: false });
   }
   if (added.length > 0) commitImages(added);
   // 选完回到输入框（系统对话框会夺焦；不显式还回来的话用户得再点一下才能继续写）
   editorRef.current?.focus();
  } catch (e) {
   setAttachError(e instanceof Error ? e.message : t.attachPickFailed);
  }
 };

 /** `+` 菜单「工作区文件」：⌘⇧P 的跨项目引用浮层（投递口径完全一致）。 */
 const openWorkspacePicker = () => {
  // 项目没进工作区（或工作区没有其他成员）时引用范围为空：面板里不会出现这个入口，
  // 这里再挡一次（`@` 浮层入口 / ⌘⇧P 同口径），不开一个只能看到「没有可引用项目」的空浮层。
  if (!workspaceRefAvailable) return;
  if (activeSessionId) useApp.getState().set({ refPickerTarget: { sessionId: activeSessionId } });
 };

 /** `+` 菜单「压缩」：与工具行的压缩行动点同一条后端通路（失败由流内错误行展示）。 */
 const compactNow = async () => {
  if (!activeSessionId) return;
  try {
   await api.compactSession(activeSessionId);
  } catch {
   // 同 `CompactButton`：不弹错，omp 的错误走 divider 行
  }
 };

 /** `/` 面板顶部固定操作（与 `+` 菜单一致）：清掉 `/` 草稿后执行同一条动作。 */
 const pickSlashAction = (a: SlashAction) => {
  if (!activeSessionId) return;
  setToolsOpen(false);
  setSlashDismissed(slashToken);
  // `/` 面板的草稿就是一条 `/`；`+` 面板打开时草稿可能是用户内容，不能清
  if (slashOpen) persistDraft(activeSessionId, "");
  if (a === "file") void pickFiles();
  else if (a === "workspace") openWorkspacePicker();
  else void compactNow();
 };

 /** 技能：把完整命令 `/skill:<名> ` 插到输入框（omp 只认消息开头，非空草稿插到最前）。 */
 const pickSkill = (name: string) => {
  setToolsOpen(false);
  const cmd = `/${name} `;
  // omp 的命令门只认消息开头的 `/`：光标前已有文字时插到光标处，命令就落在正文中间，
  // 发送后技能不会加载（实测一帧 skill-prompt 都没有）——所以非空草稿一律插到最前。
  if (draft.trim()) editorRef.current?.insertTextAtStart(cmd);
  else editorRef.current?.insertText(cmd);
  editorRef.current?.focus();
 };

 /** 共用面板选中：`/` 打开时按命令写整条草稿；`+` 打开时把技能插到光标处。 */
 const pickPanel = (c: SlashCandidate) => {
  if (slashOpen) {
   pickCommand(c);
   return;
  }
  setToolsOpen(false);
  pickSkill(c.name);
 };

 // 流式中追问的发送语义**对齐 omp 终端与 codex**（codex TUI 实测：轮次运行中 Enter 走 steer、
 // Tab 排队、Esc 打断；omp 终端：Enter = steering 插话、Ctrl+Q / Ctrl+Enter = follow-up 排队）——
 // Enter 走插话（steer，进当前轮、下一个边界生效），Tab 与 Cmd/Ctrl+Enter 走排队（follow_up，
 // 本轮后执行）；送达处理交给 omp 自己的设置（steeringMode / followUpMode / interruptMode）。
 // 运行中的「排队」按钮 2026-10-13 按用户口径退场（原先 = 同一通路的鼠标等价物）——排队只剩 Tab /
 // ⌘Ctrl+Enter 两个键盘入口。
 // 「待发区」（V40）= **omp 的队列真值**（`queue_update` 帧驱动，ack 后立即到达）：
 // 撤回 / 编辑 / 提升 / 中断还原全部按真值操作，壳侧不做本地对账（V39 的乐观条目已退场）。
 /**
  * 发送前把输入框里的**短标签**还原成完整相对路径（`@components/` → `@src/views/…/components/`）。
  *
  * 输入框显示短标签、omp 只认真路径，所以这一步必须有；解析规则与芯片的「存在性」同一个后端
  * 入口（`check_paths` 的 `resolved`），两边不会各说各话。解析不出来（歧义 / 不存在）就按原文发
  * ——芯片此时已经用警告色告诉过用户了。**失败不阻塞发送**。
  */
 const expandMentions = async (text: string, baseCwd: string): Promise<string> => {
  const tokens = extractMentions(text);
  if (tokens.length === 0 || !baseCwd) return text;
  try {
   const rs = await api.checkPaths(baseCwd, tokens);
   const map = new Map(rs.filter((r) => r.resolved).map((r) => [r.path, r.resolved as string]));
   return map.size > 0
    ? rewriteMentions(text, (token) => {
       const hit = map.get(token);
       if (hit === undefined) return null;
       // 目录写法（`@components/`）保留尾斜杠，还原后仍是「这是一个目录」的写法
       return token.endsWith("/") && !hit.endsWith("/") ? `${hit}/` : hit;
      })
    : text;
  } catch {
   return text;
  }
 };

 /** 同会话的发送串行；锁在首个异步操作前取得，避免连续按键重复发送。 */
 const beginSend = (sid: string): boolean => {
  if (creatingRef.current || sendingRef.current.has(sid)) return false;
  sendingRef.current.add(sid);
  setSending(new Set(sendingRef.current));
  return true;
 };

 const endSend = (sid: string) => {
  sendingRef.current.delete(sid);
  setSending(new Set(sendingRef.current));
 };

 /** 在任何异步操作前取走当前草稿；后续输入属于下一条消息。 */
 const takeDraft = (sid: string, raw: string) => {
  const st = useApp.getState();
  const images = st.attachmentsOf(sid);
  persistDraft(sid, "");
  clearAttachments(sid);
  return { raw, images };
 };

 /** 失败时保留新输入；图片重新编号后同步失败消息中的引用，避免与新附件冲突。 */
 const restoreDraft = (sid: string, raw: string, images: ImageAttachment[]) => {
  const occupied = new Set(useApp.getState().attachmentsOf(sid).map((image) => image.slot));
  const restoredImages = addAttachments(sid, images.map((image) =>
   occupied.has(image.slot) ? { ...image, slot: undefined } : image,
  ));
  const text = images.length > 0 ? restoreImageOrder(withImageOrderNote(raw, images), restoredImages) : raw;
  const current = currentDraft(sid);
  persistDraft(sid, text.trim() && current.trim() ? `${text}\n\n${current}` : text + current);
 };

 const sendQueued = async (mode: "steer" | "follow_up") => {
  const sid = activeSessionId;
  const st = useApp.getState();
  if (!sid) return;
  const raw = currentDraft(sid);
  if ((!raw.trim() && st.attachmentsOf(sid).length === 0) || archived || !beginSend(sid)) return;
  const { images: sentImages } = takeDraft(sid, raw);
  // `/` 开头的命令不能走 steer / follow_up：omp 只在 `prompt` 入口过命令门（实测
  // steer 里的 `/skill:…` 不注入技能）。统一走 run_slash，运行中由 omp 排队到下一个边界。
  if (raw.trim().startsWith("/") && sentImages.length === 0) {
   const cmdText = raw.trim();
   try {
    await api.runSlash(sid, cmdText);
    pushHistory(sid, cmdText);
    resetHistory();
   } catch {
    restoreDraft(sid, raw, sentImages);
   } finally {
    endSend(sid);
   }
   return;
  }
  try {
   const text = await expandMentions(raw, cwd);
   const wireText = withImageOrderNote(text, sentImages);
   const fn = mode === "steer" ? api.steerMessage : api.followUpMessage;
   await fn(
    sid,
    wireText,
    sentImages.map((a) => ({ name: a.name, mimeType: a.mimeType, dataBase64: a.dataBase64, bytes: a.bytes })),
   );
   pushHistory(sid, raw);
   resetHistory();
  } catch {
   restoreDraft(sid, raw, sentImages);
  } finally {
   endSend(sid);
  }
 };

 /**
  * 发送前展开的**逆操作**：把文本里的真路径缩成短标签（退回输入框的队列消息用）。
  * 规则由 `mention_label` 一端决定（最短唯一后缀），拿不到标签的 mention 原样保留。
  */
 const shortenMentions = async (text: string): Promise<string> => {
  const tokens = extractMentions(text);
  if (tokens.length === 0 || !cwd) return text;
  try {
   const pairs = await Promise.all(
    tokens.map(async (token) => [token, await api.mentionLabel(cwd, token).catch(() => null)] as const),
   );
   const map = new Map(pairs.filter(([, label]) => label !== null) as [string, string][]);
   return map.size > 0
    ? rewriteMentions(text, (token) => {
       const hit = map.get(token);
       if (hit === undefined || hit === token) return null;
       return token.endsWith("/") && !hit.endsWith("/") ? `${hit}/` : hit;
      })
    : text;
  } catch {
   return text;
  }
 };

 /** 「编辑」一条排队消息（zcode 口径：整条连同附件退回输入框、从队列移除）。 */
 const editQueued = async (text: string, queue: "steering" | "followUp") => {
  const sid = activeSessionId;
  if (!sid) return;
  try {
   const r = await api.removeQueuedMessage(sid, text, queue);
   if (!r.removed) return;
   // 按新分配的附件编号改写正文，再剥掉队列里的顺序注记。
   const back = await shortenMentions(text);
   const images = addAttachments(sid, (r.images ?? []).map(attachmentFromOmpImage));
   const restored = restoreImageOrder(back, images);
   const cur = currentDraft(sid);
   persistDraft(sid, cur.trim() ? `${cur}\n\n${restored}` : restored);
   editorRef.current?.focus();
  } catch {
   // 失败（已被投递 / 已消费）：队列快照随后自行收敛，不弹错
  }
 };

 /** 撤回一条排队消息（不退回草稿）。 */
 const removeQueued = async (text: string, queue: "steering" | "followUp") => {
  const sid = activeSessionId;
  if (!sid) return;
  try {
   await api.removeQueuedMessage(sid, text, queue);
  } catch {
   // 同上：快照收敛
  }
 };

 /** 把一条 followUp 提升为 steering（排队 → 立刻插话）。 */
 const promoteQueued = async (text: string) => {
  const sid = activeSessionId;
  if (!sid) return;
  try {
   await api.promoteQueuedMessage(sid, text);
  } catch {
   // 同上
  }
 };

 /**
  * Esc = 中断并交还队列（V40；omp TUI 的 Esc 等价物 / codex 的「打断时把 pending 还给输入框」）：
  * 返回的插话 / 排队消息连图片一起放回输入框（草稿已有内容时空行追加）。
  */
 const abortAndRestore = async (sid: string) => {
  try {
   const r = await api.abortAndRestoreQueue(sid);
   const items = [...r.steering, ...r.followUp];
   if (items.length > 0) {
    const text = items
     .map((i) => {
      const images = addAttachments(sid, (i.images ?? []).map(attachmentFromOmpImage));
      return restoreImageOrder(i.text, images);
     })
     .filter((x) => x.trim())
     .join("\n\n");
    if (text) {
     const cur = currentDraft(sid);
     persistDraft(sid, cur.trim() ? `${cur}\n\n${text}` : text);
    }
    editorRef.current?.focus();
   }
  } catch {
   // 接口失败兜底：直发 abort（保证「停止」这个动作本身不丢）
   void api.stop(sid).catch(() => undefined);
  }
 };

 /**
  * 执行模式循环（V40/V41）：实现提取到 `lib/sessionApproval.ts`——
  * always-ask → write → yolo；idle 时自动重启 runtime 生效、running 挂起到本轮结束。
  */
 const cycleApproval = async () => {
  const sid = activeSessionId;
  if (!sid || archived) return;
  await cycleSessionApproval(sid);
 };

 /** 本地 shell（V41，codex 的 `!` 前缀）：`$ cmd` 先行落一行，完成后输出落第二行。 */
 const runShell = async (sid: string, cmd: string) => {
  localNote(sid, `$ ${cmd}`);
  try {
   const r = await api.runBash(sid, cmd);
   const out = (r.output ?? "").trimEnd();
   const exitNote = r.exitCode === 0 ? "" : fmt(t.bashExitNote, r.exitCode);
   localNote(sid, [out || t.bashNoOutput, exitNote].filter(Boolean).join("\n"));
  } catch (e) {
   localNote(sid, e instanceof Error ? e.message : String(e));
  }
 };

 /** 会话内反馈：往消息流尾追加一条本地 command 行（灰字代码区，与 omp 命令输出同款）。 */
 const localNote = (sid: string, text: string) => {
  useApp.getState().appendEvents(sid, [
   { kind: "command", id: `lc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, output: text } as ViewMsg,
  ]);
 };

 /** 已发送 prompt 历史（V41，codex 的 ↑↓ 调回）：浏览态 {sid, idx, backup}——idx 指向历史下标、
  *  backup = 开始浏览前的草稿（↓ 到底还原）。带 sid 标记 → 切会话后自动不活跃，无需 effect 重置。 */
 const [hist, setHist] = useState<{ sid: string; idx: number; backup: string } | null>(null);
 const historyRef = useRef<{ sid: string; items: string[] } | null>(null);
 const browsing = hist && hist.sid === activeSessionId ? hist : null;
 const resetHistory = () => {
  setHist(null);
  historyRef.current = null;
 };

 /** ↑↓ 浏览历史（codex 的「Press Up or Down to restore draft history」）。 */
 const browseHistory = (dir: 1 | -1) => {
  const sid = activeSessionId;
  if (!sid) return;
  if (historyRef.current?.sid !== sid) historyRef.current = { sid, items: loadHistory(sid) };
  const list = historyRef.current.items;
  if (list.length === 0) return;
  if (!browsing) {
   if (dir === 1) return; // 不在浏览态时 ↓ 不做事
   setHist({ sid, idx: list.length - 1, backup: draft });
   persistDraft(sid, list[list.length - 1]);
   // 光标落到末尾由编辑器负责（`setText` 的语义）
   return;
  }
  const next = browsing.idx + dir;
  if (next < 0) return; // 到顶不动
  if (next >= list.length) {
   // 到底：还原浏览前草稿并退出浏览
   setHist(null);
   persistDraft(sid, browsing.backup);
   return;
  }
  setHist({ ...browsing, idx: next });
  persistDraft(sid, list[next]);
 };



 /** 把一条消息发进指定会话（正常发送与空态新建后共用）：乐观回显 + 失败回滚 + 标题回退。 */
 const sendTextTo = async (sid: string, baseCwd: string, raw: string, sentImages: ImageAttachment[]) => {
  // 输入框里是短标签，omp 只认真路径：发送前展开（回显 / 历史 / 回滚都用原文，用户看到的还是自己写的）
  const text = await expandMentions(raw, baseCwd);
  // 正文引用 `#N` 且带图时，补一行「#N 对应第几张图」的注记（模型只看得到图片顺序；
  // 注记只进 wire text，乐观回显 / 历史 / 队列展示都用原文）
  const wireText = withImageOrderNote(text, sentImages);
  // 首条判定：流里还没有 user 消息 = 这是本会话第一条（标题回退只做这一次）
  const isFirst = !(useApp.getState().eventsBySession[sid] ?? []).some((m) => m.kind === "user");
  // 乐观回显：先落一条本地 user 消息，id 带时间戳；
  // 历史回放里同一文本的 `u:<行id>` 到达时按文本合并去重，不翻倍。
  const optimisticId = `u-local-${Date.now()}`;
  useApp.getState().appendEvents(sid, [
   {
    kind: "user",
    id: optimisticId,
    text: raw,
    sentText: text,
    mentions: extractMentions(raw),
    ...(sentImages.length > 0
     ? { images: sentImages.map((a) => ({ mimeType: a.mimeType, data: a.dataBase64 })) }
     : {}),
   } as never,
  ]);
  try {
   await api.sendMessage(
    sid,
    wireText,
    sentImages.map((a) => ({ name: a.name, mimeType: a.mimeType, dataBase64: a.dataBase64, bytes: a.bytes })),
   );
   pushHistory(sid, raw);
   resetHistory();
   // 新回合开始：上一轮**已全部完成**的任务清单收起来（用户实测：完成清单一直挂在
   // 新对话上）。未完成的不动——那还是 omp 的真实任务状态；omp 在自动清理窗口内的
   // 回读由 store 的收起签名挡掉。
   useApp.getState().dismissCompletedPlans(sid);
   // 首条发送成功：本地回退先顶上 + 回读 omp 真值（rpc-ui 实测不产标题，回退即终态；
   // TUI 侧改过名时真值覆盖回退）。失败不阻塞发送链路。
   if (isFirst && raw.trim() && sentImages.length === 0) {
    void refreshTitleAfterFirstSend(sid, raw).catch(() => undefined);
   }
  } catch {
   // 发失败就把草稿与附件还回去、不留幽灵消息，不让用户重打一遍
   restoreDraft(sid, raw, sentImages);
   const st = useApp.getState();
   st.set({
    eventsBySession: {
     ...st.eventsBySession,
     [sid]: (st.eventsBySession[sid] ?? []).filter((m) => m.id !== optimisticId),
    },
   });
  }
 };

 /**
  * 空态输入卡的第一条消息：先新建会话，再把这条消息发进去。
  * 目录与 ⌘T 同口径（`resolveNewChatCheckout`），没有可用目录时退回第一个项目路径。
  */
 const sendFirstInNewChat = async () => {
  const raw = currentDraft(NEW_DRAFT);
  if (!raw.trim() || !beginSend(NEW_DRAFT)) return;
  const dir = resolveNewChatCheckout(checkouts)?.path ?? projects[0]?.path ?? "";
  if (!dir) {
   setAttachError(t.newChatNoProject);
   endSend(NEW_DRAFT);
   return;
  }
  creatingRef.current = true;
  setCreating(true);
  setAttachError(null);
  takeDraft(NEW_DRAFT, raw);
  const generation = { navigated: false, pending: "" };
  const unsubscribe = useApp.subscribe((next, previous) => {
   const switchedSession = next.activeSessionId !== previous.activeSessionId;
   const openedSettings = next.settingsTabActive && !previous.settingsTabActive;
   if (!switchedSession && !openedSettings) return;
   if (!generation.navigated && previous.activeSessionId === null) {
    generation.navigated = true;
    generation.pending = currentDraft(NEW_DRAFT);
    persistDraft(NEW_DRAFT, "");
   } else {
    generation.navigated = true;
   }
  });
  let restoreSid = NEW_DRAFT;
  try {
   const res = await createChatIn(dir, { shouldActivate: () => !generation.navigated });
   if (!res.ok) {
    setAttachError(res.message);
    if (generation.navigated) {
     saveRecoveredDraft(raw.trim() && generation.pending.trim() ? `${raw}\n\n${generation.pending}` : raw + generation.pending);
    } else {
     restoreDraft(NEW_DRAFT, raw, []);
    }
    return;
   }
   restoreSid = res.id;
   // 只迁移启动本次新建时所属代次的空态草稿。
   const pending = generation.pending;
   const current = currentDraft(res.id);
   if (pending) {
    persistDraft(res.id, pending.trim() && current.trim() ? `${pending}\n\n${current}` : pending + current);
   }
   const created = useApp.getState().sessions.find((s) => s.id === res.id);
   await sendTextTo(res.id, created?.cwd ?? dir, raw, []);
  } catch (e) {
   if (restoreSid === NEW_DRAFT && generation.navigated) {
    saveRecoveredDraft(raw.trim() && generation.pending.trim() ? `${raw}\n\n${generation.pending}` : raw + generation.pending);
   } else {
    restoreDraft(restoreSid, raw, []);
   }
   setAttachError(e instanceof Error ? e.message : String(e));
  } finally {
   unsubscribe();
   creatingRef.current = false;
   setCreating(false);
   endSend(NEW_DRAFT);
  }
 };

 const send = async () => {
  // 空态（没有活动会话）：输入的第一条消息 = 新建会话 + 发送
  if (!activeSessionId) {
   void sendFirstInNewChat();
   return;
  }
  const sid = activeSessionId;
  const st = useApp.getState();
  const raw = currentDraft(sid);
  const images = st.attachmentsOf(sid);
  if ((!raw.trim() && images.length === 0) || archived || creatingRef.current || sendingRef.current.has(sid)) return;
  // `!` 前缀 = 本地 shell（V41，codex 的 `!` 用法）：在会话进程的工作目录跑一条命令，
  // 命令行与输出各落一条流尾 command 行；运行中也可用（omp 的 bash 是 concurrent 分发）。
  if (raw.trim().startsWith("!") && raw.trim().length > 1 && images.length === 0) {
   const cmd = raw.trim().slice(1).trim();
   takeDraft(sid, raw);
   void runShell(sid, cmd);
   return;
  }
  // `/` 开头一律走 omp 命令面（run_slash 直发）：omp 在 `prompt` 入口过命令门，
  // `/skill:<名>` 会被解析成技能注入（实测 skill-prompt），运行中则由 omp 排到下一个边界。
  // 走 steer 只会把 `/skill:…` 当普通文本，技能不会被加载——所以不能按 running 改道。
  if (raw.trim().startsWith("/") && images.length === 0) {
   if (!beginSend(sid)) return;
   takeDraft(sid, raw);
   const cmdText = raw.trim();
   try {
    await api.runSlash(sid, cmdText);
    pushHistory(sid, cmdText);
    resetHistory();
   } catch {
    restoreDraft(sid, raw, []);
   } finally {
    endSend(sid);
   }
   return;
  }
  if (running) {
   // 流式中 Enter = 插话（steer），与 omp 终端的 Enter 一致
   void sendQueued("steer");
   return;
  }
  if (!beginSend(sid)) return;
  const snapshot = takeDraft(sid, raw);
  try {
   await sendTextTo(sid, cwd, snapshot.raw, snapshot.images);
  } finally {
   endSend(sid);
  }
 };

 if (archived) {
  return (
   <div className="shrink-0 pb-4">
    <div className="mx-auto max-w-(--measure-content) rounded-xl border border-border bg-surface px-4 py-3 text-center text-sm text-muted">
     {t.archivedComposerHint}
    </div>
   </div>
  );
 }

 // 宽度口径：输入卡 = 中列 85%（`--measure-content`，与正文列 / 查找条同档、三者左缘对齐）。
 // 外层**不挂水平内边距**——挂上 px-4 就把 85% 的基准缩成「中列 − 32」，卡比正文窄一截、看着错位。
 return (
  <div className={`shrink-0 pb-4 ${empty ? "pb-[14vh]" : ""}`}>
   {/* `@` 路径补全（2026-10-20 用户口径：浮层在输入卡**外部**）：一层列举 / 递归搜名字
       （`complete_path`），Tab/Enter 选中；空 token 时最上面多一行「工作区文件」入口。
       取词中与「没有匹配」都留在浮层里如实说——无声消失会被当成坏了（用户实测）。 */}
   {mentionOpen && (
    <div ref={mentionRef} className="mx-auto mb-1.5 max-w-(--measure-content)">
     <MentionList
      rows={mentionRows}
      active={mentionIdx}
      onPick={pickMention}
      onHover={setMentionIdx}
      status={mentionLoadedKey !== mentionQueryKey ? "loading" : mentionRows.length > 0 ? "ready" : "empty"}
     />
    </div>
   )}
   {/* `+` 与 `/` 共用同一个面板（2026-10-20 用户口径）：操作组 + 技能；
       `/` 打开时按输入过滤，`+` 打开时列全部技能 */}
   {panelOpen && (
    <div ref={panelRef} className="mx-auto mb-1.5 max-w-(--measure-content)">
     <SlashMenu
      cands={panelCands}
      active={slashOpen ? slashIdx : -1}
      query={slashOpen ? (slashToken ?? "") : ""}
      onPick={pickPanel}
      onHover={hoverSlash}
      onAction={pickSlashAction}
      compactDisabled={running}
      workspaceAvailable={workspaceRefAvailable}
     />
    </div>
   )}
   <div
    onDragOver={(e) => {
     if (!e.dataTransfer.types.includes("Files")) return;
     e.preventDefault();
     setDragging(true);
    }}
    onDragLeave={() => setDragging(false)}
    onDrop={(e) => {
     if (!e.dataTransfer.files?.length) return;
     e.preventDefault();
     setDragging(false);
     void readImages(Array.from(e.dataTransfer.files)).then((added) => commitImages(added));
    }}
    className={`mx-auto max-w-(--measure-content) rounded-xl border bg-surface transition-colors duration-100 ${dragging ? "border-accent bg-accent/5" : awaiting ? "border-warn/60" : "border-border has-[.draft-editor:focus]:border-accent/70"
     }`}
   >
    {/* 卡内顶行（2026-10-22 用户口径：项目 / 分支 / 提交回到输入卡内部）：卡片自己是
        这一行与输入区的共同外框，行与工具行同一份左右内边距；`has-[.draft-editor:focus]`
        让高亮只跟编辑焦点走——点项目 / 分支这类行钮不再把整张卡点亮（原先 `focus-within`
        只包着编辑器，现在卡片里有了别的按钮）。与「+」菜单等共用 composerMenu 互斥槽。 */}
    <div className="flex items-center gap-0.5 px-2 pt-1">
     <ProjectPicker project={project} />
     {git?.isRepo ? (
      <>
       <BranchPicker git={git} cwd={cwd} loading={gitLoading} onReload={reloadGit} />
       <CommitButton cwd={cwd} />
      </>
     ) : null}
    </div>
    {awaiting && <div className="px-4 pt-2.5 text-[13px] text-warn">{t.resolveApprovalFirst}</div>}
    {attachments.length > 0 && (
     <div className="flex flex-wrap gap-2 px-3 pt-3">
      {attachments.map((a, i) => (
       <div key={a.slot ?? `${a.name}-${i}`} className="group relative">
        <img
         src={dataUrl(a)}
         alt={a.name}
         title={`${a.name} · ${Math.round(a.bytes / 1024)}KB`}
         className="h-16 w-16 rounded-md border border-border object-cover"
        />
        {/* 编号角标与文字里的 `#N` 占位同源（store 稳定分配）：删图不重编号，正文引用不错位 */}
        {a.slot !== undefined && (
         <span className="pointer-events-none absolute -top-1.5 -left-1.5 select-none rounded-md border border-border bg-surface px-1 font-mono text-[10px] leading-4 text-muted">
          #{a.slot}
         </span>
        )}
        <button
         onClick={() => removeAttachment(activeSessionId, i)}
         aria-label={fmt(t.attachRemoveAria, a.name)}
         className="absolute -top-1.5 -right-1.5 cursor-pointer rounded-full border border-border bg-surface p-0.5 text-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:text-danger focus:opacity-100"
        >
         <X size={12} aria-hidden />
        </button>
       </div>
      ))}
     </div>
    )}
    {attachError && <div className="px-4 pt-2 text-[13px] text-danger">{attachError}</div>}
    {recoveredDraft && !activeSessionId && (
     <button type="button" className="mx-4 mt-2 text-left text-[13px] text-warn" onClick={() => {
      const current = currentDraft(NEW_DRAFT);
      persistDraft(NEW_DRAFT, current.trim() && recoveredDraft.trim() ? `${current}\n\n${recoveredDraft}` : current + recoveredDraft);
      setRecoveredDraft("");
      try { localStorage.removeItem(NEW_DRAFT_RECOVERY); } catch { /* 不影响当前草稿 */ }
     }}>
      {t.newChatRestoreDraft}
     </button>
    )}
    {/* 引用**不再单独排一行芯片**（2026-10-17 用户口径：标签已经融入正文，别又展示 tag 又展示路径）。
        只有解析不到的引用才提示——那时用户需要知道「它不会被读进上下文」。 */}
    {missingMentions.length > 0 && (
     <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2" role="status">
      <span className="inline-flex items-center gap-1 text-[12px] text-warn">
       <TriangleWarning size={12} aria-hidden />
       {fmt(t.mentionsMissingHint, String(missingMentions.length))}
      </span>
      {missingMentions.map((p) => (
       <span
        key={p}
        title={t.mentionMissingTitle}
        className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-warn/50 px-2 py-0.5 font-mono text-xs text-warn"
       >
        <span className="truncate">@{p}</span>
        <span className="sr-only">{t.pathMissing}</span>
       </span>
      ))}
     </div>
    )}
    {imageUnsupported && (
     <div className="px-4 pt-2 text-[13px] text-warn">{t.imageUnsupported}</div>
    )}
    {/* 待发区（V40，omp 队列真值 / codex pending input preview 同口径）：steering = 插话、
        followUp = 排队；hover 出操作——撤回 / 编辑（退回输入框）/ 提升为插话（仅排队行）。
        只读的旧口径（V39「omp 没有 dequeue RPC」）已过时：18.10.1 有 remove / promote。 */}
    {queued.steering.length + queued.followUp.length > 0 && (
     <ul className="flex flex-col gap-1 px-3 pt-2" role="status">
      {queued.steering.map((text, i) => (
       <QueueRow
        key={`s-${i}-${text}`}
        mode="steer"
        text={stripImageOrderNote(text)}
        onEdit={() => void editQueued(text, "steering")}
        onRemove={() => void removeQueued(text, "steering")}
       />
      ))}
      {queued.followUp.map((text, i) => (
       <QueueRow
        key={`f-${i}-${text}`}
        mode="queue"
        text={stripImageOrderNote(text)}
        onEdit={() => void editQueued(text, "followUp")}
        onRemove={() => void removeQueued(text, "followUp")}
        onPromote={() => void promoteQueued(text)}
       />
      ))}
     </ul>
    )}
    <label htmlFor="composer" className="sr-only">
     {t.composerLabel}
    </label>
    {/* `@` / `/` 补全浮层已移到输入卡**外部**（2026-10-20 用户口径）：卡片上方的独立块，
        不再塞在卡片内部——原先它们把输入区往下推，看起来就像输入框的一部分。 */}
    {/* 输入区：草稿编辑器（Lexical）——`@引用` 是原子芯片（图标 + 短标签），
        序列化出去的是真路径；高度由内容撑开（CSS 封顶 `max-h-44`）。
        悬停给出 `@标签 → 真实相对路径`（引用不单独排芯片，完整路径要查就在这里）。 */}
    <DraftEditor
     ref={editorRef}
     ariaLabel={t.composerLabel}
     placeholder={placeholder}
     title={mentionTitles || undefined}
     initialText={draft}
     onText={handleText}
     onCaretText={setCaretBefore}
     onKeyDown={handleKeyDown}
     onPaste={handlePaste}
     editable={!awaiting}
    />
    <div className="flex flex-wrap items-center gap-0.5 gap-y-1 px-2 py-1.5">
     {/* 卡底工具行（v2 §3）：左 = `+`（文件 / 工作区文件 / 压缩）+ 执行模式菜单 + 排队徽标；
         右 = 压缩行动点 / 上下文容量环 / 供应商用量（2026-10-14 从顶栏右端搬进输入卡）+
         模型 / 思考档（两个独立选择器）+ 发送 / 停止 */}
     <button
      ref={plusBtnRef}
      type="button"
      onClick={() => setToolsOpen((v) => !v)}
      disabled={!activeSessionId || awaiting}
      aria-label={t.plusMenuAria}
      aria-expanded={panelOpen}
      title={t.plusMenuAria}
      className={`flex shrink-0 cursor-pointer items-center justify-center rounded-md p-1.5 transition-colors duration-100 hover:bg-hover disabled:cursor-default disabled:opacity-40 ${panelOpen ? "bg-active text-foreground" : "text-muted hover:text-foreground"}`}
     >
      <Plus size={16} aria-hidden />
     </button>
     <ApprovalModeMenu />
     <QueueBadge />
     <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
      <CompactButton />
      {/* Fast = 当前模型的服务档位（不是换模型）；开关与模型选择器分开，避免选模型副作用 */}
      <FastMenu />
      {/* 模型与思考档是两个独立选择器（2026-10-14 拆分）：模型名 ▾ 与 档位 ▾ 各开各的浮层 */}
      <ModelMenu />
      <ThinkingMenu />
      {/* 运行中 = 同一个圆形键变「停止」（v2：idle 圆形 ↑；running 停止 ■） */}
      {running ? (
       <button
        onClick={() => activeSessionId && void abortAndRestore(activeSessionId)}
        className="ml-1 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity duration-150 hover:opacity-90"
        aria-label={t.stop}
        title={t.stop}
       >
        <span className="h-2 w-2 rounded-[2px] bg-primary-foreground" aria-hidden />
       </button>
      ) : (
       <button
        onClick={() => void send()}
        disabled={(!draft.trim() && attachments.length === 0) || awaiting || creating || sending.has(draftKey)}
        className="ml-1 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity duration-150 hover:opacity-90 disabled:cursor-default disabled:opacity-30"
        aria-label={t.sendAria}
       >
        <ArrowUp size={15} aria-hidden />
       </button>
      )}
     </div>
    </div>
   </div>
   {/* 卡底统计条（2026-10-20 用户口径：移到输入卡**外部**）：
       **卡片下方独立一行**——与卡片同宽、整条靠右，四项各自点开明细。
       不许塞进工具行（会与模型 / 发送键同行、分隔线只剩半截），也不再放回卡片内部。 */}
   <div className="mx-auto mt-1.5 max-w-(--measure-content)">
    <SessionStatsBar />
   </div>
  </div >
 );
}

/**
 * 待发队列的一行（V40）：插话 / 排队标签 + 文本 + hover 操作（撤回 / 编辑 / 提升）。
 * 编辑 = 整条退回输入框并从队列移除（zcode 待发送队列同口径）；提升只给排队行
 * （followUp → steering：下一个工具边界插话）。
 */
function QueueRow({
 mode,
 text,
 onEdit,
 onRemove,
 onPromote,
}: {
 mode: "steer" | "queue";
 text: string;
 onEdit: () => void;
 onRemove: () => void;
 onPromote?: () => void;
}) {
 const t = useText();
 return (
  <li title={text} className="group flex items-center gap-1.5 text-[13px] text-muted">
   {mode === "steer" ? (
    <Timer size={13} className="shrink-0 text-accent" aria-hidden />
   ) : (
    <Hourglass size={13} className="shrink-0 text-accent" aria-hidden />
   )}
   <span className="shrink-0 text-accent">{mode === "steer" ? t.pendingSteer : t.pendingQueue}</span>
   <span className="min-w-0 truncate">{text}</span>
   <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-100 group-hover:opacity-100 focus-within:opacity-100">
    {onPromote && (
     <button
      onClick={onPromote}
      className="cursor-pointer rounded p-0.5 text-faint transition-colors duration-100 hover:bg-hover hover:text-foreground"
      aria-label={t.pendingPromoteAria}
      title={t.pendingPromoteAria}
     >
      <ArrowUp size={12} aria-hidden />
     </button>
    )}
    <button
     onClick={onEdit}
     className="cursor-pointer rounded p-0.5 text-faint transition-colors duration-100 hover:bg-hover hover:text-foreground"
     aria-label={t.pendingEditAria}
     title={t.pendingEditAria}
    >
     <PenLine size={12} aria-hidden />
    </button>
    <button
     onClick={onRemove}
     className="cursor-pointer rounded p-0.5 text-faint transition-colors duration-100 hover:bg-hover hover:text-danger"
     aria-label={t.pendingRemoveAria}
     title={t.pendingRemoveAria}
    >
     <X size={12} aria-hidden />
    </button>
   </span>
  </li>
 );
}
