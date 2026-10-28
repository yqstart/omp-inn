import { create } from "zustand";
import type { BtwRecord, CheckoutView, CommitOutcome, CommitTaskView, HealthInfo, ImageAttachment, ModelCatalog, OmpUpdate, OmpUpdateRun, PendingReference, PlanCardState, ProjectView, PullState, QueuedMessages, RefPickerTarget, SessionRuntime, SessionStatus, SessionView, SubAgentInfo, TodoPhase, UpdateState, ViewMsg, WorkspaceGitState, WorkspaceView } from "@shared/types";
import type { Locale, LocaleMode } from "../lib/locale";
import { loadLocaleMode, resolveLocale, saveLocaleMode, systemLang } from "../lib/locale";
import { applyTheme, loadTheme, saveTheme, type ThemeMode } from "../lib/theme";
import { loadMyModels, saveMyModels } from "../lib/myModels";
import { loadCommitLangPrefs, saveCommitLangPrefs, type CommitLangPref } from "../lib/commitLang";
import { withSlots } from "../lib/attachments";
import { countTodos } from "../lib/todoDisplay";

type AppState = {
 health: HealthInfo | null;
 /** 项目列表（覆盖层；工作区树由 `workspaces` 管）。 */
 projects: ProjectView[];
 /** 模型目录（设置页模型页签用；启动时静默加载一次）。 */
 models: ModelCatalog | null;
 /** 我的模型（本应用偏好，localStorage 持久化；模型选择器的候选范围，空 = 全部；见 src/lib/myModels.ts）。 */
 myModels: string[];
 setMyModels: (list: string[]) => void;
 /** 设置视图是否打开（v1 起：设置是覆盖主区的独立视图，不再是标签；关闭才卸载设置页）。 */
 settingsTabOpen: boolean;
 /** 主区当前显示的是设置视图（聊天视图保持挂载，只切显隐）。 */
 settingsTabActive: boolean;
 /** 设置视图内搜索是否展开（v3：顶部搜索 / ⌘F；关闭设置视图时复位）。 */
 settingsSearchOpen: boolean;
 /** 打开设置视图（已打开则只切过去；搜索复位到折叠态）。 */
 openSettingsTab: () => void;
 /** 关闭设置视图：主区回到聊天视图（搜索一并复位）。 */
 closeSettingsTab: () => void;
 sidebarOpen: boolean;
 update: UpdateState;
 updateDismissedVersion: string | null;
 /** 更新弹窗显隐（入口 = 左栏字标行的应用版本 chip；弹窗可单独关闭=稍后）。 */
 updateDialogOpen: boolean;
 /**
  * omp 运行时更新检查状态（`lib/ompUpdate.ts`；左栏字标行的版本 chip 与详情弹窗用）。
  * 与本应用的 `update` 互不相干：那条走 Tauri updater，这条跑 `omp update --check`。
  */
 ompUpdate: OmpUpdate;
 /** omp 更新详情弹窗显隐（App 常驻挂载，由字标行的版本 chip 打开）。 */
 ompUpdateDialogOpen: boolean;
 /**
  * 正在跑 / 刚跑完的 `omp update`（V24；null = 本次运行还没发起过）。
  * 日志有上限（见 `lib/ompUpdate.ts` 的 `OMP_UPDATE_LOG_MAX`）；终态保留到下次发起，
  * 失败 / 取消可以直接重试。
  */
 ompUpdateRun: OmpUpdateRun | null;
 /**
  * 正在跑 / 刚跑完的 omp **首次安装**（omp 缺失时左栏版本处的「安装 omp」chip；null = 本次运行
  * 还没发起过）。与 `ompUpdateRun` 同构（同一套事件与日志上限），后端两条任务共用一个单槽。
  */
 ompInstallRun: OmpUpdateRun | null;
 /** 「安装 omp」弹窗显隐（App 常驻挂载；由 omp 缺失时的「安装 omp」chip 打开）。 */
 ompInstallDialogOpen: boolean;
 /** 界面语言偏好三档（跟随系统 / 简体中文 / English；只作用于本应用展示，localStorage 持久化）。 */
 localeMode: LocaleMode;
 /** 实际生效的语言（`localeMode` 解析后的结果；字典与 `<html lang>` 用它）。 */
 locale: Locale;
 setLocaleMode: (mode: LocaleMode) => void;
 /** 皮肤（只作用于本应用展示，localStorage 持久化；`system` 跟随系统偏好）。 */
 theme: ThemeMode;
 setTheme: (theme: ThemeMode) => void;
 set: (p: Partial<AppState>) => void;
 /** 左侧栏宽度（292–480，默认 292，持久化 localStorage）。 */
 sidebarWidth: number;
 setSidebarWidth: (w: number) => void;
 /** 右侧工作台面板是否展开（V42 三栏）：**每次启动都收起**（用户 2026-10-19 口径：不恢复上次的展开态，开合只在本次运行内有效）。
  *  面板始终停靠为主区第三栏：打开 = 布局变三栏，会话列让位、不被遮盖。 */
 workbenchOpen: boolean;
 setWorkbenchOpen: (v: boolean) => void;
 /** 工作台当前页签（文件 / Git 图谱 / 脚本 / 终端；localStorage 持久化，重开还是上次那一个）。 */
 workbenchTab: WorkbenchTab;
 setWorkbenchTab: (tab: WorkbenchTab) => void;
 /** 右栏工作台宽度（260–640，默认 320，localStorage 持久化；左缘可拖 / 焦点下 ←→ 微调）。 */
 workbenchWidth: number;
 setWorkbenchWidth: (w: number) => void;
 /**
  * 终端实例表（V42 起、V44 多开）：**同一目录可以开多个终端**，一次只显示 `activeTerminalId`
  * 那个，靠终端页签里的标签行切换。每个终端是一个常驻 shell 进程（上限 `MAX_TERMINALS`，
  * 超了淘汰最旧的**非活跃**项），切会话不会把它们杀掉。运行期状态，不持久化。
  */
 terminals: TerminalInstance[];
 /** 当前显示的终端（null = 还没建过 / 全被关掉）。 */
 activeTerminalId: string | null;
 /** 终端 id 发生器（`t1` / `t2`…，运行期计数，不持久化）。 */
 terminalSeq: number;
 /** 新建一个终端（`title` 缺省 = 目录名；点脚本时传脚本名），返回它的 id 并切到它。 */
 newTerminal: (cwd: string, title?: string) => string;
 /** 关掉一个终端（关的是当前显示的那个时，自动切到列表末尾那个）。 */
 closeTerminal: (id: string) => void;
 setActiveTerminal: (id: string) => void;
 /**
  * 用户自定义脚本（V43，按项目目录分组）：只存**本应用偏好**（localStorage，不写用户仓库）。
  * 后端识别出来的项目脚本不进这里——那是每次进面板重新扫描的只读结果。
  */
 customScripts: Record<string, CustomScript[]>;
 addCustomScript: (cwd: string, name: string, command: string) => void;
 updateCustomScript: (cwd: string, id: string, patch: { name?: string; command?: string }) => void;
 removeCustomScript: (cwd: string, id: string) => void;
 /**
  * 待投递到终端的命令（V43 / V44）：脚本页签点「运行」时落这里，**目标是那一次新开的终端**
  * （`terminalId`），由对应的 `TerminalPane` 在 PTY 建好后写进 PTY（后端等 shell 进入
  * 行编辑器 raw 模式再落字，见 `pty.rs` 的 `shell_ready`）。
  * 运行期状态，不持久化。
  */
 pendingTerminalRun: { terminalId: string; command: string; seq: number } | null;
 /** 待运行命令的序号发生器：区分「同一条」与「又点了一次运行」。 */
 terminalRunSeq: number;
 /**
  * 在指定目录**新开一个终端**并跑一条命令（展开右栏 + 切到终端页签 + 切到新终端）。
  * 「每次点脚本都新开」是用户口径：多开的终端各跑各的脚本，互不打断。
  */
 runInTerminal: (cwd: string, command: string, title?: string) => void;
 /** 消费掉一条待运行命令（`seq` 不符 = 已被更新的命令顶掉，不动）。 */
 clearTerminalRun: (seq: number) => void;

 // ---------- 聊天形态（v1 起唯一形态） ----------

 /**
  * 已知的聊天会话视图（新建 / 打开 / 侧栏扫描 / 归档恢复时补进；顶栏标题与上下文条从这里取）。
  * 不是「全部会话」的镜像——会话列表仍在 `list_sessions`（侧栏按需拉）。
  */
 sessions: SessionView[];
 /** 当前在聊天视图里打开的会话 id。 */
 activeSessionId: string | null;
 /** 会话消息流（ViewMsg 归一；高频流式增量只改这里）。 */
 eventsBySession: Record<string, ViewMsg[]>;
 /** 已加载历史的向前游标和读取状态；随会话历史缓存一并回收。 */
 historyPages: Record<string, { before: number | null; end: number; records: Record<string, ViewMsg>; skipped: boolean; loading: boolean; error: string | null }>;
 /** 会话运行状态（`omp-status://<id>` 事件的落点；左栏状态点 / 通知用）。 */
 statusBySession: Record<string, SessionStatus>;
 /** 输入草稿（按会话隔离，内存态）。 */
 drafts: Record<string, string>;
 /** 待发送图片附件（按会话隔离，只存在内存里，发送成功即清空）。 */
 attachmentsBySession: Record<string, ImageAttachment[]>;
 /** 待发队列真值（V40）：`queue_update` 帧与运行时回读的落点（omp 侧是权威，可撤回 / 提升）。 */
 queuedBySession: Record<string, QueuedMessages>;
 /** 子代理注册表（V41）：`subagent_lifecycle` 帧与打开会话时 `get_subagents` 补拉的落点。 */
 subagentsBySession: Record<string, SubAgentInfo[]>;
 /** 当前会话的模型 selector（`provider/id`；工具行选择器显示与用量入口用）。 */
 currentModel: string | null;
 /** 当前思考档（omp 真值回填；null = 未知）。 */
 currentThinking: string | null;
 /** 当前模型可用思考档（omp 真值；null = 不支持思考）。驱动思考档下拉只列支持项。 */
 currentEfforts: string[] | null;
 /**
  * omp 全局「默认思考等级」（`defaultThinkingLevel`，启动 / 打开思考档菜单时读）：
  * 档位真值不可用（缺档 / 对新模型非法）时显示与兜底就用它（夹到模型支持集）。
  * `null` = 还没读到（配置未设置与读取失败同形，显示层退回最高档）。
  */
 ompDefaultThinking: string | null;
 /** 当前会话的运行时真值快照（上下文占用 / 本轮用量 / 耗时）：状态条纯透传的数据源。 */
 currentRuntime: SessionRuntime | null;
 /**
  * 完成未读标记（v2 左栏状态标）：会话在**后台跑完一轮**、用户还没打开过它。
  * 由左栏列表刷新时对比 running 快照产生（前后台状态真值只有列表里有），打开会话即清。
  * 运行期状态，不持久化（重启后「未读」没有意义）。
  */
 unreadBySession: Record<string, true>;
 markUnread: (sid: string) => void;
 clearUnread: (sid: string) => void;
 /** 任务清单真值（todo 帧 `details.phases` + `get_state.todoPhases` 回读；按会话隔离）。 */
 plansBySession: Record<string, TodoPhase[]>;
 /** 任务清单浮卡的 UI 状态（会话级）：无记录 = 折叠（首次出现默认收起，见 `applyPlans`）。 */
 planCardBySession: Record<string, PlanCardState>;
 /**
  * 被「新回合」收起的完成清单签名（会话级，`JSON.stringify(phases)`）：omp 的 todo
  * 自动清理是它自己 UI 的计时器，`get_state` 在窗口内仍会回读同一份已完成的清单——
  * 不挡掉的话浮卡会在下一次回读时复活（见 `dismissCompletedPlans`）。
  */
 planDismissedBySession: Record<string, string>;
 /** 会话级权限覆盖（覆盖层 `sessionApproval` 的水合；徽标显示用）。 */
 sessionApprovals: Record<string, string>;
 /** 输入卡内的下拉互斥槽：同一时刻只开一个（model/thinking/approval/plus/project/branch/context/usage/liveStats/liveTokens）。 */
 composerMenu:
  | "model"
  | "thinking"
  | "approval"
  | "plus"
  | "project"
  | "branch"
  | "context"
  | "usage"
  /** 卡底统计条的「会话统计」浮层（轮 / 步 / 用时 / 吞吐）。 */
  | "liveStats"
  /** 卡底统计条的「Token 用量」浮层（累计分项）。 */
  | "liveTokens"
  | null;
 /** 消息流「首屏增量」窗口：当前会话已渲染的消息条数（首屏 200 条）。 */
 threadLimitSid: string | null;
 threadLimit: number;
 draftOf: (sid: string | null) => string;
 setDraft: (sid: string | null, text: string) => void;
 /** 把一枚引用芯片插进指定会话的草稿（消费方是 Composer；见 `PendingReference`）。 */
 insertDraftReference: (sid: string | null, ref: { path: string; label: string; isDir: boolean }) => void;
 /** 将消息引用块追加到指定会话草稿。 */
 insertDraftQuote: (sid: string | null, text: string) => void;
 selectPendingReference: (sid: string | null) => void;
 clearPendingReference: (seq?: number) => void;
 attachmentsOf: (sid: string | null) => ImageAttachment[];
 /** 附件入库唯一入口：分配稳定编号（`slot`）并返回并入的那批（带编号，供调用方补 `#N` 占位）。 */
 addAttachments: (sid: string | null, items: ImageAttachment[]) => ImageAttachment[];
 removeAttachment: (sid: string | null, index: number) => void;
 clearAttachments: (sid: string | null) => void;
 queuedOf: (sid: string | null) => QueuedMessages;
 /** 队列快照写入（`queue_update` 帧 / 运行时回读的唯一入口）。 */
 applyQueue: (sid: string, q: QueuedMessages) => void;
 /** 任务清单写入（唯一入口）：`details.phases` 帧 / `get_state` 回读；空数组 = 已清空（浮卡退场）。 */
 applyPlans: (sid: string, phases: TodoPhase[]) => void;
 /** 任务清单浮卡开合 / 隐藏（会话级）。 */
 setPlanCard: (sid: string, state: PlanCardState) => void;
 /**
  * 新回合开始（发送成功）时把**上一轮已全部完成**的清单收起：清数据 + 浮卡状态，并记下
  * 这份清单的签名挡掉 omp 在自动清理窗口内的回读。未完成 / 无清单时什么都不做。
  */
 dismissCompletedPlans: (sid: string) => void;
 subagentsOf: (sid: string | null) => SubAgentInfo[];
 /** upsert 一个子代理（生命周期帧；按 id 覆盖全量字段）。 */
 upsertSubagent: (sid: string, info: SubAgentInfo) => void;
 /** 整表替换（打开会话时的 `get_subagents` 补拉；不动已有 running 条目——注册表可能滞后于帧）。 */
 setSubagents: (sid: string, list: SubAgentInfo[]) => void;
 /** 会话导航（⌘[ / ⌘]，V40）：打开过的会话顺序栈（新的在后，上限 50）。 */
 navStack: string[];
 /** 栈内当前位置（-1 = 空）。 */
 navIdx: number;
 /** 打开会话时压栈；返回导航目标（`navStep`）由调用方打开。 */
 pushNav: (sid: string) => void;
 /** 前后一步（-1 后退 / +1 前进）；返回目标会话 id（没有则 null，调用方不动）。 */
 navStep: (dir: -1 | 1) => string | null;
 /** 执行模式切换的挂起重启标记（V40）：running 时切档挂标记，idle 收敛后自动重启生效。 */
 approvalRestartBySession: Record<string, true>;
 markApprovalRestart: (sid: string) => void;
 clearApprovalRestart: (sid: string) => void;
 /** 旁问面板状态（V40；`/btw` 与划选「旁问」的落点）。 */
 btw: BtwPanelState;
 setBtw: (p: Partial<BtwPanelState>) => void;
 /** 消息流查找条显隐（⌘F，V40）。 */
 findOpen: boolean;
 setFindOpen: (v: boolean) => void;
 /** 查找条查询串（V40）：放 store 统一「关闭即清 / 切会话自然隔离」（组件本地态会被 lint 的级联渲染规则挡住）。 */
 findQuery: string;
 /** 查询串所属会话（切会话后旧查询不生效——FindBar 按 `findQuerySid === activeSessionId` 取）。 */
 findQuerySid: string | null;
 setFindQuery: (q: string) => void;
 /**
  * omp 的全局执行模式档（`tools.approvalMode`；新会话的档位）。
  * `null` = 还没读到真值——**不许拿某一档兜底**（兜底就是「显示的和 omp 实际用的不一致」，
  * 2026-10-14 修掉的老毛病）：显示层按「未知」渲染，读取见 `lib/sessionApproval.ts`。
  */
 globalApproval: string | null;
 setGlobalApproval: (mode: string) => void;
 /** 会话统计弹窗显隐（`/status` 入口；V40）。 */
 statsOpen: boolean;
 setStatsOpen: (v: boolean) => void;
 /** 文件改动弹窗的目标路径（工具卡「查看改动」按钮；null = 关闭；V40）。 */
 diffPath: string | null;
 setDiffPath: (path: string | null) => void;
 /** 新建会话（左栏主命令 / ⌘T）的最新失败文案：两处入口共用左栏内联错误条这一个渲染面，
  *  免得「点了没反应」（`null` = 无提示；成功或用户关掉即清）。 */
 newChatError: string | null;
 setNewChatError: (message: string | null) => void;
 appendEvents: (sid: string, msgs: ViewMsg[]) => void;
 /** 展开更早的消息（按页递增）；打开新会话时由 openSessionWithHistory 重置。 */
 growThreadLimit: (by: number) => void;
 resetThreadLimit: (sid: string) => void;

 // ---------- 工作区容器与引用浮层（见 lib/workspaceGroups.ts / lib/checkouts.ts） ----------

 /** 工作区清单（V21 多项目容器；`lib/checkouts.ts` 的 `loadCheckouts` 是唯一刷新入口，与目录行一起拉）。 */
 workspaceGroups: WorkspaceView[];
 /** 目录行清单（项目主目录 + git worktree；同上，唯一刷新入口）。 */
 checkouts: CheckoutView[];
 /** 「供应商用量」弹窗是否打开（V15；入口 = 聊天顶栏右端的 `Gauge` 键，只在打开时挂载）。 */
 providerUsageOpen: boolean;
 /** 引用工作区文件浮层（V22）的目标（null = 关闭；只在打开时挂载）：
  *  注入目标 = 该会话的 Composer 草稿（追加 `@<绝对路径> `，焦点随后交还输入框）。 */
 refPickerTarget: RefPickerTarget | null;
 /** Composer 聚焦序号：引用浮层注入草稿后 +1，让输入框拿回焦点接着写。 */
 composerFocusSeq: number;
 /**
  * 待插入的引用（右栏文件树 / 引用浮层 / 消息列 → Composer）：
  * 草稿编辑器是非受控的（Lexical 状态是权威），所以引用不能靠改草稿文本来插入——
  * 外部只经这一通道投递；按会话保序，Composer 消费后推进队列。
  */
 pendingReference: PendingReference | null;
 pendingReferenceQueue: PendingReference[];
 pendingReferenceSeq: number;
 /**
  * git 信息刷新信号（全局自增）：**唯一写入面**是 `lib/commitTasks.ts` 的
  * `refreshWorkspaceGitState`（git 状态的统一刷新入口：启动 / 焦点 / 30s 轮询 /
  * π 就绪 / 任务结束 / 分支切换），每次刷新自增一次。
  * `useGitInfo` 订阅它——输入卡顶行与右栏「变更」各自持有一份查询，靠它一起重读。
  */
 gitInfoSeq: number;

 // ---------- V14 工作区「提交并推送」（omp commit 集成，见 lib/commitTasks.ts） ----------

 /**
  * 工作区 git 快照（行徽章）：有改动小点 / 待推送 `BranchUp` / 非仓库降级。
  * 刷新时机（启动 / 任务结束 / 窗口可见或获得焦点 / 30s 兜底轮询）在 `App`
  * 与 `lib/commitTasks.ts`；面板里的变更集与提交前的暂存复查才是最终裁决。
  */
 workspaceGitStates: Record<string, WorkspaceGitState>;
 setWorkspaceGitStates: (states: WorkspaceGitState[]) => void;
 /**
  * 拉取远程的运行态（按 cwd，见 `lib/pull.ts`）：running = 徽章转圈；conflict = 停在合并态
  * （徽章转成冲突色 + 弹冲突清单）；error = 上次失败（徽章转成警告色，悬停看错误原文）。
  */
 pullStates: Record<string, PullState>;
 setPullState: (cwd: string, state: PullState) => void;
 clearPullState: (cwd: string) => void;
 /** 冲突清单浮层当前查看的工作区（null = 关着；合并态本身不受影响，Esc 只收起浮层）。 */
 pullConflictCwd: string | null;
 setPullConflictCwd: (cwd: string | null) => void;
 /**
  * 提交任务（按 cwd 存）：运行中关闭浮层 = 转后台（任务继续，行徽章指示）；
  * 失败任务保留到「重试 / 新任务 / 用户清除」，成功任务在关闭浮层时清除（git 快照接管）。
  */
 commitTasks: Record<string, CommitTaskView>;
 /** 浮层当前查看的任务（cwd）；null = 浮层关着（任务本身不受影响）。 */
 activeCommitCwd: string | null;
 setCommitTask: (task: CommitTaskView) => void;
 patchCommitTask: (cwd: string, patch: Partial<CommitTaskView>) => void;
 appendCommitLog: (cwd: string, line: string) => void;
 /** 追加生成流（快速轨的模型输出直接进编辑框；有上限，防异常输出撑爆 store）。 */
 appendCommitMessage: (cwd: string, text: string) => void;
 finishCommitTask: (cwd: string, outcome: CommitOutcome) => void;
 /** 清除任务记录（浮层关闭时对非运行中的任务调用；见 `lib/commitTasks.ts` 的 `closeCommitPanel`）。 */
 dropCommitTask: (cwd: string) => void;
 setActiveCommitCwd: (cwd: string | null) => void;
 /**
  * 提交信息语言偏好（**按项目 id**，V14 增补）：同一项目的主目录与全部 worktree 共用，
  * 项目之间互不影响。「记住选择」= `remembered`（已写 localStorage），未记住的只在本次
  * 运行期间生效。任务发起时由 `lib/commitTasks.ts` 解析成给模型的要求文本（快速轨进提示词、
  * 完整轨走 `omp commit --context=`，见 `src/lib/commitLang.ts`）。
  */
 commitLangPrefs: Record<string, CommitLangPref>;
 setCommitLangPref: (projectId: string, pref: CommitLangPref) => void;
};

/**
 * 侧栏宽度下限由左栏底部那一行的**内容**决定：设置按钮（图标 + 全称）+ 语言切换 + 皮肤切换
 * 并排不挤压所需的最小宽度（最宽文案按英文界面算，`Settings` 比「设置」长）。比这更窄，
 * 设置按钮的文案就会开始 `truncate`——那不该是「用户可以拖到的状态」。
 *
 * 实测（真实渲染）：英文界面下这一行需要 287px，即侧栏 288px 是临界；这里留 4px 给
 * 字体渲染差异（换平台 / 换字体时 `Settings` 会宽一点点）。
 */
export const SIDEBAR_MIN = 292;
export const SIDEBAR_MAX = 480;
/** 默认宽度 = 下限：默认就取「底部行刚好完整」的宽度，内容区拿到最多的横向空间。 */
export const SIDEBAR_DEFAULT = SIDEBAR_MIN;

/** 提交任务日志行数上限（保尾）：异常输出不撑爆 store；与后端的错误摘要上限（TAIL_MAX）不是一回事。 */
const COMMIT_LOG_MAX = 1000;
/** 生成流的字符上限（保尾）：模型跑飞时的兜底；后端解析结果本身也有 4000 字符上限。 */
const COMMIT_MSG_MAX = 8000;

/** 启动时的语言偏好（模块加载时读一次，供 store 初始化解析出实际语言）。 */
const INITIAL_LOCALE_MODE = loadLocaleMode();
/** 消息流单页条数：首屏只渲染最后 200 条，其余按需向上加载（MASTER §7）。 */
export const THREAD_PAGE = 200;

/**
 * 旁问面板状态（V40，`/btw` 与划选「旁问」的落点）。
 * 面板是单会话单通道：omp 每个会话同一时刻只跑一个旁问（运行中不允许再开）。
 */
export type BtwPanelState = {
 open: boolean;
 sessionId: string | null;
 /** 话题记录（最新在前；omp `get_btw_history` 口径；运行中的记录带部分答案）。 */
 records: BtwRecord[];
 /** 正在流式作答的记录 id（该条显示为运行中 + 取消按钮）。 */
 busyRecordId: string | null;
 /** 输入框草稿（放 store：划选「旁问」的预填与新打开面板都直接写它，组件无本地拷贝）。 */
 draft: string;
 /** 最近一次提问失败信息（成功提问 / 关闭面板时清）。 */
 error: string | null;
};

const BTW_CLOSED: BtwPanelState = { open: false, sessionId: null, records: [], busyRecordId: null, draft: "", error: null };
export const EMPTY_QUEUE: QueuedMessages = { steering: [], followUp: [] };
/** 无子代理时的稳定空引用（选择器返回同引用，避免无谓重渲染）。 */
export const EMPTY_SUBAGENTS: SubAgentInfo[] = [];
/** 形态概念随 v1 退场（聊天是唯一形态）：启动时清掉旧的 localStorage 键。 */
try {
 localStorage.removeItem("omp.appMode.v1");
} catch {
 // 无痕模式等取不到持久化：无须清理
}

function loadSidebarWidth(): number {
 try {
  if (typeof localStorage === "undefined") return SIDEBAR_DEFAULT;
  const v = Number(localStorage.getItem("omp.sidebarWidth"));
  if (!Number.isFinite(v)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, v));
 } catch {
  // 无痕模式等取不到持久化时回默认宽度
  return SIDEBAR_DEFAULT;
 }
}

/** 右栏工作台的四个页签（V42 / V43 / V51）：文件目录树 / Git 图谱 / 项目脚本 / 终端。 */
export type WorkbenchTab = "files" | "graph" | "scripts" | "terminal";

/** 用户自定义脚本（V43，按项目目录分组存本应用偏好）。 */
export interface CustomScript {
 id: string;
 name: string;
 command: string;
}

/** 一个终端实例（V44 多开）：`id` 是后端 PTY 进程表里的寻址键，`title` 只用于标签显示。 */
export interface TerminalInstance {
 id: string;
 /** 创建时的工作目录（终端不随会话切换改目录）。 */
 cwd: string;
 /** 标签显示名（点脚本开的是脚本名，手动开的是目录名）。 */
 title: string;
}

/** 自定义脚本的 id（本地生成，不要求跨设备稳定——只在本应用偏好里做行标识）。 */
function newScriptId(): string {
 return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 自定义脚本的初始值（`omp.scripts.v1`，按项目目录分组）。
 *
 * 存本应用偏好而不是写进用户仓库：脚本清单常常是「本机习惯」（用哪个包管理器、跑哪条本地命令），
 * 往仓库里塞文件会污染提交；要团队共享的话用户自己写进 package.json / Makefile —— 那正好会被
 * 后端的项目脚本识别读到。
 */
function loadCustomScripts(): Record<string, CustomScript[]> {
 try {
  if (typeof localStorage === "undefined") return {};
  const raw = localStorage.getItem("omp.scripts.v1");
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null) return {};
  const out: Record<string, CustomScript[]> = {};
  for (const [cwd, list] of Object.entries(parsed as Record<string, unknown>)) {
   if (!Array.isArray(list)) continue;
   const items: CustomScript[] = [];
   for (const item of list) {
    const it = item as Partial<CustomScript>;
    if (typeof it?.name === "string" && typeof it?.command === "string") {
     items.push({ id: typeof it.id === "string" ? it.id : newScriptId(), name: it.name, command: it.command });
    }
   }
   if (items.length > 0) out[cwd] = items;
  }
  return out;
 } catch {
  // 解析失败丢弃旧偏好不好，不阻断启动
  return {};
 }
}

/** 写回自定义脚本偏好（失败不阻断本次编辑）。 */
function saveCustomScripts(map: Record<string, CustomScript[]>): void {
 try {
  localStorage.setItem("omp.scripts.v1", JSON.stringify(map));
 } catch {
  // 持久化失败（配额 / 无痕）只影响下次启动
 }
}

/**
 * 右栏工作台宽度（V42）：可拖 260–640，默认 320（= `index.css` 的 `--w-panel`）。
 *
 * 下限由终端定：xterm 12px 等宽字在 260px 里约 34 列，再窄看不了常规命令输出；
 * 上限由中列定：消息列还要放得下正文（`--measure-content` = 85%）与输入卡，640px 之后
 * 扩宽只服务文件树长路径，收益不再抵得上挤压会话列。拖拽时另有「给中列留 420px」的
 * 窗口约束（见 `WorkbenchPanel` 的 `maxWidthNow`），所以实际可达上限可能更小。
 */
export const WORKBENCH_MIN = 260;
export const WORKBENCH_MAX = 640;
export const WORKBENCH_DEFAULT = 320;

/**
 * 同时保留的终端数（多开上限）：每个终端是一个常驻 shell 进程——比 omp 会话轻得多，
 * 但也没必要无限攒；超上限时淘汰最旧的**非活跃**终端（正在看的那个不许被顶掉）。
 */
const MAX_TERMINALS = 6;

/** 目录尾名（`/a/b/proj/` → `proj`）：终端标签的默认标题。 */
function dirName(path: string): string {
 const trimmed = path.replace(/\/+$/, "");
 return trimmed.split("/").pop() || trimmed || "终端";
}

/** 工作台页签的初始值（默认「文件」）。 */
function loadWorkbenchTab(): WorkbenchTab {
 try {
  if (typeof localStorage === "undefined") return "files";
  const raw = localStorage.getItem("omp.workbenchTab.v1");
  return raw === "terminal" || raw === "scripts" || raw === "graph" ? raw : "files";
 } catch {
  return "files";
 }
}

/** 右栏宽度的初始值（`omp.workbenchWidth`；越界值夹回范围、坏值回默认）。 */
function loadWorkbenchWidth(): number {
 try {
  if (typeof localStorage === "undefined") return WORKBENCH_DEFAULT;
  const raw = localStorage.getItem("omp.workbenchWidth");
  // 缺键（首次启动）回默认：`Number(null)` 是 0，不先判 null 会被夹成下限 260
  if (raw === null) return WORKBENCH_DEFAULT;
  const v = Number(raw);
  if (!Number.isFinite(v)) return WORKBENCH_DEFAULT;
  return Math.min(WORKBENCH_MAX, Math.max(WORKBENCH_MIN, v));
 } catch {
  return WORKBENCH_DEFAULT;
 }
}

/** 新引用入队；当前会话的请求优先消费，各会话内部保持投递顺序。 */
function enqueueReference(s: AppState, item: PendingReference): Partial<AppState> {
 if (!s.pendingReference) return { pendingReferenceSeq: item.seq, pendingReference: item };
 const queue = [...s.pendingReferenceQueue, item];
 if (item.sessionId === s.activeSessionId && s.pendingReference.sessionId !== item.sessionId) {
  const index = queue.findIndex((entry) => entry.sessionId === item.sessionId);
  const next = queue.splice(index, 1)[0];
  queue.unshift(s.pendingReference);
  return { pendingReferenceSeq: item.seq, pendingReference: next, pendingReferenceQueue: queue };
 }
 return { pendingReferenceSeq: item.seq, pendingReferenceQueue: queue };
}

export const useApp = create<AppState>((set, get) => ({
 health: null,
 projects: [],
 models: null,
 myModels: loadMyModels(),
 setMyModels: (list) => {
  saveMyModels(list);
  set({ myModels: list });
 },
 settingsTabOpen: false,
 settingsTabActive: false,
 settingsSearchOpen: false,
 openSettingsTab: () => set({ settingsTabOpen: true, settingsTabActive: true, settingsSearchOpen: false }),
 closeSettingsTab: () => set({ settingsTabOpen: false, settingsTabActive: false, settingsSearchOpen: false }),
 sidebarOpen: false,
 update: { status: "idle" },
 updateDismissedVersion: null,
 updateDialogOpen: false,
 ompUpdate: { status: "idle", current: null, latest: null, channel: null, message: null, checkedAt: null },
 ompUpdateDialogOpen: false,
 ompUpdateRun: null,
 ompInstallRun: null,
 ompInstallDialogOpen: false,
 localeMode: INITIAL_LOCALE_MODE,
 locale: resolveLocale(INITIAL_LOCALE_MODE, systemLang()),
 setLocaleMode: (mode) => {
  saveLocaleMode(mode);
  const locale = resolveLocale(mode, systemLang());
  try {
   document.documentElement.lang = locale;
  } catch {
   // 非 DOM 环境（单测）忽略
  }
  set({ localeMode: mode, locale });
 },
 theme: loadTheme(),
 setTheme: (theme) => {
  saveTheme(theme);
  // 同步落 class：useEffect 在 paint 之后跑，只靠它会让切皮肤先闪一帧旧皮肤
  applyTheme(theme);
  set({ theme });
 },
 set: (p) => set(p),
 sidebarWidth: loadSidebarWidth(),
 setSidebarWidth: (w) => {
  const v = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)));
  try {
   localStorage.setItem("omp.sidebarWidth", String(v));
  } catch {
   // 持久化失败不阻断本次拖拽
  }
  set({ sidebarWidth: v });
 },
 workbenchOpen: false,
 setWorkbenchOpen: (v) => {
  // 开合不持久化：每次启动都从收起开始（旧键 `omp.workbench.v1` 已作废、不再读写）
  set({ workbenchOpen: v });
 },
 workbenchTab: loadWorkbenchTab(),
 setWorkbenchTab: (tab) => {
  try {
   localStorage.setItem("omp.workbenchTab.v1", tab);
  } catch {
   // 持久化失败不阻断本次切换
  }
  set({ workbenchTab: tab });
 },
 workbenchWidth: loadWorkbenchWidth(),
 setWorkbenchWidth: (w) => {
  const v = Math.min(WORKBENCH_MAX, Math.max(WORKBENCH_MIN, Math.round(w)));
  try {
   localStorage.setItem("omp.workbenchWidth", String(v));
  } catch {
   // 持久化失败不阻断本次拖拽
  }
  set({ workbenchWidth: v });
 },
 terminals: [],
 activeTerminalId: null,
 terminalSeq: 0,
 newTerminal: (cwd, title) => {
  const s = get();
  const seq = s.terminalSeq + 1;
  const term: TerminalInstance = { id: `t${seq}`, cwd, title: title?.trim() || dirName(cwd) };
  let list = [...s.terminals, term];
  // 超上限：淘汰最旧的**非活跃**终端（正在看的那个不许被顶掉；淘汰 = 组件卸载 = kill 进程）
  if (list.length > MAX_TERMINALS) {
   const victim = list.find((t) => t.id !== s.activeTerminalId && t.id !== term.id);
   if (victim) list = list.filter((t) => t.id !== victim.id);
  }
  set({ terminals: list, activeTerminalId: term.id, terminalSeq: seq });
  return term.id;
 },
 closeTerminal: (id) =>
  set((s) => {
   const list = s.terminals.filter((t) => t.id !== id);
   if (list.length === s.terminals.length) return s;
   // 关掉的是当前显示的那个 → 切到列表末尾（最近开的）那个；否则看作息不变
   const active = s.activeTerminalId === id ? (list[list.length - 1]?.id ?? null) : s.activeTerminalId;
   return { terminals: list, activeTerminalId: active };
  }),
 setActiveTerminal: (id) => set({ activeTerminalId: id }),
 customScripts: loadCustomScripts(),
 addCustomScript: (cwd, name, command) => {
  const s = get();
  const list = s.customScripts[cwd] ?? [];
  const next = { ...s.customScripts, [cwd]: [...list, { id: newScriptId(), name, command }] };
  saveCustomScripts(next);
  set({ customScripts: next });
 },
 updateCustomScript: (cwd, id, patch) => {
  const s = get();
  const list = s.customScripts[cwd];
  if (!list) return;
  const next = { ...s.customScripts, [cwd]: list.map((it) => (it.id === id ? { ...it, ...patch } : it)) };
  saveCustomScripts(next);
  set({ customScripts: next });
 },
 removeCustomScript: (cwd, id) => {
  const s = get();
  const list = s.customScripts[cwd];
  if (!list) return;
  const kept = list.filter((it) => it.id !== id);
  const next = { ...s.customScripts };
  // 空数组不留键：`customScripts` 里没有这个 cwd = 没有自定义脚本（前端判空只有一条口径）
  if (kept.length > 0) next[cwd] = kept;
  else delete next[cwd];
  saveCustomScripts(next);
  set({ customScripts: next });
 },
 pendingTerminalRun: null,
 terminalRunSeq: 0,
 runInTerminal: (cwd, command, title) => {
  const s = get();
  // 脚本在终端里跑：先把右栏与终端页签摆到用户眼前，再**新开一个终端**放它
  // （多开口径：连点几条脚本就是几个终端，各跑各的、互不打断）
  s.setWorkbenchOpen(true);
  s.setWorkbenchTab("terminal");
  const terminalId = s.newTerminal(cwd, title);
  const seq = s.terminalRunSeq + 1;
  set({ pendingTerminalRun: { terminalId, command, seq }, terminalRunSeq: seq });
 },
 clearTerminalRun: (seq) =>
  set((s) => (s.pendingTerminalRun?.seq === seq ? { pendingTerminalRun: null } : s)),

 // ---------- 聊天形态（v1 起唯一形态） ----------

 sessions: [],
 activeSessionId: null,
 eventsBySession: {},
 historyPages: {},
 statusBySession: {},
 drafts: {},
 attachmentsBySession: {},
 queuedBySession: {},
 subagentsBySession: {},
 navStack: [],
 navIdx: -1,
 approvalRestartBySession: {},
 btw: BTW_CLOSED,
 findOpen: false,
 findQuery: "",
 findQuerySid: null,
 globalApproval: null,
 statsOpen: false,
 diffPath: null,
 newChatError: null,
 currentModel: null,
 currentThinking: null,
 currentEfforts: null,
 ompDefaultThinking: null,
 currentRuntime: null,
 unreadBySession: {},
 markUnread: (sid) =>
  set((s) => (s.unreadBySession[sid] ? {} : { unreadBySession: { ...s.unreadBySession, [sid]: true } })),
 clearUnread: (sid) =>
  set((s) => {
   if (!s.unreadBySession[sid]) return {};
   const next = { ...s.unreadBySession };
   delete next[sid];
   return { unreadBySession: next };
  }),
 plansBySession: {},
 planCardBySession: {},
 planDismissedBySession: {},
 sessionApprovals: {},
 composerMenu: null,
 threadLimitSid: null,
 threadLimit: THREAD_PAGE,
 draftOf: (sid) => (sid ? get().drafts[sid] ?? "" : ""),
 setDraft: (sid, text) =>
  set((s) => (sid ? { drafts: { ...s.drafts, [sid]: text } } : {})),
 /** 投递一次「把引用插进草稿」的请求（Composer 消费后清空；`seq` 让重复内容也能触发）。 */
 insertDraftReference: (sid, ref) => {
  if (!sid) return;
  set((s) => {
   const seq = s.pendingReferenceSeq + 1;
   const item: PendingReference = { sessionId: sid, ...ref, seq };
   return enqueueReference(s, item);
  });
 },
 insertDraftQuote: (sid, text) => {
  if (!sid) return;
  set((s) => {
   const seq = s.pendingReferenceSeq + 1;
   const item: PendingReference = { sessionId: sid, kind: "quote", text, seq };
   return enqueueReference(s, item);
  });
 },
 selectPendingReference: (sid) => set((s) => {
  if (!sid || !s.pendingReference || s.pendingReference.sessionId === sid) return s;
  const index = s.pendingReferenceQueue.findIndex((item) => item.sessionId === sid);
  if (index < 0) return s;
  const next = s.pendingReferenceQueue[index];
  const queue = [...s.pendingReferenceQueue];
  queue.splice(index, 1);
  queue.unshift(s.pendingReference);
  return { pendingReference: next, pendingReferenceQueue: queue };
 }),
 clearPendingReference: (seq) => set((s) => {
  if (!s.pendingReference || (seq !== undefined && s.pendingReference.seq !== seq)) return s;
  const queue = [...s.pendingReferenceQueue];
  const active = queue.findIndex((item) => item.sessionId === s.activeSessionId);
  const index = active >= 0 ? active : 0;
  const next = queue.splice(index, 1)[0] ?? null;
  return { pendingReference: next, pendingReferenceQueue: queue };
 }),
 attachmentsOf: (sid) => (sid ? get().attachmentsBySession[sid] ?? [] : []),
 addAttachments: (sid, items) => {
  if (!sid || items.length === 0) return [];
  let assigned: ImageAttachment[] = [];
  set((s) => {
   const cur = s.attachmentsBySession[sid] ?? [];
   // 稳定编号在这里唯一分配（删除不重排、清空后从 1 重开）；`#N` 占位与缩略图角标同源
   assigned = withSlots(cur, items);
   return { attachmentsBySession: { ...s.attachmentsBySession, [sid]: [...cur, ...assigned] } };
  });
  return assigned;
 },
 removeAttachment: (sid, index) =>
  set((s) => {
   if (!sid) return {};
   const cur = s.attachmentsBySession[sid] ?? [];
   return { attachmentsBySession: { ...s.attachmentsBySession, [sid]: cur.filter((_, i) => i !== index) } };
  }),
 clearAttachments: (sid) =>
  set((s) => (sid ? { attachmentsBySession: { ...s.attachmentsBySession, [sid]: [] } } : {})),
 queuedOf: (sid) => (sid ? get().queuedBySession[sid] ?? EMPTY_QUEUE : EMPTY_QUEUE),
 applyQueue: (sid, q) => set((s) => ({ queuedBySession: { ...s.queuedBySession, [sid]: q } })),
 applyPlans: (sid, phases) =>
  set((s) => {
   const sig = JSON.stringify(phases);
   if (phases.length === 0) {
    // 清单已清空（回读 `[]` / `todo_auto_clear` 帧）：数据 / 浮卡状态 / 收起签名一起删，
    // 下一个计划出现重新走「首次默认收起」。
    if (!(sid in s.plansBySession) && !(sid in s.planCardBySession) && !(sid in s.planDismissedBySession)) return {};
    const plans = { ...s.plansBySession };
    const cards = { ...s.planCardBySession };
    const dismissed = { ...s.planDismissedBySession };
    delete plans[sid];
    delete cards[sid];
    delete dismissed[sid];
    return { plansBySession: plans, planCardBySession: cards, planDismissedBySession: dismissed };
   }
   // 新回合已把这份完成清单收起：omp 的 todo 自动清理是它自己 UI 的计时器，
   // `get_state` 在窗口内仍会回读同一份清单——挡掉，否则浮卡会「复活」
   if (s.planDismissedBySession[sid] === sig) return {};
   // 换了一份清单：旧的收起签名作废（否则以后同签名的清单会被误挡）
   let dismissed: Record<string, string> | null = null;
   if (sid in s.planDismissedBySession) {
    dismissed = { ...s.planDismissedBySession };
    delete dismissed[sid];
   }
   // 值没变不写（todo 工具帧与 `get_state` 回读会把同一份清单送两遍）
   if (JSON.stringify(s.plansBySession[sid]) === sig) {
    return dismissed ? { planDismissedBySession: dismissed } : {};
   }
   return {
    plansBySession: { ...s.plansBySession, [sid]: phases },
    // 首次出现（无浮卡记录）：默认**收起**（2026-10-21 用户口径——任务刚建好时清单
    // 铺满消息列太吵，先只留头部行的统计）；用户之后的展开 / 收起不被清单更新覆盖
    ...(s.planCardBySession[sid]
     ? {}
     : { planCardBySession: { ...s.planCardBySession, [sid]: "collapsed" as PlanCardState } }),
    ...(dismissed ? { planDismissedBySession: dismissed } : {}),
   };
  }),
 dismissCompletedPlans: (sid) =>
  set((s) => {
   const phases = s.plansBySession[sid];
   if (!phases || phases.length === 0) return {};
   const counts = countTodos(phases);
   // 只收「全部完成」的清单：未完成的任务仍在 omp 的任务状态里，浮卡是它唯一的展示面
   if (counts.total === 0 || counts.done !== counts.total) return {};
   const plans = { ...s.plansBySession };
   const cards = { ...s.planCardBySession };
   delete plans[sid];
   delete cards[sid];
   return {
    plansBySession: plans,
    planCardBySession: cards,
    // 记下被收起清单的签名（见 `applyPlans` 的挡回读分支）
    planDismissedBySession: { ...s.planDismissedBySession, [sid]: JSON.stringify(phases) },
   };
  }),
 setPlanCard: (sid, state) =>
  set((s) =>
   s.planCardBySession[sid] === state ? {} : { planCardBySession: { ...s.planCardBySession, [sid]: state } },
  ),
 subagentsOf: (sid) => (sid ? get().subagentsBySession[sid] ?? EMPTY_SUBAGENTS : EMPTY_SUBAGENTS),
 upsertSubagent: (sid, info) =>
  set((s) => {
   const cur = s.subagentsBySession[sid] ?? [];
   const idx = cur.findIndex((x) => x.id === info.id);
   const next = idx >= 0 ? cur.map((x) => (x.id === info.id ? info : x)) : [...cur, info];
   return { subagentsBySession: { ...s.subagentsBySession, [sid]: next } };
  }),
 setSubagents: (sid, list) =>
  set((s) => {
   const cur = s.subagentsBySession[sid] ?? [];
   // 合并口径：以补拉为准，但保留补拉里没有的 running 条目（帧比注册表快是常态）
   const byId = new Map(list.map((x) => [x.id, x]));
   const next = [...list.map((x) => byId.get(x.id) ?? x)];
   for (const x of cur) {
    if (x.status === "running" && !byId.has(x.id)) next.push(x);
   }
   return { subagentsBySession: { ...s.subagentsBySession, [sid]: next } };
  }),
 pushNav: (sid) => {
  if (!sid) return;
  const { navStack, navIdx } = get();
  if (navIdx >= 0 && navStack[navIdx] === sid) return;
  const trimmed = navIdx >= 0 ? navStack.slice(0, navIdx + 1) : [];
  const next = [...trimmed.filter((x) => x !== sid), sid].slice(-50);
  set({ navStack: next, navIdx: next.length - 1 });
 },
 navStep: (dir) => {
  const { navStack, navIdx } = get();
  const next = navIdx + dir;
  if (next < 0 || next >= navStack.length) return null;
  set({ navIdx: next });
  return navStack[next];
 },
 markApprovalRestart: (sid) => set((s) => ({ approvalRestartBySession: { ...s.approvalRestartBySession, [sid]: true } })),
 clearApprovalRestart: (sid) =>
  set((s) => {
   if (!(sid in s.approvalRestartBySession)) return {};
   const next = { ...s.approvalRestartBySession };
   delete next[sid];
   return { approvalRestartBySession: next };
  }),
 setBtw: (p) => set((s) => ({ btw: { ...s.btw, ...p } })),
 setFindOpen: (v) => set(v ? { findOpen: true } : { findOpen: false, findQuery: "", findQuerySid: null }),
 setFindQuery: (q) => set((s) => ({ findQuery: q, findQuerySid: s.activeSessionId })),
 setGlobalApproval: (mode) => set({ globalApproval: mode }),
 setStatsOpen: (v) => set({ statsOpen: v }),
 setDiffPath: (path) => set({ diffPath: path }),
 setNewChatError: (message) => set({ newChatError: message }),
 appendEvents: (sid, msgs) =>
  set((s) => ({ eventsBySession: { ...s.eventsBySession, [sid]: [...(s.eventsBySession[sid] ?? []), ...msgs] } })),
 growThreadLimit: (by) => set((s) => ({ threadLimit: s.threadLimit + by })),
 resetThreadLimit: (sid) => set({ threadLimitSid: sid, threadLimit: THREAD_PAGE }),

 // ---------- 工作区容器与引用浮层 ----------

 workspaceGroups: [],
 checkouts: [],
 providerUsageOpen: false,
 refPickerTarget: null,
 composerFocusSeq: 0,
 pendingReference: null,
 pendingReferenceQueue: [],
 pendingReferenceSeq: 0,
 gitInfoSeq: 0,

 // ---------- V19 工作区提交 / 推送（见 lib/commitTasks.ts） ----------

 workspaceGitStates: {},
 setWorkspaceGitStates: (states) =>
  set((s) => {
   const next = { ...s.workspaceGitStates };
   for (const st of states) next[st.path] = st;
   return { workspaceGitStates: next };
  }),
 pullStates: {},
 setPullState: (cwd, state) => set((s) => ({ pullStates: { ...s.pullStates, [cwd]: state } })),
 clearPullState: (cwd) =>
  set((s) => {
   if (!(cwd in s.pullStates)) return {};
   const next = { ...s.pullStates };
   delete next[cwd];
   return { pullStates: next };
  }),
 pullConflictCwd: null,
 setPullConflictCwd: (cwd) => set({ pullConflictCwd: cwd }),
 commitTasks: {},
 activeCommitCwd: null,
 setCommitTask: (task) => set((s) => ({ commitTasks: { ...s.commitTasks, [task.cwd]: task } })),
 patchCommitTask: (cwd, patch) =>
  set((s) => {
   const t = s.commitTasks[cwd];
   if (!t) return {};
   return { commitTasks: { ...s.commitTasks, [cwd]: { ...t, ...patch } } };
  }),
 appendCommitLog: (cwd, line) =>
  set((s) => {
   const t = s.commitTasks[cwd];
   if (!t) return {};
   const log =
    t.log.length >= COMMIT_LOG_MAX
     ? [...t.log.slice(t.log.length - COMMIT_LOG_MAX + 1), line]
     : [...t.log, line];
   return { commitTasks: { ...s.commitTasks, [cwd]: { ...t, log } } };
  }),
 appendCommitMessage: (cwd, text) =>
  set((s) => {
   const t = s.commitTasks[cwd];
   if (!t) return {};
   const raw = t.message + text;
   // 生成流可能很长（模型跑飞）：保头也保尾没意义，直接截到上限（编辑框里本来就只是草稿）
   const message = raw.length <= COMMIT_MSG_MAX ? raw : raw.slice(raw.length - COMMIT_MSG_MAX);
   return { commitTasks: { ...s.commitTasks, [cwd]: { ...t, message } } };
  }),
 finishCommitTask: (cwd, outcome) =>
  set((s) => {
   const t = s.commitTasks[cwd];
   if (!t) return {};
   // 浮层关着时任务结束：**失败保留**（行徽章亮起，等用户查看），其余终态即清
   // （「待推送 / 已推送」由 git 快照的行徽章接管，不清会让行上失去入口）。
   if (s.activeCommitCwd !== cwd && outcome.phase !== "failed") {
    const next = { ...s.commitTasks };
    delete next[cwd];
    return { commitTasks: next };
   }
   return {
    commitTasks: {
     ...s.commitTasks,
     [cwd]: {
      ...t,
      phase: outcome.phase,
      commits: outcome.commits,
      // 生成的信息随终态回来（编辑框里可能只有流式原文，落定用解析后的那份）
      message: outcome.message ?? t.message,
      generated: t.generated || outcome.phase === "generated",
      error: outcome.error,
      hint: outcome.hint,
     },
    },
   };
  }),
 dropCommitTask: (cwd) =>
  set((s) => {
   if (!s.commitTasks[cwd]) return {};
   const next = { ...s.commitTasks };
   delete next[cwd];
   return { commitTasks: next };
  }),
 setActiveCommitCwd: (cwd) => set({ activeCommitCwd: cwd }),
 commitLangPrefs: loadCommitLangPrefs(),
 setCommitLangPref: (projectId, pref) => {
  // 内存态与已记住的盘上副本一起更新（未记住的项目写盘时会被过滤掉）
  const next = { ...get().commitLangPrefs, [projectId]: pref };
  saveCommitLangPrefs(next);
  set({ commitLangPrefs: next });
 },
}));
