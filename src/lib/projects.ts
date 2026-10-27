import { open } from "@tauri-apps/plugin-dialog";
import { api } from "@shared/api";
import type { ProjectView } from "@shared/types";
import { useApp } from "../stores/app";
import { TEXT } from "./locale";
import { createChatIn } from "./sessionOpen";

/**
 * 添加项目的结果：`null` = 用户取消选择；`ok:false` 由调用方决定提示位置；
 * `ok:true` 带回新建（或已存在的同路径）项目 —— 工作区对话框要拿 id 直接勾为成员。
 */
export type AddProjectResult = { ok: true; project: ProjectView } | { ok: false; message: string } | null;

/** 切换项目的结果：`newSession` 分支的新建失败会把文案带回来，由调用方决定显示位置。 */
export type SwitchProjectResult = { ok: true } | { ok: false; message: string };

/**
 * 「添加项目」的唯一实现：选目录 → 写覆盖层 → 刷新项目列表。
 *
 * 左栏顶部主入口、聊天空态的引导与工作区对话框的「添加本地目录」共用同一份逻辑，
 * 避免多处漂移；只写覆盖层 `projects`，不动任何会话文件（真相仍在 omp 的 sessions 目录）。
 * 工作区树由调用方按需 `loadCheckouts()`（唯一刷新入口）刷新。
 */
export async function pickAndAddProject(): Promise<AddProjectResult> {
 try {
  const dir = await open({ directory: true });
  if (typeof dir !== "string" || !dir) return null;
  const project = await api.addProject(dir);
  const projects = await api.listProjects();
  useApp.getState().set({ projects });
  return { ok: true, project };
 } catch (e) {
  return { ok: false, message: e instanceof Error ? e.message : TEXT[useApp.getState().locale].addProjectFailed };
 }
}

/**
 * 聊天形态：在某个项目（主目录）下开一个新会话并切过去（输入框上方项目下拉用）。
 * 切换的语义是「接下来在这个项目里干活」，不该把该项目里上一个对话的上下文带进来。
 */
export async function startChatInProject(
 projectId: string,
 opts: { projectName?: string } = {},
): Promise<SwitchProjectResult> {
 const p = useApp.getState().projects.find((x) => x.id === projectId);
 if (!p) return { ok: false, message: TEXT[useApp.getState().locale].pickProjectFirst };
 return createChatIn(p.path, { projectName: opts.projectName ?? p.name });
}
