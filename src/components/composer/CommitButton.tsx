import { Check, Loader } from "reicon-react";
import { useApp } from "../../stores/app";
import { isCommitTaskRunning, openCommitPanel } from "../../lib/commitTasks";
import { useText } from "../../lib/useText";

/**
 * 输入卡顶行「提交」入口（分支指示器之后）：点开提交 / 推送浮层（`CommitTaskPanel`）。
 *
 * 任务态与浮层同一条链路、同一套口径：运行中转圈、失败红点（`commitTasks[cwd]` 是唯一真值）；
 * 这里只是把入口带到「刚看完分支名」的手边。
 *
 * 改动状态取自 store 的工作区快照（`workspaceGitStates[cwd]`，**与提交面板同源**——完整
 * `git status --porcelain -b`，含未跟踪新文件；提交走 `add -A`，口径一致）：
 * - 干净、没有待推送、也没有在跑 / 失败的任务 → 置灰（点了也没有可提交或推送的东西）；
 * - 有改动 → 键尾一个 warn 圆点；待推送（`ahead > 0`）→ 照旧可点（浮层里能推送）；
 * - 快照还没回来（未知）→ 不置灰：宁可多亮一会儿，也不把真实改动挡在门外（真裁决在后端预检）。
 */
export function CommitButton({ cwd }: { cwd: string }) {
 const t = useText();
 const task = useApp((s) => s.commitTasks[cwd] ?? null);
 const state = useApp((s) => s.workspaceGitStates[cwd]);
 const running = task ? isCommitTaskRunning(task.phase) : false;
 const failed = task?.phase === "failed";
 // 只有拿到快照、确认工作区干净且无待推送时才禁用；任务在跑 / 失败时一律可点（要能看进度与错误）。
 const disabled = !running && !failed && !!state && !state.dirty && state.ahead <= 0;
 const changed = !!state?.dirty;
 return (
  // title 挂在不禁用的外壳上：disabled 的按钮收不到鼠标事件，提示会显示不出来
  <span className="flex shrink-0" title={disabled ? t.gitCommitDisabledTitle : changed ? t.gitDirtyTitle : undefined}>
   <button
    onClick={() => openCommitPanel(cwd)}
    disabled={disabled}
    className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 whitespace-nowrap transition-colors duration-100 ${
     disabled ? "cursor-not-allowed text-faint" : "cursor-pointer text-muted hover:bg-hover hover:text-foreground"
    }`}
   >
    {running ? (
     <Loader size={12} aria-hidden className="animate-spin" />
    ) : failed ? (
     <span className="size-1.5 shrink-0 rounded-full bg-danger" aria-hidden />
    ) : (
     <Check size={12} aria-hidden className="shrink-0 opacity-70" />
    )}
    {t.gitCommitTitle}
    {changed && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden />}
   </button>
  </span>
 );
}
