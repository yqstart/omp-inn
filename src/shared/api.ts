import { Channel, invoke } from "@tauri-apps/api/core";
import { IPC } from "./ipc";
import { isRemoteClient, remoteInvoke } from "./remote";
import type { ImageBlock } from "./types";
import type { BtwRecord, ChangeSet, CheckoutView, CommitEvent, ConstraintFile, ConstraintsView, ConstraintKind, ContextBreakdown, DirListing, DiscoveredModel, FallbackChainsInfo, GitCommitDetail, GitCommitDiff, GitGraphPage, GitInfo, HealthInfo, ImageAttachment, MemoryFileContent, MemoryProjectView, ModelCatalog, ModelRolesInfo, ModelsConfigFile, OmpInfo, OmpSetting, OmpSettingsCatalog, OmpUpdateEvent, OmpUpdateStatus, Overlay, PathCheck, PathSearch, PluginDoctorFinding, PluginFeatures, PluginsView, ProjectFiles, ProjectView, ProviderLoginStatus, ProviderPurgeInfo, ProviderUsage, ProviderView, PullOutcome, RemotePairing, RemoteStatus, RemoteTailscale, ScriptCatalog, SessionLiveStats, SessionPage, SessionRuntime, SessionStats, SessionView, SkillFileContent, SkillsView, SystemPermissionKind, SystemPermissions, StorageCleanPlan, StorageCleanResult, StoragePreview, StorageStats, TerminalEvent, TerminalSpawnOpts, TitlePromptLang, TitlePromptOutcome, UsageStats, WorkspaceGitState, WorkspaceView } from "./types";

/**
 * 前端调用 Tauri commands 的唯一入口。
 * 命令名与 `src-tauri` 注册名保持一致；失败统一抛 Error(message)。
 *
 * 手机 PWA 模式（`window.__OMP_REMOTE__`）走 HTTP/WS；桌面端仍是 Tauri invoke。
 */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
 try {
  return isRemoteClient() ? await remoteInvoke<T>(cmd, args) : await invoke<T>(cmd, args);
 } catch (error) {
  if (error instanceof Error) throw error;
  // Tauri 把 Rust CmdError 序列化为普通对象；先归一，界面才能显示真实诊断而非笼统失败。
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
   const hint = "hint" in error && typeof error.hint === "string" ? error.hint : "";
   throw Object.assign(new Error(hint ? `${error.message}\n${hint}` : error.message), { cause: error });
  }
  throw Object.assign(new Error(String(error)), { cause: error });
 }
}

export const api = {
 getHealth: () => call<HealthInfo>(IPC.getHealth),
 getModels: () => call<ModelCatalog>(IPC.getModels),
 refreshModels: () => call<ModelCatalog>(IPC.refreshModels),
 getOverlay: () => call<Overlay>(IPC.getOverlay),
 listProjects: () => call<ProjectView[]>(IPC.listProjects),
 /** 轻量对账：外部改名后按目录身份链找回项目路径；返回路径是否有变化。 */
 reconcileProjects: () => call<boolean>(IPC.reconcileProjects),
 addProject: (path: string) => call<ProjectView>(IPC.addProject, { path }),
 removeProject: (id: string) => call<void>(IPC.removeProject, { id }),
 relocateProject: (id: string, path: string) =>
  call<ProjectView>(IPC.relocateProject, { id, path }),
 /** 会话列表（分页）：`limit` 为扫描窗口大小（后端默认 500，夹在 1..=5000）。 */
 listSessions: (projectId?: string, limit?: number) =>
  call<SessionPage>(IPC.listSessions, { projectId, limit }),
 /**
  * 已归档对话清单（设置页「已归档对话」tab）：**不受扫描窗口限制**——
  * 归档是管理面，老到 `list_sessions` 窗口外的归档会话也必须能在这里找到并恢复 / 删除。
  */
 listArchivedSessions: () => call<SessionView[]>(IPC.listArchivedSessions),
 archiveSessions: (ids: string[]) =>
  call<{ ok: number; failed: { id: string; message: string }[] }>(IPC.archiveSessions, { ids }),
 /** 批量取消归档（设置页「恢复」）：与 `archiveSessions` 同结构、同上限（单次 200）。 */
 unarchiveSessions: (ids: string[]) =>
  call<{ ok: number; failed: { id: string; message: string }[] }>(IPC.unarchiveSessions, { ids }),
 deleteSessions: (ids: string[]) =>
  call<{ ok: number; failed: { id: string; message: string }[] }>(IPC.deleteSessions, { ids }),
 setOmpPath: (path: string | null) => call<OmpInfo>(IPC.setOmpPath, { path }),
 /**
  * 工作区（V21）：多项目容器（左栏顶层单元）。成员关系在项目侧
  * （`ProjectView.workspaceId`），一个项目最多属于一个工作区。
  */
 listWorkspaces: () => call<WorkspaceView[]>(IPC.listWorkspaces),
 /** 新建工作区：`name` + `projectIds`（成员重设语义同 `updateWorkspace`）。 */
 createWorkspace: (name: string, projectIds: string[]) =>
  call<WorkspaceView>(IPC.createWorkspace, { name, projectIds }),
 /** 一次写全：改名 + 成员重设（被移出的项目回归未分组；不删项目、不动文件）。 */
 updateWorkspace: (id: string, name: string, projectIds: string[]) =>
  call<void>(IPC.updateWorkspace, { id, name, projectIds }),
 /** 删组：成员回归未分组（不删项目 / 文件）。 */
 deleteWorkspace: (id: string) => call<void>(IPC.deleteWorkspace, { id }),
 /**
  * 左栏拖拽落地（V26）：把一个项目移动到目标工作区（`workspaceId = null` = 未分组）并同步全局顺序。
  * `order` = 拖拽后的**全部项目 id 顺序**（左栏顺序 = 覆盖层 `projects` 的数组顺序）；
  * 返回新顺序的项目清单（前端直接落 store，不必再拉一次 `list_projects`）。
  */
 moveProject: (id: string, workspaceId: string | null, order: string[]) =>
  call<ProjectView[]>(IPC.moveProject, { id, workspaceId, order }),
 /**
  * 目录行（V21 前叫「工作区行」）：每个项目 = 主目录 + 它全部 git worktree（只读展示，
  * 壳侧不创建 / 不删除 worktree）。
  */
 listCheckouts: () => call<CheckoutView[]>(IPC.listCheckouts),
 /**
  * 引用浮层（V22）：批量列项目文件（`git ls-files`；只读、60s 后端缓存）。
  * 每项失败只落 `error` 字段（非 git 目录不拖垮整表）。
  */
 listProjectFiles: (paths: string[]) => call<ProjectFiles[]>(IPC.listProjectFiles, { paths }),

 /**
  * 提交 / 推送（V19）：先取变更集（打开面板），再按轨道发起任务。
  * 输出都经 **Channel** 流式回流（`line` / `delta` / `message` / `phase` / `exit`）。
  */
 getChangeSet: (cwd: string) => call<ChangeSet>(IPC.getChangeSet, { cwd }),
 /**
  * Git 图谱（右栏页签，只读）：一页提交历史。
  * `rev` = 完整引用（`refs/heads/...`）；缺省 = 全部分支 / 标签 / 远程 + HEAD。
  */
 gitGraph: (cwd: string, rev: string | null, limit?: number, skip?: number) =>
  call<GitGraphPage>(IPC.gitGraph, { cwd, rev, limit, skip }),
 /** 提交详情（元信息 + 文件清单；合并提交按第一个父提交给改动）。 */
 gitCommitDetail: (cwd: string, hash: string) =>
  call<GitCommitDetail>(IPC.gitCommitDetail, { cwd, hash }),
 /** 提交内单文件 diff（`path` 相对仓库根）。 */
 gitCommitDiff: (cwd: string, hash: string, path: string) =>
  call<GitCommitDiff>(IPC.gitCommitDiff, { cwd, hash, path }),
 /** 快速轨第一步：把勾选同步进暂存区 → 一次 `omp -p` 单轮生成提交信息（不提交）。 */
 generateCommitMessage: (
  cwd: string,
  paths: string[],
  language: string | null,
  onEvent: Channel<CommitEvent>,
 ) => call<void>(IPC.generateCommitMessage, { cwd, paths, language, onEvent }),
 /** 快速轨第二步：再同步一次勾选 → `git commit` →（可选）`git push`。 */
 commitSelected: (
  cwd: string,
  paths: string[],
  message: string,
  push: boolean,
  onEvent: Channel<CommitEvent>,
 ) => call<void>(IPC.commitSelected, { cwd, paths, message, push, onEvent }),
 /** 完整轨：`omp commit`（AI 信息 + changelog 维护 + 校验器）；慢但功能全。 */
 startFullCommit: (
  cwd: string,
  paths: string[],
  language: string | null,
  onEvent: Channel<CommitEvent>,
 ) => call<void>(IPC.startFullCommit, { cwd, paths, language, onEvent }),
 /** 推送（有上游直接推；没有上游自动 `-u` 建立跟踪）。 */
 pushWorkspace: (cwd: string, onEvent: Channel<CommitEvent>) =>
  call<void>(IPC.pushWorkspace, { cwd, onEvent }),
 /** 取消运行中的任务（后端杀进程组，落 `canceled` 终态）。 */
 cancelCommitTask: (cwd: string) => call<void>(IPC.cancelCommitTask, { cwd }),
 /**
  * 拉取远程（行徽章的 behind 徽章点击）：`git pull`（不 rebase，能快进就快进、分叉就合并）。
  * 冲突**不是**异常——后端返回 `status: "conflicts"` + 冲突文件绝对路径，前端去编辑器解决。
  */
 pullWorkspace: (cwd: string) => call<PullOutcome>(IPC.pullWorkspace, { cwd }),
 /** 冲突解决后继续合并（未标记解决的冲突文件先 add，再用合并信息提交）。 */
 continueMerge: (cwd: string) => call<void>(IPC.continueMerge, { cwd }),
 /** 放弃这次合并（`git merge --abort`，工作区回到拉取前）。 */
 abortMerge: (cwd: string) => call<void>(IPC.abortMerge, { cwd }),
 /**
  * 左栏行徽章的 git 快照（批量；每行一次 `status --porcelain -b`，后端并发 + 超时降级）。
  */
 getWorkspaceGitState: (paths: string[]) =>
  call<WorkspaceGitState[]>(IPC.getWorkspaceGitState, { paths }),

 // ---------- 聊天形态（V32 恢复自 V1–V10）：RPC 会话命令面 ----------

 /** 新建聊天会话（按目录开：左栏目录行 / 会话弹窗的「新建」传 checkout 路径）。 */
 createSession: (cwd: string) => call<SessionView>(IPC.createSession, { cwd }),
 /** 打开（或聚焦）聊天会话：已有长驻进程直接返回；否则 `omp --resume` 拉起。 */
 openSession: (id: string) => call<SessionView>(IPC.openSession, { id }),
 /** 会话改名（V40）：RPC `set_session_name` 写 omp 真名（jsonl `title` 行）+ 清覆盖层备注。 */
 renameSession: (id: string, name: string) => call<SessionView>(IPC.renameSession, { id, name }),
 /**
  * 历史回放从最新页开始，`before` 为下一页的字节游标；`lines` 是 jsonl 原始行。
  */
 getHistory: (id: string, before?: number) => call<{ lines: unknown[]; lineOffsets?: number[]; before?: number | null; end?: number; skipped?: boolean; truncated?: boolean }>(IPC.getHistory, { id, before }),
 sendMessage: (id: string, message: string, images?: ImageAttachment[]) =>
  call<void>(IPC.sendMessage, { id, message, images }),
 /** 流式中转向（`steer`）：在下一个工具调用边界生效，不砍掉进行中的工作。 */
 steerMessage: (id: string, message: string, images?: ImageAttachment[]) =>
  call<void>(IPC.steerMessage, { id, message, images }),
 /** 流式中排队（`follow_up`）：本轮结束后按序执行。 */
 followUpMessage: (id: string, message: string, images?: ImageAttachment[]) =>
  call<void>(IPC.followUpMessage, { id, message, images }),
 /** `/` 命令：经 prompt 直发（本地命令走 command_output 回来，无 agent turn）。 */
 runSlash: (id: string, command: string) => call<void>(IPC.runSlash, { id, command }),
 /** 上下文压缩：把历史压缩成摘要后继续本会话（满上下文时的接续手段）。 */
 compactSession: (id: string, customInstructions?: string) =>
  call<void>(IPC.compactSession, { id, customInstructions }),
 /** 图片附件走「系统文件选择器 → 后端读文件」：WebView 拿不到任意本地路径的内容。 */
 readImageFile: (path: string) => call<ImageAttachment>(IPC.readImageFile, { path }),
 /** 历史会话的图片引用（`blob:sha256:<hash>`）：后端只读 omp 的 blobs 目录，返回 base64。 */
 readBlobImage: (hash: string) => call<ImageAttachment>(IPC.readBlobImage, { hash }),
 /** 复制图片到系统剪贴板（解码在主线程写 NSPasteboard / OLE 剪贴板）。 */
 copyImage: (dataBase64: string) => call<void>(IPC.copyImage, { dataBase64 }),
 /** 另存为：路径由前端系统保存对话框给出，后端只写字节。 */
 saveImageFile: (path: string, dataBase64: string) => call<void>(IPC.saveImageFile, { path, dataBase64 }),
 /** 输入框 @提及 的存在性提示（后端只 stat，不读内容、不写任何东西）。 */
 checkPaths: (base: string, paths: string[]) => call<PathCheck[]>(IPC.checkPaths, { base, paths }),
 /** `@` 路径补全（只读目录列举，不读文件内容）。 */
 completePath: (base: string, prefix: string) =>
  call<{ path: string; real: string; isDir: boolean; label: string }[]>(IPC.completePath, { base, prefix }),
 stop: (id: string) => call<void>(IPC.stopSession, { id }),
 approve: (id: string, uiId: string, decision: "once" | "always" | "deny") =>
  call<void>(IPC.approve, { id, uiId, decision }),
 /**
  * 通用 UI 请求回包（非审批）：`confirm` → `{confirmed}`，`value` → `{value}`，`cancel` → `{cancelled}`，
  * `answers` → `{answers}`（`ask` 多问题卡的提交，V40）。
  * 与 `approve` 分开：审批的「总是允许」还要写会话级 yolo 意向，语义不同。
  */
 respondUi: (
  id: string,
  uiId: string,
  kind: "value" | "confirm" | "cancel" | "answers",
  opts?: { value?: string; confirmed?: boolean; answers?: { id: string; selectedOptions: string[]; customInput?: string }[] },
 ) =>
  call<void>(IPC.respondUi, { id, uiId, kind, value: opts?.value, confirmed: opts?.confirmed, answers: opts?.answers }),
 setModel: (id: string, provider: string, modelId: string) =>
  call<void>(IPC.setModel, { id, provider, modelId }),
 setThinking: (id: string, level: string) => call<void>(IPC.setThinking, { id, level }),
 getSessionRuntime: (id: string) => call<SessionRuntime | null>(IPC.getSessionRuntime, { id }),
 /**
  * omp 全局「默认思考等级」（`defaultThinkingLevel`，读 omp 全局配置）——思考档的默认来源：
  * 会话里档位缺失 / 对新模型非法时壳侧落的就是它（夹到模型支持集）；未设置返回 `null`。
  */
 getDefaultThinkingLevel: () => call<string | null>(IPC.getDefaultThinkingLevel),
 /**
  * 上下文分项（输入框工具行的「上下文容量」面板）：已用 / 窗口 / 非消息是 omp 真值，
  * 非消息各档按字符量估算后缩放到真值。**只读**——不启动进程、不写任何东西。
  */
 getContextBreakdown: (id: string) => call<ContextBreakdown>(IPC.getContextBreakdown, { id }),
 getGitInfo: (path: string) => call<GitInfo>(IPC.getGitInfo, { path }),
 /** 输入卡顶行分支切换：成功即新工作区状态（调用方刷新 git 信息）。 */
 switchBranch: (cwd: string, branch: string) => call<void>(IPC.switchBranch, { cwd, branch }),
 /**
  * 队列真值（V40）：撤回一条尚未投递的队列消息；`queue` 选 steering / followUp。
  * 返回图片（若有）供编辑回草稿；超传输上限时 `imagesDropped`。
  */
 removeQueuedMessage: (id: string, message: string, queue: "steering" | "followUp") =>
  call<{ removed: boolean; images?: ImageBlock[]; imagesDropped?: boolean }>(IPC.removeQueuedMessage, {
   id,
   message,
   queue,
  }),
 /** 把一条 followUp 提升为 steering（排队 → 立刻插话）。 */
 promoteQueuedMessage: (id: string, message: string) =>
  call<{ promoted: boolean }>(IPC.promoteQueuedMessage, { id, message }),
 /**
  * 中断并交还队列（Esc = omp TUI 的 Esc）：返回被撤回的插话 / 排队文本（含图片），
  * 调用方把它们放回输入框。响应恒成功（队列为空时等同普通 abort）。
  */
 abortAndRestoreQueue: (id: string) =>
  call<{
   steering: { text: string; images?: ImageBlock[] }[];
   followUp: { text: string; images?: ImageBlock[] }[];
   imagesDropped?: boolean;
   truncated?: boolean;
  }>(IPC.abortAndRestoreQueue, { id }),
 getSessionStats: (id: string) => call<SessionStats>(IPC.getSessionStats, { id }),
 /** 会话累计统计（输入卡底部统计条；只读会话文件，不启动进程）。 */
 getSessionLiveStats: (id: string) => call<SessionLiveStats>(IPC.getSessionLiveStats, { id }),
 /** 旁问（/btw）：一问一答，不进会话转录；`recordId` 时是对该话题的追问。 */
 btwAsk: (id: string, question: string, recordId?: string) =>
  call<{ record: BtwRecord }>(IPC.btwAsk, { id, question, recordId }),
 btwCancel: (id: string, recordId?: string) =>
  call<{ cancelled: boolean }>(IPC.btwCancel, { id, recordId }),
 getBtwHistory: (id: string) => call<{ records: BtwRecord[] }>(IPC.getBtwHistory, { id }),
 /** 重启会话 runtime（仅 idle 且队列空；执行模式切换的即时生效路径）。 */
 restartSessionRuntime: (id: string) => call<SessionView>(IPC.restartSessionRuntime, { id }),
 /** 单文件工作区 diff（HEAD 对工作区；untracked 给全文）。 */
 gitFileDiff: (path: string) =>
  call<{ kind: "diff" | "untracked" | "none" | "error"; text: string; truncated: boolean; error?: string }>(IPC.gitFileDiff, {
   path,
  }),
 /** 子代理注册表快照（V41；条目形状未知，前端按 `subagentFromFrame` 容错解析）。 */
 getSubagents: (id: string) => call<{ subagents: unknown[] }>(IPC.getSubagents, { id }),
 /** 取消一个运行中的子代理 → `{cancelled}`。 */
 cancelSubagent: (id: string, subagentId: string) =>
  call<{ cancelled: boolean }>(IPC.cancelSubagent, { id, subagentId }),
 /** 读子代理转录（增量：`fromByte` 复用上次的 `nextByte`）。 */
 getSubagentMessages: (id: string, subagentId: string, fromByte?: number) =>
  call<{ sessionFile: string; fromByte: number; nextByte: number; reset?: boolean; messages?: unknown[]; entries?: unknown[] }>(
   IPC.getSubagentMessages,
   { id, subagentId, fromByte },
  ),
 /** fast 模式开关（`{enabled, active}`；模型不支持时失败，错误文本原样给界面）。 */
 setFastMode: (id: string, enabled: boolean) => call<{ enabled: boolean; active: boolean }>(IPC.setFastMode, { id, enabled }),
 /** 导出会话为 HTML（omp 写到会话 cwd）→ `{path}` 绝对路径。 */
 exportSessionHtml: (id: string) => call<{ path: string }>(IPC.exportSessionHtml, { id }),
 /** 大段粘贴转文件引用（V41）：文本落 `<appData>/omp-inn/paste/`，返回绝对路径（前端注入 `@<path>`）。 */
 savePaste: (text: string) => call<{ path: string }>(IPC.savePaste, { text }),
 /** 本地 shell（V41，codex 的 `!` 前缀）：在会话进程的工作目录跑一条命令。 */
 runBash: (id: string, command: string) =>
  call<{
   exitCode: number;
   cancelled: boolean;
   workingDir: string;
   output: string;
   truncated: boolean;
   outputLines: number;
   totalLines: number;
  }>(IPC.runBash, { id, command }),
 getGlobalApproval: () => call<string>(IPC.getGlobalApproval),
 setGlobalApproval: (mode: string) => call<void>(IPC.setGlobalApproval, { mode }),
 setSessionApproval: (id: string, mode: string | null) =>
  call<void>(IPC.setSessionApproval, { id, mode }),

 /**
  * 供应商（设置 › 供应商）：omp 的 login / logout / modelRoles 映射。
  * 登录走 `omp auth-broker login` 子进程（不经 RPC），进度经 `omp-provider://login` 全量推送。
  */
 listProviders: () => call<ProviderView[]>(IPC.listProviders),
 getProviderLogin: () => call<ProviderLoginStatus>(IPC.getProviderLogin),
 startProviderLogin: (providerId: string) =>
  call<void>(IPC.startProviderLogin, { providerId }),
 /** 回答上游提问（选端点 / 粘贴 API key…）：一行文本写进登录子进程 stdin。 */
 providerLoginInput: (text: string) => call<void>(IPC.providerLoginInput, { text }),
 cancelProviderLogin: () => call<void>(IPC.cancelProviderLogin),
 /** 登出 = 删除该供应商在 omp 凭证库里的全部凭证（不可撤销，调用方需二次确认）。 */
 logoutProvider: (providerId: string) => call<void>(IPC.logoutProvider, { providerId }),
 getModelRoles: () => call<ModelRolesInfo>(IPC.getModelRoles),
 /** 改一个角色；`selector = null` 删除该角色（未配置 = 按 omp 回退规则解析）。 */
 setModelRole: (role: string, selector: string | null) =>
  call<ModelRolesInfo>(IPC.setModelRole, { role, selector }),
 /**
  * 整表覆盖模型角色（设置 › 模型的「模型配置」）：激活一套配置 / 编辑激活配置时调用。
  * 后端逐项校验、已是目标值就不写、写完回读真值；空表 = 清空所有角色。
  */
 applyModelRoles: (roles: Record<string, string>) =>
  call<ModelRolesInfo>(IPC.applyModelRoles, { roles }),
 /**
  * 同步 Ctrl+P 轮换序（omp `cycleOrder`）：环是「模型角色」的派生投影——后端按角色展示
  * 顺序取已配置模型、按**模型基名**保序去重（`:思考档` 后缀不算另一个模型；重复模型保留
  * 第一个出现的角色），已是目标值就不写；**幂等**，返回回读的真值。打开模型页与改角色后各跑一次。
  */
 syncCycleOrder: () => call<string[]>(IPC.syncCycleOrder),
 /**
  * 失败转移链（设置 › 模型）：omp `retry.fallbackChains` 的读写与两个配套开关
  * （`retry.modelFallback` / `retry.fallbackRevertPolicy`），写的是 omp 全局配置。
  */
 getFallbackChains: () => call<FallbackChainsInfo>(IPC.getFallbackChains),
 /** 改一条链；`fallbacks = null`（或空数组）删除该键。顺序即 omp 的尝试顺序。 */
 setFallbackChain: (key: string, fallbacks: string[] | null) =>
  call<FallbackChainsInfo>(IPC.setFallbackChain, { key, fallbacks }),
 /** 改两个配套开关（`false` 时链完全不生效；回归策略只认两个上游合法值）。 */
 setRetryOptions: (modelFallback: boolean, revertPolicy: string) =>
  call<FallbackChainsInfo>(IPC.setRetryOptions, { modelFallback, revertPolicy }),
 /**
  * 供应商登出 / 删除后清理 omp 侧对它的模型引用：`modelRoles` 里指向该供应商的角色、
  * `retry.fallbackChains` 里以它为键或目标的条目、以及派生出的 `cycleOrder`。
  * 返回清理后的回读真值；「我的模型」与多套角色配置由前端另行清理。
  */
 purgeProviderModels: (providerId: string) =>
  call<ProviderPurgeInfo>(IPC.purgeProviderModels, { providerId }),
 /**
  * 记忆（设置 › 记忆）：omp 项目记忆（`<agentDir>/memories/` 下按 cwd 一目录一份）。
  * 上游没有 `omp memory` CLI，记忆由 omp 自己生成——壳侧只列 / 读 / 删，**从不写**。
  */
 listMemories: () => call<MemoryProjectView[]>(IPC.listMemories),
 /** 读单个记忆文件正文（后端上限 1MB，超出截断并标记 `truncated`）。 */
 readMemoryFile: (dir: string, file: string) =>
  call<MemoryFileContent>(IPC.readMemoryFile, { dir, file }),
 /** 删单个记忆文件（不可撤销；调用方需二次确认）。 */
 deleteMemoryFile: (dir: string, file: string) =>
  call<void>(IPC.deleteMemoryFile, { dir, file }),
 /** 清空一个项目的全部记忆（删整个记忆目录；不可撤销，调用方需二次确认）。 */
 deleteMemoryProject: (dir: string) => call<void>(IPC.deleteMemoryProject, { dir }),
 /**
  * 使用统计（设置 › 使用统计）：扫会话 jsonl 聚合用量（token / 费用 / 工具 / 时段）。
  * `days` = 1 / 7 / 30（null = 全部）；后端有文件数 / 字节 / 墙钟三道预算，
  * 到点即停并把 `truncated` 置 true——**只读**，不写 omp、不写覆盖层。
  */
 getUsageStats: (days: number | null) => call<UsageStats>(IPC.getUsageStats, { days }),
 /**
  * 供应商用量（设置 › 供应商用量）：跑 `omp usage --json` 取各已登录供应商的
  * 滚动窗口用量（5 小时 / 每周 / 每月）——上游只有 omp 自己拿得到这些数据；
  * 壳侧只解析、不直连任何配额 API、不碰凭证库。**只读**（不动 omp 缓存）。
  */
 getProviderUsage: () => call<ProviderUsage>(IPC.getProviderUsage),
 /**
  * omp 设置目录（设置 ›「常用设置」）：上游 `omp config list` 的完整目录——文本 + JSON 两路
  * 合并（文本给分组与枚举取值表，JSON 给类型化值与说明）。**只读**；页面按壳侧展示清单
  * （`lib/settingsList.ts`）过滤显示；写入走下面的
  * `setOmpSetting` / `resetOmpSetting`（omp 全局层：`~/.omp/agent/config.yml`，
  * `<cwd>/.omp/config.yml` 的项目覆盖优先于它；不碰覆盖层与凭证库）。
  */
 getOmpSettingsCatalog: () => call<OmpSettingsCatalog>(IPC.getOmpSettingsCatalog),
 /** 写一个设置项；返回值是**写入后回读**的真相（omp 静默丢弃写入时界面不该显示假值）。 */
 setOmpSetting: (key: string, value: unknown) => call<OmpSetting>(IPC.setOmpSetting, { key, value }),
 /** 恢复该键的 schema 默认值（`omp config reset`，把默认值写回全局配置）。 */
 resetOmpSetting: (key: string) => call<OmpSetting>(IPC.resetOmpSetting, { key }),
 /**
  * 系统授权（设置 ›「系统授权」）：读 macOS TCC 四项授权的**实际生效状态**——
  * 不是系统设置里那个开关（签名身份变了以后记录会与当前 app 对不上，开关看着开着但无效）。
  * 纯本地查询，可随面板轮询。非 macOS 回 `supported: false`。
  */
 getSystemPermissions: () => call<SystemPermissions>(IPC.getSystemPermissions),
 /** 请求对应系统授权；完全磁盘访问及已有拒绝记录的情况引导至系统设置。 */
 openSystemPermission: (kind: SystemPermissionKind) => call<void>(IPC.openSystemPermission, { kind }),
 /**
  * omp 约束（设置 ›「omp 约束」）：全局上下文约束 `AGENTS.md`、sticky 硬规则 `RULES.md`
  * 与独立规则 `rules/*.{md,mdc}` 的清单（含文件内容；规则文件体量很小，一次读全）。
  * **只碰全局层**，项目级 `.omp/` 由 omp 自己发现。
  */
 getOmpConstraints: () => call<ConstraintsView>(IPC.getOmpConstraints),
 /**
  * 写一份全局约束 / 规则。`expectHash` = 打开时的内容哈希（乐观锁）：文件被外部改过
  * 就抛错（前端提示重新加载）；传 `null` 是显式的「强制覆盖」（冲突对话框）。
  * 后端写前备份 → 原子写 → 回读。规则文件保存前由前端做 YAML / 字段校验。
  */
 writeOmpConstraint: (kind: ConstraintKind, name: string, content: string, expectHash: string | null) =>
  call<ConstraintFile>(IPC.writeOmpConstraint, { kind, name, content, expectHash }),
 /** 新建一份独立规则（输入规则名；没写扩展名就补 `.md`）。已存在则报错。 */
 createOmpRule: (stem: string) => call<ConstraintFile>(IPC.createOmpRule, { stem }),
 /** 删除一份独立规则（后端先备份再删；界面负责二次确认）。 */
 deleteOmpRule: (name: string) => call<void>(IPC.deleteOmpRule, { name }),
 /**
  * 自定义模型接入（设置 › 供应商）：读 / 写 `<agentDir>/models.yml`
  * ——omp 用户级自定义供应商 / 模型的唯一入口（上游没有 CLI 写入口，写文件是唯一路径）。
  * YAML 的保真编辑在前端做（`lib/customModels.ts`）；后端负责预校验（拿候选文本在临时
  * agentDir 里问一次 omp，坏配置**不落盘**）/ 备份 / 原子写。
  * `expectHash` = 读时的 hash（乐观锁：文件被外部改过时写入被拒）。
  */
 readModelsConfig: () => call<ModelsConfigFile>(IPC.readModelsConfig),
 writeModelsConfig: (text: string, expectHash: string | null) =>
  call<ModelsConfigFile>(IPC.writeModelsConfig, { text, expectHash }),
 /**
  * 探测某个端点提供的模型清单（设置 › 供应商 ›「获取可用模型」）：**只读探测，不落盘**。
  *
  * 口径对齐 DeepSeek Harness：OpenAI 系 `GET {接口地址}/models`（按前缀拼，不自动补 `/v1`）、
  * Anthropic `GET {根}/v1/models?limit=1000`；认证分别用 `Bearer` 与 `x-api-key`
  * （没填 apiKey 就不带认证头）。`apiKey` 传表单原样值：`!命令` 会执行取 stdout，
  * 裸名字先当环境变量名查（命中用其值），其余按字面量。
  */
 fetchProviderModels: (baseUrl: string, api: string, apiKey: string | null) =>
  call<DiscoveredModel[]>(IPC.fetchProviderModels, { baseUrl, api, apiKey }),
 /**
  * 插件（设置 ›「插件」）：omp 的插件管理（`omp plugin`）。
  *
  * `cwd` = 这次读取 / 操作钉的工作目录：**项目级可见范围**由它决定（项目 package.json 里装的
  * 插件、项目级市场插件都按 cwd 解析）；缺省 = 用户级视图（钉 agentDir）。
  */
 listPlugins: (cwd?: string | null) => call<PluginsView>(IPC.listPlugins, { cwd }),
 /** 启用 / 禁用（npm / link 插件不给 scope；市场插件同 id 双份时必须给对应的那份）。 */
 setPluginEnabled: (name: string, enabled: boolean, scope?: string | null, cwd?: string | null) =>
  call<PluginsView>(IPC.setPluginEnabled, { name, enabled, scope: scope ?? null, cwd: cwd ?? null }),
 /**
  * 写一个插件的特性集合（**整组覆盖**）。上游 `enabledFeatures` 为 `null` 时按每个特性的
  * `default` 生效——传「当前生效的集合」即可保持语义；一旦写过就是显式列表（不再回落默认）。
  *
  * 注意层级：特性状态存在**用户插件目录**的运行态登记里，与「可见范围 cwd」无关（项目级只影响
  * 市场插件的发现位置），所以这个命令不接受 cwd。
  */
 setPluginFeatures: (plugin: string, features: string[]) =>
  call<PluginFeatures>(IPC.setPluginFeatures, { plugin, features }),
 /**
  * 安装一个插件（源 = npm 包 / git 仓库 / 本地目录 / `名字@市场名`）。
  * 壳侧不提供「预览」：上游 `--dry-run` 对市场条目**会照装**（文档明说不适用），
  * 界面上用信任提示 + 二次确认替代。
  */
 installPlugin: (source: string, scope?: string | null, cwd?: string | null) =>
  call<PluginsView>(IPC.installPlugin, { source, scope: scope ?? null, cwd: cwd ?? null }),
 /** 卸载一个插件（市场插件双份时用 `scope` 指定那一份）。 */
 uninstallPlugin: (id: string, scope?: string | null, cwd?: string | null) =>
  call<PluginsView>(IPC.uninstallPlugin, { id, scope: scope ?? null, cwd: cwd ?? null }),
 /** 插件体检（`fix` = 让上游尝试修复；只读检查不写任何东西）。 */
 pluginDoctor: (fix: boolean) => call<PluginDoctorFinding[]>(IPC.pluginDoctor, { fix }),
 /**
  * 技能（设置 ›「技能」）：omp 的技能发现结果 + 逐项启停。
  *
  * `cwd` = 发现范围（项目目录；缺省 = 家目录 = 只看用户级技能）。项目级技能来自
  * `.omp/skills` 等目录、由 omp 从该目录向上走到仓库根逐级发现。
  */
 listSkills: (cwd?: string | null) => call<SkillsView>(IPC.listSkills, { cwd }),
 /**
  * 启用 / 停用一项技能：写 omp 全局配置的 `disabledExtensions`（加 / 删 `skill:<名字>`，**按名字全局生效**）。
  * 返回**回读后**的停用技能名——停用后上游不再列出该技能，界面靠这份名单画「已停用」行。
  */
 setSkillEnabled: (name: string, enabled: boolean) =>
  call<string[]>(IPC.setSkillEnabled, { name, enabled }),
 /** 读一个 `SKILL.md` 的正文（只允许 `SKILL.md`，超上限截断）。 */
 readSkillFile: (path: string) => call<SkillFileContent>(IPC.readSkillFile, { path }),
 /**
  * 会话标题语言（V18）：把壳的界面语言同步成 omp 的 `<agentDir>/TITLE_SYSTEM.md`
  * （标题生成 prompt）——上游没有 CLI / 设置项改标题 prompt，写该文件是唯一路径。
  * `lang` 只有 `"zh"` / `"en"` 两档；用户自写的同名文件后端不碰（回 `skipped`）。
  */
 syncTitlePrompt: (lang: TitlePromptLang) =>
  call<TitlePromptOutcome>(IPC.syncTitlePrompt, { lang }),
 /**
  * omp 运行时更新检查（左栏字标行的版本 chip）：跑一次 `omp update --check`
  * ——上游只检查不安装（结论 = 当前版本 / 新版本号 / 渠道）。失败抛 Error（原因 = 上游 stderr）。
  */
 checkOmpUpdate: () => call<OmpUpdateStatus>(IPC.checkOmpUpdate),
 /**
  * 执行更新（真安装）：`omp update`——上游自己识别安装方式（brew / npm / bun / 独立二进制）
  * 再选路。**命令立刻返回**，过程与终局走 Channel（`line` 流式日志 + `exit` 终局）；
  * 同一时刻只允许一个更新（后端返回 BUSY）。
  */
 startOmpUpdate: (onEvent: Channel<OmpUpdateEvent>) => call<void>(IPC.startOmpUpdate, { onEvent }),
 /**
  * 安装 omp（omp 缺失时的「安装 omp」入口）：跑 **omp 官方安装脚本**
  * （`curl -fsSL https://omp.sh/install | sh`；Windows 走 `install.ps1`）。命令立刻返回，
  * 输出与终局走 Channel（与 `startOmpUpdate` 同形）；与更新共用单槽，并发返回 BUSY。
  * 安装完成后的路径 / 版本由调用方重新 `getHealth` 识别。
  */
 installOmp: (onEvent: Channel<OmpUpdateEvent>) => call<void>(IPC.installOmp, { onEvent }),
 /** 取消进行中的更新（杀进程组；终局经 Channel 的 `exit` 到达，phase = canceled）。 */
 cancelOmpUpdate: () => call<void>(IPC.cancelOmpUpdate),

 // ---------- V42（右栏工作台）：文件目录树 + 终端 ----------

 /**
  * 列一层目录（右栏「文件」页签的懒加载入口）：只读、不递归。
  * `withRepoRoot` 只在树根传 true——变更标色要仓库根把 `getChangeSet` 的相对路径换算成绝对路径。
  */
 listDir: (path: string, withRepoRoot?: boolean) =>
  call<DirListing>(IPC.listDir, { path, withRepoRoot: withRepoRoot ?? false }),
 /**
  * 文件页签的快速过滤：按名字（或带 `/` 的相对路径）递归搜索文件与文件夹。
  * 只读、带扫描预算；返回相对路径与绝对路径，前端显示相对路径、引用注入用相对路径。
  */
 searchPaths: (root: string, query: string, limit?: number) =>
  call<PathSearch>(IPC.searchPaths, { root, query, limit: limit ?? null }),
 /**
  * 引用注入的**短标签**（输入框里显示的 `@components/` 这种）：给会话目录内的条目返回
  * 最短唯一后缀，目录外原样返回（跨项目仍用绝对路径）。发送前由 `checkPaths` 的 `resolved` 还原。
  */
 mentionLabel: (base: string, path: string) => call<string>(IPC.mentionLabel, { base, path }),
 /**
  * 打开终端（PTY 里的登录 shell）：输出 / 退出走 Channel（`onEvent`），
  * 与 `startOmpUpdate` 同一套「命令立刻返回、过程走通道」口径。
  */
 terminalSpawn: (opts: TerminalSpawnOpts, onEvent: Channel<TerminalEvent>) =>
  call<void>(IPC.terminalSpawn, { opts, onEvent }),
 /** 键盘输入写入 PTY（xterm 的 onData 原样透传；同步、按调用顺序落字）。 */
 terminalWrite: (id: string, data: string) => call<void>(IPC.terminalWrite, { id, data }),
 /**
  * 脚本注入：先等 shell 进入可输入状态（行编辑器 raw 模式）再写——提示符出来之前写，
  * 命令会被 tty 回显 + 行编辑器重画成两行。只有脚本页签用它。
  */
 terminalWriteReady: (id: string, data: string) => call<void>(IPC.terminalWriteReady, { id, data }),
 /** 面板尺寸变化 → PTY 行列数。 */
 terminalResize: (id: string, cols: number, rows: number) =>
  call<void>(IPC.terminalResize, { id, cols, rows }),
 /** 关闭终端：kill 子进程（SIGHUP → 1s 后进程组 SIGKILL 兜底，见 `pty.rs`）。 */
 terminalKill: (id: string) => call<void>(IPC.terminalKill, { id }),
 /**
  * 识别项目里的可跑脚本（`package.json` / `Cargo.toml` / `go.mod` / `manage.py` /
  * `Makefile` / `justfile` / `Taskfile.yml` …）。**只读**：不执行、不写盘。
  */
 discoverScripts: (cwd: string) => call<ScriptCatalog>(IPC.discoverScripts, { cwd }),

 // ---------- V50：手机远程控制（设置 ›「远程控制」） ----------
 /** 服务运行状态 + 地址 + 设备 + Tailscale（连接数变化时桌面事件也会推）。 */
 remoteGetStatus: () => call<RemoteStatus>(IPC.remoteGetStatus),
 /** 启动/重启服务；`access` = `lan`（0.0.0.0）或 `tailscale`（只绑 127.0.0.1）。 */
 remoteStart: (access: "lan" | "tailscale", port: number) =>
  call<RemoteStatus>(IPC.remoteStart, { access, port }),
 remoteStop: () => call<RemoteStatus>(IPC.remoteStop),
 /** 生成一次性配对二维码（secret 在 URL fragment 里，只在这里返回）。 */
 remotePairing: (baseUrl: string) => call<RemotePairing>(IPC.remotePairing, { baseUrl }),
 remoteCancelPairing: () => call<void>(IPC.remoteCancelPairing),
 remoteRevokeDevice: (id: string) => call<RemoteStatus>(IPC.remoteRevokeDevice, { id }),
 remoteRevokeAll: () => call<RemoteStatus>(IPC.remoteRevokeAll),
 remoteTailscaleProbe: () => call<RemoteTailscale>(IPC.remoteTailscaleProbe),
 remoteTailscaleEnable: () => call<RemoteStatus>(IPC.remoteTailscaleEnable),
 remoteTailscaleDisable: () => call<RemoteStatus>(IPC.remoteTailscaleDisable),

 // ---------- 存储维护（2026-10-22）：omp 侧占用 / 清理 / 壳侧闲置回收 ----------
 /** 目录占用读数（只读；不跑 `omp gc`）。 */
 getStorageStats: () => call<StorageStats>(IPC.getStorageStats),
 /** 清理前 dry-run：`omp gc` 的候选字节 + 壳侧按年龄阈值的可删字节。 */
 previewStorageCleanup: (olderDays?: number) =>
  call<StoragePreview>(IPC.previewStorageCleanup, { olderDays: olderDays ?? null }),
 /** 执行清理（`dryRun` 时只算不删）。 */
 cleanStorage: (plan: StorageCleanPlan) => call<StorageCleanResult>(IPC.cleanStorage, { plan }),
 /** 立即回收闲置（30 分钟以上）的会话进程，返回回收数量。 */
 reclaimIdleSessions: () => call<number>(IPC.reclaimIdleSessions),
};
