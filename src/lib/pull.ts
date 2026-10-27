import { openPath } from "@tauri-apps/plugin-opener";
import { api } from "@shared/api";
import { useApp } from "../stores/app";
import { refreshWorkspaceGitState } from "./commitTasks";
import { relativeToCwd } from "./workspaceFiles";

/**
 * 拉取远程更新（左栏项目分组头的「远程有 N 个新提交」徽章点击）。
 *
 * 口径（用户口径）：
 * - **无冲突直接更新合并代码**：后端 `git pull --no-rebase --ff --no-edit`——能快进就快进，
 *   分叉就合并（不 rebase），合并提交用 git 自动生成的信息；
 * - **有冲突就去编辑器解决**：后端保留合并态并返回冲突文件绝对路径，这里立刻用系统默认
 *   程序打开第一个冲突文件，同时弹出冲突清单（逐个打开 / 继续合并 / 放弃合并）；
 * - 失败（网络 / 权限 / 本地改动会被覆盖）：git 原文落进 `pullStates`，徽章转成警告色，
 *   悬停看原因、点击重试。
 *
 * 同一工作区的拉取不重入（徽章在 running 时不可点）。
 */
export async function pullWorkspace(cwd: string): Promise<void> {
 const state = useApp.getState().pullStates[cwd];
 if (state?.phase === "running") return;
 useApp.getState().setPullState(cwd, { phase: "running", conflicts: [], error: null });
 try {
  const out = await api.pullWorkspace(cwd);
  // 拉取改变了分支位置 / 工作区文件：走统一刷新入口，行徽章与输入卡顶行一起重读
  void refreshWorkspaceGitState([cwd]);
  if (out.status === "conflicts" && out.conflicts.length > 0) {
   const st = useApp.getState();
   st.setPullState(cwd, { phase: "conflict", conflicts: out.conflicts, error: null });
   st.setPullConflictCwd(cwd);
   // 「有冲突就去编辑器解决」：自动用系统默认程序打开第一个冲突文件；
   // 打开失败不打扰（未知文件类型 / 没有关联程序），清单里还能逐个点开。
   void openPath(out.conflicts[0]).catch(() => undefined);
   return;
  }
  useApp.getState().clearPullState(cwd);
 } catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  useApp.getState().setPullState(cwd, { phase: "error", conflicts: [], error: message });
 }
}

/** 冲突解决后继续合并：后端把未标记解决的冲突文件 `add` 进来，再用合并信息提交。 */
export async function continueMerge(cwd: string): Promise<void> {
 await api.continueMerge(cwd);
 const st = useApp.getState();
 st.clearPullState(cwd);
 if (st.pullConflictCwd === cwd) st.setPullConflictCwd(null);
 void refreshWorkspaceGitState([cwd]);
}

/** 放弃这次合并（工作区恢复回拉取前）；冲突状态一并清掉。 */
export async function abortMerge(cwd: string): Promise<void> {
 await api.abortMerge(cwd);
 const st = useApp.getState();
 st.clearPullState(cwd);
 if (st.pullConflictCwd === cwd) st.setPullConflictCwd(null);
 void refreshWorkspaceGitState([cwd]);
}

/** 关闭冲突清单浮层（只收起界面；合并态仍在，徽章继续提示）。 */
export function closePullConflict(): void {
 useApp.getState().setPullConflictCwd(null);
}

/** 冲突文件在项目目录下的展示路径（不在其下时原样给绝对路径）。 */
export function conflictLabel(cwd: string, path: string): string {
 return relativeToCwd(cwd, path) ?? path;
}
