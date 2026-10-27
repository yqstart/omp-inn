import { useRef, useState } from "react";
import { FolderPlus } from "reicon-react";
import type { ProjectView, WorkspaceView } from "@shared/types";
import { api } from "@shared/api";
import { useApp } from "../../stores/app";
import { pickAndAddProject } from "../../lib/projects";
import { useText } from "../../lib/useText";
import { fmt } from "../../lib/locale";
import { DialogShell } from "../settings/DialogShell";
import { ConfirmDialog } from "../ConfirmDialog";

/**
 * 工作区（V21 多项目容器）的新建 / 编辑对话框：名字 + 成员项目勾选。
 *
 * - `group = null` → 新建；否则编辑（保存 + 删除工作区）。
 * - **可直接添加本地目录**：区头的「添加本地目录」走 `pickAndAddProject`（与左栏「添加项目」
 *   同一实现），新项目立刻出现在列表里并**自动勾选**为成员——不必退出对话框先去左栏加项目。
 * - 成员勾选就是 `workspaceId` 归属：一个项目最多属于一个工作区——已在别的组里的项目
 *   被勾进来会**改归属**（行尾标出它当前所在的组，勾选前先让人看见）。
 * - 删除工作区 = 成员回归未分组（danger 二次确认；不删项目、不动文件）。
 * - 失败就地显示在对话框里：模态遮着侧栏，错误条放到外面会看不见。
 */
export function WorkspaceGroupDialog({
 group,
 onClose,
 onChanged,
}: {
 group: WorkspaceView | null;
 onClose: () => void;
 onChanged: () => Promise<void> | void;
}) {
 const t = useText();
 const projects = useApp((s) => s.projects);
 const groups = useApp((s) => s.workspaceGroups);
 const [name, setName] = useState(group?.name ?? "");
 const [picked, setPicked] = useState<Set<string>>(() => new Set(group?.projectIds ?? []));
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState<string | null>(null);
 const [confirmDelete, setConfirmDelete] = useState(false);
 const nameRef = useRef<HTMLInputElement>(null);

 const toggle = (id: string) => {
  setPicked((cur) => {
   const next = new Set(cur);
   if (next.has(id)) next.delete(id);
   else next.add(id);
   return next;
  });
 };

 /** 该项目当前所属的组名（不在本组时显示；null = 未分组或就是本组）。 */
 const foreignGroup = (p: ProjectView): string | null => {
  if (p.workspaceId === null || p.workspaceId === group?.id) return null;
  return groups.find((g) => g.id === p.workspaceId)?.name ?? null;
 };

 /** 就地添加本地目录为项目（复用左栏的 `pickAndAddProject`），并勾选为成员。 */
 const addLocalDirectory = async () => {
  if (busy) return;
  setBusy(true);
  try {
   const res = await pickAndAddProject();
   if (res === null) return; // 用户取消选择：不是错误
   if (!res.ok) {
    setError(res.message);
    return;
   }
   setError(null);
   setPicked((cur) => new Set(cur).add(res.project.id));
   // 新项目还没有目录行（checkouts）：让左栏跟着刷新一次——即使随后取消对话框，
   // 新项目也已经出现在左栏（与左栏「添加项目」的行为一致）。
   await onChanged();
  } finally {
   setBusy(false);
  }
 };

 const submit = async () => {
  if (busy) return;
  setBusy(true);
  setError(null);
  try {
   if (group) await api.updateWorkspace(group.id, name, [...picked]);
   else await api.createWorkspace(name, [...picked]);
   await onChanged();
   onClose();
  } catch (e) {
   setError(e instanceof Error ? e.message : t.wsGroupFailed);
   setBusy(false);
  }
 };

 const remove = async () => {
  if (!group || busy) return;
  setBusy(true);
  setError(null);
  try {
   await api.deleteWorkspace(group.id);
   await onChanged();
   onClose();
  } catch (e) {
   setError(e instanceof Error ? e.message : t.wsGroupFailed);
   setBusy(false);
  }
 };

 return (
  <DialogShell
   title={group ? fmt(t.wsGroupEditTitle, group.name) : t.wsGroupNew}
   onClose={onClose}
   width="max-w-lg"
   initialFocusRef={nameRef}
  >
   <div className="space-y-4">
    <label className="block">
     <span className="text-[12px] font-medium text-muted">{t.wsGroupNameLabel}</span>
     <input
      ref={nameRef}
      value={name}
      onChange={(e) => setName(e.target.value)}
      placeholder={t.wsGroupNamePlaceholder}
      disabled={busy}
      className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-foreground outline-none transition-colors duration-100 placeholder:text-faint focus:border-accent/50"
     />
    </label>
    <div>
     <div className="flex items-center gap-2">
      <span className="text-[12px] font-medium text-muted">{t.wsGroupMembers}</span>
      <span className="flex-1" />
      <button
       type="button"
       onClick={() => void addLocalDirectory()}
       disabled={busy}
       aria-label={t.wsGroupAddDirectory}
       title={t.wsGroupAddDirectory}
       className="flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
       <FolderPlus size={12} aria-hidden />
       {t.wsGroupAddDirectory}
      </button>
     </div>
     {projects.length > 0 && (
      <ul className="mt-1 max-h-64 space-y-0.5 overflow-y-auto">
       {projects.map((p) => (
        <li key={p.id}>
         <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors duration-100 hover:bg-hover">
          <input
           type="checkbox"
           checked={picked.has(p.id)}
           onChange={() => toggle(p.id)}
           disabled={busy}
           className="size-3.5 shrink-0 accent-accent"
          />
          <span className="min-w-0 flex-1 truncate text-[13px]">{p.name}</span>
          {foreignGroup(p) !== null && (
           <span className="shrink-0 rounded-sm border border-border-soft bg-surface/60 px-1.5 py-px text-[10px] leading-4 text-warn">
            {foreignGroup(p)}
           </span>
          )}
          <span className="max-w-[45%] shrink-0 truncate font-mono text-[10px] text-faint" title={p.path}>
           {p.path}
          </span>
         </label>
        </li>
       ))}
      </ul>
     )}
    </div>
    {error && (
     <p role="alert" className="rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-[12px] leading-relaxed text-danger">
      {error}
     </p>
    )}
    <div className="flex items-center gap-2 border-t border-border-soft pt-3">
     {group && (
      <button
       type="button"
       onClick={() => setConfirmDelete(true)}
       disabled={busy}
       className="cursor-pointer rounded-md border border-danger/25 bg-danger/10 px-3.5 py-1.5 text-[13px] text-danger transition-colors duration-100 hover:bg-danger/15 disabled:opacity-50"
      >
       {t.wsGroupDelete}
      </button>
     )}
     <span className="flex-1" />
     <button
      type="button"
      onClick={onClose}
      disabled={busy}
      className="cursor-pointer rounded-md border border-border px-3.5 py-1.5 text-[13px] transition-colors duration-100 hover:bg-hover disabled:opacity-50"
     >
      {t.cancel}
     </button>
     <button
      type="button"
      onClick={() => void submit()}
      disabled={busy || name.trim().length === 0}
      className="cursor-pointer rounded-md border border-transparent bg-primary px-3.5 py-1.5 text-[13px] font-medium text-primary-foreground transition-colors duration-100 hover:opacity-90 disabled:opacity-50"
     >
      {group ? t.wsGroupSave : t.wsGroupCreate}
     </button>
    </div>
   </div>
   <ConfirmDialog
    open={confirmDelete}
    danger
    title={fmt(t.wsGroupDeleteTitle, group?.name ?? "")}
    detail={t.wsGroupDeleteBody}
    confirmLabel={t.wsGroupDelete}
    onConfirm={() => {
     setConfirmDelete(false);
     void remove();
    }}
    onCancel={() => setConfirmDelete(false)}
   />
  </DialogShell>
 );
}
