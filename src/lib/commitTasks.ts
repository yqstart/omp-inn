import { Channel } from "@tauri-apps/api/core";
import { api } from "@shared/api";
import type { CommitEvent, CommitMode, CommitPhase, CommitTaskView } from "@shared/types";
import { commitContextArg } from "./commitLang";
import { useApp } from "../stores/app";

/**
 * 工作区提交 / 推送的前端编排（V19，后端见 `src-tauri/src/git_commit.rs` / `git_ops.rs`）。
 *
 * 两条轨道：
 * - **快速（默认）**：`generateMessage`（同步勾选 → 一次 `omp -p` 单轮出信息）→ 用户在编辑框里
 *   过目 / 手改 → `commitAndMaybePush`（`git commit` → 可选 `git push`）。秒级；
 * - **完整**：`fullCommit`（`omp commit`，含 CHANGELOG 维护）——慢但功能全。
 *
 * 勾选语义：勾选 = 本次提交包含哪些文件；**生成 / 提交都会先把勾选同步进 git 暂存区**
 * （后端 `git_ops::apply_selection`，提交前还会复查「暂存集合 ⊆ 勾选集合」）。
 */
export function isCommitTaskRunning(phase: CommitPhase): boolean {
 return phase === "checking" || phase === "generating" || phase === "committing" || phase === "pushing";
}

/**
 * 该项目（按工作区归属）当前的提交信息语言 → 给模型的要求文本。
 * `system` 档（或工作区尚未落地）返回 null = 不附加要求。
 */
function contextArgFor(cwd: string): string | null {
 const s = useApp.getState();
 const projectId = s.checkouts.find((w) => w.path === cwd)?.projectId;
 return commitContextArg(projectId ? (s.commitLangPrefs[projectId]?.lang ?? "system") : "system");
}

/** 打开提交面板：落一条本地任务视图（`idle`）+ 拉变更集；已有任务在跑则只聚焦。 */
export function openCommitPanel(cwd: string): void {
 const s = useApp.getState();
 const existing = s.commitTasks[cwd];
 if (existing && isCommitTaskRunning(existing.phase)) {
  s.setActiveCommitCwd(cwd);
  return;
 }
 s.setCommitTask({
  cwd,
  mode: existing?.mode ?? "fast",
  phase: "idle",
  files: [],
  selected: [],
  message: "",
  generated: false,
  log: [],
  commits: [],
  error: null,
  hint: null,
  startedAt: Date.now(),
 });
 s.setActiveCommitCwd(cwd);
 void loadChangeSet(cwd);
}

/**
 * 拉一次变更集并回填（打开面板 / 提交结束后都走它）。
 * 勾选默认 = **已暂存的文件**；一个都没暂存时 = 全部文件（与 Cursor 的口径一致）。
 */
export async function loadChangeSet(cwd: string, preserveTaskResult = false): Promise<void> {
 try {
  const set = await api.getChangeSet(cwd);
  const s = useApp.getState();
  const task = s.commitTasks[cwd];
  if (!task) return;
  const staged = set.files.filter((f) => !f.untracked && f.index !== " ").map((f) => f.path);
  const selected = staged.length > 0 ? staged : set.files.map((f) => f.path);
  s.patchCommitTask(cwd, { files: set.files, selected });
 } catch (err) {
  if (preserveTaskResult) return;
  // 变更集读不到（git 缺失 / 目录没了）：错误留在面板里，不弹窗
  const message = err instanceof Error ? err.message : String(err);
  useApp.getState().patchCommitTask(cwd, { phase: "failed", error: message, hint: null });
 }
}

/** 勾选 / 取消一个文件（运行中忽略）。 */
export function setCommitFileSelected(cwd: string, path: string, on: boolean): void {
 const s = useApp.getState();
 const task = s.commitTasks[cwd];
 if (!task || isCommitTaskRunning(task.phase)) return;
 const selected = on ? [...new Set([...task.selected, path])] : task.selected.filter((p) => p !== path);
 s.patchCommitTask(cwd, { selected });
}

/** 全选 / 全不选（作用在当前文件快照上）。 */
export function selectAllCommitFiles(cwd: string, on: boolean): void {
 const s = useApp.getState();
 const task = s.commitTasks[cwd];
 if (!task || isCommitTaskRunning(task.phase)) return;
 s.patchCommitTask(cwd, { selected: on ? task.files.map((f) => f.path) : [] });
}

/** 编辑提交信息（运行中忽略）。 */
export function setCommitMessage(cwd: string, text: string): void {
 const s = useApp.getState();
 const task = s.commitTasks[cwd];
 if (!task || isCommitTaskRunning(task.phase)) return;
 s.patchCommitTask(cwd, { message: text });
}

/** 切换轨道（运行中忽略）；不动已生成的信息——切回快速轨时它还在。 */
export function setCommitMode(cwd: string, mode: CommitMode): void {
 const s = useApp.getState();
 const task = s.commitTasks[cwd];
 if (!task || isCommitTaskRunning(task.phase)) return;
 s.patchCommitTask(cwd, { mode });
}

/** 快速轨：生成提交信息（先把勾选同步进暂存区；结果流式进编辑框）。 */
export function generateMessage(cwd: string): void {
 const task = useApp.getState().commitTasks[cwd];
 if (!task || isCommitTaskRunning(task.phase) || task.selected.length === 0) return;
 runCommand(
  cwd,
  { phase: "checking", message: "", generated: false },
  { reloadOnExit: false },
  (channel) => api.generateCommitMessage(cwd, task.selected, contextArgFor(cwd), channel),
 );
}

/** 快速轨：提交（可选提交后推送）。消息 = 编辑框里的当前内容。 */
export function commitAndMaybePush(cwd: string, push: boolean): void {
 const task = useApp.getState().commitTasks[cwd];
 if (!task || isCommitTaskRunning(task.phase) || task.selected.length === 0) return;
 if (task.message.trim().length === 0) return;
 runCommand(
  cwd,
  { phase: "checking" },
  { reloadOnExit: true },
  (channel) => api.commitSelected(cwd, task.selected, task.message, push, channel),
 );
}

/** 完整轨：`omp commit`（含 CHANGELOG 维护）。 */
export function fullCommit(cwd: string): void {
 const task = useApp.getState().commitTasks[cwd];
 if (!task || isCommitTaskRunning(task.phase)) return;
 // 完整轨先按勾选同步暂存区（上游见到非空暂存区就不会再 `add -A`）
 runCommand(
  cwd,
  { phase: "checking" },
  { reloadOnExit: true },
  (channel) =>
   api.startFullCommit(
    cwd,
    task.selected.length > 0 ? task.selected : task.files.map((f) => f.path),
    contextArgFor(cwd),
    channel,
   ),
 );
}

/** 推送（行徽章的「待推送」点击、面板里的「推送」都走它）。 */
export function pushWorkspace(cwd: string): void {
 const s = useApp.getState();
 const existing = s.commitTasks[cwd];
 if (existing && isCommitTaskRunning(existing.phase)) return;
 if (!existing) {
  // 从行徽章直接推送：没有面板任务也要有一份视图承接事件
  openCommitPanel(cwd);
 }
 runCommand(cwd, { phase: "checking" }, { reloadOnExit: false }, (channel) =>
  api.pushWorkspace(cwd, channel),
 );
}

/** 取消运行中的任务（终态由后端事件落定）。 */
export function cancelCommitTask(cwd: string): void {
 void api.cancelCommitTask(cwd).catch(() => undefined);
}

/**
 * 关闭浮层：运行中只转后台（任务继续，行徽章指示）；终态顺带清除任务记录
 * （「待推送」由行徽章的 git 快照接管，失败详情属于「已阅即清」）。
 */
export function closeCommitPanel(): void {
 const s = useApp.getState();
 const cwd = s.activeCommitCwd;
 if (cwd) {
  const task = s.commitTasks[cwd];
  if (task && !isCommitTaskRunning(task.phase)) s.dropCommitTask(cwd);
 }
 s.setActiveCommitCwd(null);
}

/** 发起一次任务：重置该任务的运行态 → 接 Channel 事件 → 失败落到 `failed` 视图。 */
function runCommand(
 cwd: string,
 patch: Partial<CommitTaskView>,
 opts: { reloadOnExit: boolean },
 invoke: (channel: Channel<CommitEvent>) => Promise<void>,
): void {
 const s = useApp.getState();
 if (!s.commitTasks[cwd]) return;
 s.patchCommitTask(cwd, { ...patch, error: null, hint: null, commits: [], startedAt: Date.now() });
 const channel = new Channel<CommitEvent>();
 channel.onmessage = (e) => {
  const st = useApp.getState();
  if (e.type === "line") {
   st.appendCommitLog(cwd, e.text);
  } else if (e.type === "delta") {
   st.appendCommitMessage(cwd, e.text);
  } else if (e.type === "message") {
   st.patchCommitTask(cwd, { message: e.text });
  } else if (e.type === "phase") {
   st.patchCommitTask(cwd, { phase: e.phase });
  } else {
   st.finishCommitTask(cwd, e.outcome);
   // 任务结束：该工作区的 git 快照立刻重拉（行徽章从任务态切回 git 真相）。
   void refreshWorkspaceGitState([cwd]);
   // 提交 / 推送可能改变了工作区与暂存区：重拉一次文件列表（行徽章与面板同一真相）
   if (opts.reloadOnExit || e.outcome.phase === "canceled") void loadChangeSet(cwd, e.outcome.phase === "canceled");
  }
 };
 invoke(channel).catch((err) => {
  // 命令本身失败（omp 缺失 / 不是仓库 / BUSY / 没有勾选）：任务落 failed，错误原样展示
  const message = err instanceof Error ? err.message : String(err);
  useApp.getState().finishCommitTask(cwd, {
   phase: "failed",
   commits: [],
   message: null,
   error: message,
   hint: null,
  });
  void refreshWorkspaceGitState([cwd]);
  if (err instanceof Error && "cause" in err && err.cause && typeof err.cause === "object" && "code" in err.cause && ["STAGE_FAILED", "STATUS_FAILED", "STAGE_MISMATCH"].includes(String(err.cause.code))) {
   void loadChangeSet(cwd, true);
  }
 });
}

/** 刷新代际：并发刷新时旧响应不得覆盖新结果。 */
let refreshSeq = 0;

/**
 * 批量刷新工作区 git 快照（行徽章）；`paths` 省略 = 全部未缺失的工作区。失败静默。
 *
 * **git 状态的统一刷新入口**：行徽章与 `get_git_info`（输入卡顶行的分支提示、右栏「变更」的
 * 脏点与 `+X −Y`）在这里一起失效——刷新时机（启动 / 焦点 / 30s 轮询 / π 就绪 / 任务结束 /
 * 分支切换）都是「git 可能变了」的时刻，一律自增 `gitInfoSeq` 让全部已挂载的 `useGitInfo` 重读。
 * 漏掉这一步的后果：提交 / 推送完成后（无论活是本应用、终端还是 agent 干的），分支旁那两个
 * 「有未提交改动」的点会一直亮着——`get_git_info` 的实例除了挂载、手动刷新与切换分支没有别的刷新时机。
 */
export async function refreshWorkspaceGitState(paths?: string[]): Promise<void> {
 const list = paths ?? useApp.getState().checkouts.filter((w) => !w.missing).map((w) => w.path);
 if (list.length === 0) return;
 useApp.setState((s) => ({ gitInfoSeq: s.gitInfoSeq + 1 }));
 const seq = ++refreshSeq;
 try {
  const states = await api.getWorkspaceGitState(list);
  if (seq !== refreshSeq) return;
  const s = useApp.getState();
  s.setWorkspaceGitStates(states);
  // 拉取冲突态对账：冲突时 behind 必然 > 0（双方都有新提交才可能冲突）；
  // 归零 = 合并已经在别处收尾（终端 / 编辑器里 add + commit），徽章不该继续显示冲突。
  for (const st of states) {
   if (st.isRepo && st.behind === 0 && s.pullStates[st.path]?.phase === "conflict") s.clearPullState(st.path);
  }
 } catch {
  // 静默：行徽章是提示，不是关键路径。
 }
}

/** 活刚干完（会话一轮收敛到 idle）时的防抖刷新——最可能有新改动的时点（零轮询成本的聪明时机）。
 *
 *  `paths` 省略 = 全部工作区；给了就只刷这几个（一轮改动只落在本会话目录里，多项目下不白跑）。
 *  防抖 2s，多次调用**合并**（一轮收尾常连着几帧状态；全量优先于局部，不会互相顶掉）。 */
let readyTimer: number | undefined;
/** 待刷新目录；null = 全量。 */
let readyPaths: Set<string> | null = null;
export function scheduleWorkspaceGitRefresh(paths?: string[], delayMs = 2000): void {
 if (!paths) readyPaths = null;
 else if (readyPaths) for (const p of paths) readyPaths.add(p);
 else readyPaths = new Set(paths);
 clearTimeout(readyTimer);
 readyTimer = window.setTimeout(() => {
  readyTimer = undefined;
  const pending = readyPaths;
  readyPaths = null;
  void refreshWorkspaceGitState(pending ? [...pending] : undefined);
 }, delayMs);
}

/**
 * 行徽章的兜底轮询：**可见时每 30s 一轮**（页隐藏跳过；上一轮没回来就跳过这一轮）。
 * 为什么需要它：在终端里跑 git 命令（agent 自己跑、或用户手敲）不改变 omp 的 π 状态，
 * 「π 转就绪」那个时机等不到——左栏徽章会一直停在旧值。
 * 返回清理函数（`App` 的 useEffect 直接返回它；重复调用 = 重启计时器）。
 */
let pollTimer: number | undefined;
let pollBusy = false;
export function startWorkspaceGitPolling(intervalMs = 30_000): () => void {
 if (pollTimer !== undefined) window.clearInterval(pollTimer);
 pollTimer = window.setInterval(() => {
  if (document.hidden || pollBusy) return;
  pollBusy = true;
  void refreshWorkspaceGitState().finally(() => {
   pollBusy = false;
  });
 }, intervalMs);
 return () => {
  if (pollTimer !== undefined) window.clearInterval(pollTimer);
  pollTimer = undefined;
 };
}
