import { useRef, useState } from "react";
import { Check, Loader, Plus, Trash2 } from "reicon-react";
import type { ModelInfo, ModelRolesInfo } from "@shared/types";
import {
 BUILTIN_ROLE_IDS,
 roleProfileKeys,
 roleProfileNameTaken,
 type RoleProfile,
 type RoleProfilesState,
} from "../../lib/roleProfiles";
import { fmt } from "../../lib/locale";
import { roleLabel } from "../../lib/roleNames";
import { splitSelector, withLevel } from "../../lib/modelSelector";
import { thinkingLevelsOf, THINKING_ORDER } from "../../lib/thinking";
import { useText } from "../../lib/useText";
import { ConfirmDialog } from "../ConfirmDialog";
import { EnumSelect, LEVEL_TRIGGER_CLASS } from "./EnumSelect";
import { DialogShell } from "./DialogShell";
import { ModelPickerDialog } from "./ModelPickList";

/**
 * 设置 › 模型 ›「模型角色」区块（多套模型配置，2026-10-20 用户口径）。
 *
 * 形态：**配置列表在页面上，角色配置在弹窗里**（2026-10-20 第二轮用户口径：不要在行内展开编辑）。
 * - 列表行 = 名称 + 角色摘要（N 个角色 · 前两个角色 → selector）+ 激活态 + 删除；
 *   点击行打开该套配置的编辑弹窗。
 * - **同一时间恰好一套激活**：激活 = 把该配置的角色表整表写进 omp（父组件 `onActivate`）；
 *   激活中的配置不允许删除（先激活另一套）。未激活配置的修改只落在本机存储。
 * - 新建 = **同一个弹窗的「新建」模式**：名称 + 角色一起配，创建后这套配置未激活。
 * - 角色行本身沿用旧实现（行内选模型 / 思考档），只是写入目标从 omp 全局换成了
 *   「当前编辑的这套配置」——激活配置由父组件写 omp 并回读收敛。
 *
 * 数据与迁移口径见 `src/lib/roleProfiles.ts`；omp 只有一张 `modelRoles`，
 * 「多套」是壳侧概念，只有激活那套真正生效。
 */

type Props = {
 /** omp 当前全局角色表（激活配置的真值）；`null` = 尚未读到。 */
 roles: ModelRolesInfo | null;
 rolesError: string | null;
 cycleError: string | null;
 busy: boolean;
 /** 有角色写入在飞（激活 / 编辑激活配置）：锁住所有写操作。 */
 saving: boolean;
 profiles: RoleProfilesState | null;
 candidates: ModelInfo[];
 catalog: ModelInfo[];
 myModels: string[];
 onToggleStar: (selector: string) => void;
 onRetry: () => void;
 /** 新建一套配置（名称 + 弹窗里已配好的角色）；父组件负责落盘。 */
 onCreate: (name: string, roles: Record<string, string>) => void;
 onRename: (id: string, name: string) => void;
 onDelete: (id: string) => void;
 /** 激活一套配置：写 omp 成功后才更新本地激活位；失败时抛错。 */
 onActivate: (id: string) => Promise<void>;
 /** 改一套配置里的一个角色；激活配置会写 omp，失败时抛错。 */
 onEditRole: (id: string, role: string, selector: string | null) => Promise<void>;
};

export function RoleProfilesSection({
 roles,
 rolesError,
 cycleError,
 busy,
 saving,
 profiles,
 candidates,
 catalog,
 myModels,
 onToggleStar,
 onRetry,
 onCreate,
 onRename,
 onDelete,
 onActivate,
 onEditRole,
}: Props) {
 const t = useText();
 const [editingId, setEditingId] = useState<string | null>(null);
 const [creating, setCreating] = useState(false);
 const [pendingDelete, setPendingDelete] = useState<RoleProfile | null>(null);
 const [listActionError, setListActionError] = useState<string | null>(null);
 const [activatingId, setActivatingId] = useState<string | null>(null);

 const list = profiles?.profiles ?? [];
 const activeId = profiles?.activeId ?? "";
 const editing = editingId ? (list.find((p) => p.id === editingId) ?? null) : null;
 const locked = saving || activatingId !== null;
 const builtin = roles?.builtin?.length ? roles.builtin : [...BUILTIN_ROLE_IDS];

 /** 列表行上的「激活」：不打开弹窗的快捷切换入口。 */
 const activate = async (id: string) => {
  if (id === activeId || activatingId !== null) return;
  setActivatingId(id);
  setListActionError(null);
  try {
   await onActivate(id);
  } catch (e) {
   setListActionError(e instanceof Error ? e.message : String(e || t.roleSetFailed));
  } finally {
   setActivatingId(null);
  }
 };

 const openEdit = (id: string) => {
  setListActionError(null);
  setEditingId(id);
 };

 const openCreate = () => {
  setListActionError(null);
  setCreating(true);
 };

 const confirmDelete = () => {
  if (!pendingDelete) return;
  onDelete(pendingDelete.id);
  if (editingId === pendingDelete.id) setEditingId(null);
  setPendingDelete(null);
 };

 return (
  <>
   <section aria-label={t.rolesSection} className="mt-6 shrink-0">
    <div className="flex flex-wrap items-center gap-2">
     <h3 className="text-xs font-medium text-muted">{t.rolesSection}</h3>
     <button
      type="button"
      onClick={openCreate}
      disabled={profiles === null || locked}
      className="ml-auto flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 text-[12px] font-medium transition-colors duration-100 hover:bg-hover disabled:opacity-40"
     >
      <Plus size={12} aria-hidden />
      {t.roleProfilesNew}
     </button>
    </div>
    <SectionNotices
     roles={roles}
     rolesError={rolesError}
     cycleError={cycleError}
     storageProject={roles?.storage === "project"}
     actionError={listActionError}
     busy={busy}
     onRetry={onRetry}
    />
    <div className="mt-1 divide-y divide-border-soft">
     {profiles === null ? (
      rolesError ? null : (
       <div className="py-2 text-[13px] text-muted">{t.archivedLoading}</div>
      )
     ) : list.length === 0 ? (
      <p className="py-2 text-[13px] text-muted">{t.roleProfilesEmpty}</p>
     ) : (
      list.map((p) => {
       const active = p.id === activeId;
       return (
        <div key={p.id} className="flex min-h-11 flex-wrap items-center gap-2 py-2.5">
         <button
          type="button"
          onClick={() => openEdit(p.id)}
          aria-label={fmt(t.roleProfilesEditAria, p.name)}
          aria-haspopup="dialog"
          className="flex min-w-0 flex-1 cursor-pointer items-center text-left"
         >
          <span className="block min-w-0 flex-1 truncate text-sm">{p.name}</span>
         </button>
         {active ? (
          <span className="flex shrink-0 items-center gap-1 text-[12px] text-accent">
           <Check size={12} aria-hidden />
           {t.roleProfilesActive}
          </span>
         ) : (
          <button
           type="button"
           onClick={() => void activate(p.id)}
           disabled={locked}
           aria-label={fmt(t.roleProfilesActivateAria, p.name)}
           className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 text-[12px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground disabled:opacity-50"
          >
           {activatingId === p.id ? (
            <Loader size={12} className="animate-spin" aria-hidden />
           ) : (
            <span className="h-3 w-3 rounded-full border border-current" aria-hidden />
           )}
           {t.roleProfilesActivate}
          </button>
         )}
         <span
          className="shrink-0"
          title={active ? t.roleProfilesDeleteActiveHint : undefined}
         >
          <button
           type="button"
           onClick={() => setPendingDelete(p)}
           disabled={active || locked}
           aria-label={fmt(t.roleProfilesDeleteAria, p.name)}
           className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-faint transition-colors duration-100 hover:bg-hover hover:text-danger disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-faint"
          >
           <Trash2 size={13} aria-hidden />
          </button>
         </span>
        </div>
       );
      })
     )}
    </div>
   </section>

   {editing && (
    <RoleProfileDialog
     key={editing.id}
     mode="edit"
     profile={editing}
     profiles={list}
     builtin={builtin}
     candidates={candidates}
     catalog={catalog}
     myModels={myModels}
     onToggleStar={onToggleStar}
     active={editing.id === activeId}
     saving={saving}
     onClose={() => setEditingId(null)}
     onRename={(name) => onRename(editing.id, name)}
     onActivate={() => onActivate(editing.id)}
     onEditRole={(role, selector) => onEditRole(editing.id, role, selector)}
    />
   )}

   {creating && (
    <RoleProfileDialog
     key="new"
     mode="new"
     profiles={list}
     builtin={builtin}
     candidates={candidates}
     catalog={catalog}
     myModels={myModels}
     onToggleStar={onToggleStar}
     onClose={() => setCreating(false)}
     onCreate={(name, roles) => {
      onCreate(name, roles);
      setCreating(false);
     }}
    />
   )}

   <ConfirmDialog
    open={pendingDelete !== null}
    title={t.roleProfilesDeleteTitle}
    detail={pendingDelete ? fmt(t.roleProfilesDeleteDetail, pendingDelete.name) : undefined}
    confirmLabel={t.delete}
    cancelLabel={t.cancel}
    danger
    onConfirm={confirmDelete}
    onCancel={() => setPendingDelete(null)}
   />
  </>
 );
}

/** 建议的新配置名：从「配置 1」开始找第一个没被占用的。 */
function suggestProfileName(profiles: RoleProfile[], t: ReturnType<typeof useText>): string {
 const taken = new Set(profiles.map((p) => p.name));
 let n = 1;
 while (taken.has(fmt(t.roleProfilesNewName, String(n)))) n += 1;
 return fmt(t.roleProfilesNewName, String(n));
}

/** 区块级提示：omp 读取失败 / 设置过期 / 轮换序同步 / 列表激活错误 / project 存储。 */
function SectionNotices({
 roles,
 rolesError,
 cycleError,
 storageProject,
 actionError,
 busy,
 onRetry,
}: {
 roles: ModelRolesInfo | null;
 rolesError: string | null;
 cycleError: string | null;
 storageProject: boolean;
 actionError: string | null;
 busy: boolean;
 onRetry: () => void;
}) {
 const t = useText();
 return (
  <>
   {storageProject && (
    <p className="mt-2 rounded border border-warn/40 bg-warn/5 px-2 py-1.5 text-[13px] text-warn">
     {t.roleStorageProject}
    </p>
   )}
   {rolesError && roles === null && (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-danger/40 bg-danger/5 px-3 py-2">
     <p role="alert" className="min-w-0 flex-1 text-[13px] text-danger">{rolesError}</p>
     <button
      type="button"
      onClick={onRetry}
      disabled={busy}
      className="cursor-pointer rounded-md border border-border px-3 py-1 text-[12px] transition-colors duration-100 hover:bg-hover disabled:opacity-50"
     >
      {t.retry}
     </button>
    </div>
   )}
   {rolesError && roles !== null && (
    <p role="alert" className="mt-2 rounded border border-warn/40 bg-warn/5 px-2 py-1.5 text-[13px] text-warn">
     {t.ompSettingsStale}：{rolesError}
    </p>
   )}
   {cycleError && (
    <p role="alert" className="mt-2 rounded border border-warn/40 bg-warn/5 px-2 py-1.5 text-[13px] text-warn">
     {cycleError}
    </p>
   )}
   {actionError && (
    <p role="alert" className="mt-2 rounded border border-danger/40 bg-danger/5 px-3 py-2 text-[13px] text-danger">
     {actionError}
    </p>
   )}
  </>
 );
}

/**
 * 新建 / 编辑一套模型配置的弹窗（同一个组件两种模式）：
 * - **edit**：名称 + 激活态 + 角色行，改动即时保存（激活配置写 omp）；底部「完成」关闭。
 * - **new**：名称（默认「配置 N」、自动全选）+ 空角色表，角色改动先留在弹窗内；底部「创建」
 *   一次性写入本机，创建后不自动激活。
 *
 * 弹窗自身滚动：标题区（名称 / 提示 / 错误）与底部动作条固定，只有角色清单滚（`bodyScroll=false`）。
 * 角色选模型 / 思考档的浮层与模型弹窗都挂在当前最上层模态里（`useDropdown` / `DialogShell` 口径），
 * 嵌套在这个编辑弹窗里仍能正常开合。
 */
function RoleProfileDialog({
 mode,
 profile,
 profiles,
 builtin,
 candidates,
 catalog,
 myModels,
 onToggleStar,
 active = false,
 saving = false,
 onClose,
 onRename,
 onActivate,
 onEditRole,
 onCreate,
}: {
 mode: "new" | "edit";
 profile?: RoleProfile;
 profiles: RoleProfile[];
 builtin: string[];
 candidates: ModelInfo[];
 catalog: ModelInfo[];
 myModels: string[];
 onToggleStar: (selector: string) => void;
 active?: boolean;
 /** 父组件的写入状态（激活 / 编辑激活配置）；新建模式不涉及 omp，恒为 false。 */
 saving?: boolean;
 onClose: () => void;
 onRename?: (name: string) => void;
 onActivate?: () => Promise<void>;
 onEditRole?: (role: string, selector: string | null) => Promise<void>;
 onCreate?: (name: string, roles: Record<string, string>) => void;
}) {
 const t = useText();
 const nameRef = useRef<HTMLInputElement>(null);
 const nameSelected = useRef(false);
 const [nameDraft, setNameDraft] = useState(() =>
  mode === "edit" && profile ? profile.name : suggestProfileName(profiles, t),
 );
 const [nameError, setNameError] = useState<string | null>(null);
 const [actionError, setActionError] = useState<string | null>(null);
 const [draftRoles, setDraftRoles] = useState<Record<string, string>>({});
 const [activating, setActivating] = useState(false);

 const roles = mode === "edit" && profile ? profile.roles : draftRoles;
 const keys = roleProfileKeys({ id: profile?.id ?? "draft", name: nameDraft, roles }, builtin);

 /** 名称校验 + 编辑态提交；返回去掉首尾空白的合法名称（非法时返回 null 并就地报错）。 */
 const commitName = (): string | null => {
  const name = nameDraft.trim();
  if (!name) {
   setNameError(t.roleProfilesNameEmpty);
   return null;
  }
  if (roleProfileNameTaken(profiles, name, profile?.id)) {
   setNameError(t.roleProfilesNameTaken);
   return null;
  }
  setNameError(null);
  setNameDraft(name);
  if (mode === "edit" && profile && name !== profile.name) onRename?.(name);
  return name;
 };

 const saveRole = async (role: string, selector: string | null) => {
  setActionError(null);
  if (mode === "new") {
   // 新建弹窗里先只改草稿；点「创建」才落本机（取消即丢弃）
   setDraftRoles((prev) => {
    const next = { ...prev };
    const value = selector?.trim();
    if (value) next[role] = value;
    else delete next[role];
    return next;
   });
   return;
  }
  try {
   await onEditRole?.(role, selector);
  } catch (e) {
   setActionError(e instanceof Error ? e.message : String(e || t.roleSetFailed));
  }
 };

 const activate = async () => {
  if (!onActivate) return;
  setActivating(true);
  setActionError(null);
  try {
   await onActivate();
  } catch (e) {
   setActionError(e instanceof Error ? e.message : String(e || t.roleSetFailed));
  } finally {
   setActivating(false);
  }
 };

 const create = () => {
  const name = commitName();
  if (name) onCreate?.(name, draftRoles);
 };

 const done = () => {
  if (commitName()) onClose();
 };

 const hint =
  mode === "new"
   ? t.roleProfilesCreateHint
   : active
     ? t.roleProfilesActiveHint
     : Object.keys(roles).length === 0
       ? t.roleProfilesInactiveEmptyHint
       : t.roleProfilesInactiveHint;

 return (
  <DialogShell
   title={mode === "new" ? t.roleProfilesNewTitle : t.roleProfilesEditTitle}
   onClose={onClose}
   width="max-w-2xl"
   bodyScroll={false}
   initialFocusRef={mode === "new" ? nameRef : undefined}
  >
   <div className="shrink-0">
    <div className="flex flex-wrap items-center gap-2">
     <div className="min-w-0 basis-full @min-[600px]/panel:flex-1 @min-[600px]/panel:basis-0">
      <input
       ref={nameRef}
       value={nameDraft}
       onChange={(e) => {
        setNameDraft(e.target.value);
        if (nameError) setNameError(null);
       }}
       onBlur={() => {
        commitName();
       }}
       onFocus={(e) => {
        // 新建时默认名是建议值：只在首次自动聚焦时全选，之后点回来不再整段选中
        if (mode === "new" && !nameSelected.current) {
         nameSelected.current = true;
         e.currentTarget.select();
        }
       }}
       onKeyDown={(e) => {
        if (e.key === "Enter") {
         e.preventDefault();
         commitName();
        }
        // Esc 交给 DialogShell（关闭弹窗）：名称只在失焦 / Enter 时提交，
        // 直接关掉不会把半截草稿写进去。
       }}
       aria-label={t.roleProfilesName}
       placeholder={t.roleProfilesNamePlaceholder}
       maxLength={40}
       className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[13px] transition-colors duration-100 focus:border-accent aria-invalid:border-danger"
       aria-invalid={nameError !== null}
      />
     </div>
     {mode === "edit" &&
      (active ? (
       <span className="flex shrink-0 items-center gap-1 text-[12px] text-accent">
        <Check size={12} aria-hidden />
        {t.roleProfilesActive}
       </span>
      ) : (
       <button
        type="button"
        onClick={() => void activate()}
        disabled={saving || activating}
        className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 text-[12px] transition-colors duration-100 hover:bg-hover disabled:opacity-50"
       >
        {activating && <Loader size={12} className="animate-spin" aria-hidden />}
        {t.roleProfilesActivateHere}
       </button>
      ))}
    </div>
    {nameError && (
     <p role="alert" className="mt-1 text-[12px] text-danger">{nameError}</p>
    )}
    <p className="mt-1 text-[12px] text-faint">{hint}</p>
    {actionError && (
     <p role="alert" className="mt-2 rounded border border-danger/40 bg-danger/5 px-3 py-2 text-[13px] text-danger">
      {actionError}
     </p>
    )}
   </div>
   <div className="mt-2 min-h-0 flex-1 divide-y divide-border-soft overflow-y-auto">
    {keys.map((role) => (
     <RoleRow
      key={role}
      role={role}
      label={roleLabel(role, t)}
      current={roles[role] ?? null}
      models={candidates}
      catalog={catalog}
      myModels={myModels}
      onToggleStar={onToggleStar}
      disabled={mode === "edit" && saving}
      onSave={saveRole}
     />
    ))}
   </div>
   <div className="mt-3 flex shrink-0 items-center justify-end gap-2 border-t border-border-soft pt-3">
    {mode === "new" ? (
     <>
      <button
       type="button"
       onClick={onClose}
       className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[13px] transition-colors duration-100 hover:bg-hover"
      >
       {t.cancel}
      </button>
      <button
       type="button"
       onClick={create}
       className="cursor-pointer rounded-md border border-transparent bg-primary px-3.5 py-1.5 text-[13px] font-medium text-primary-foreground transition-colors duration-100 hover:opacity-90"
      >
       {t.roleProfilesCreate}
      </button>
     </>
    ) : (
     <button
      type="button"
      onClick={done}
      className="cursor-pointer rounded-md border border-transparent bg-primary px-3.5 py-1.5 text-[13px] font-medium text-primary-foreground transition-colors duration-100 hover:opacity-90"
     >
      {t.roleProfilesDone}
     </button>
    )}
   </div>
  </DialogShell>
 );
}

/**
 * 一行角色：角色名 + 当前 selector（模型 + 档位）+ 档位下拉 + 「选择」按钮（开模型选择弹窗）。
 *  模型列表走 `ModelPickerDialog`、思考档走 `EnumSelect` 浮层——**都不做行内展开**：
 *  行内展开会把弹窗里的角色整体推下去（点开 / 关上时页面跳动，用户实测）。
 */
function RoleRow({
 role,
 label,
 current,
 models,
 catalog,
 myModels,
 onToggleStar,
 disabled,
 onSave,
}: {
 role: string;
 label: string;
 current: string | null;
 models: ModelInfo[];
 catalog: ModelInfo[];
 myModels: string[];
 onToggleStar: (selector: string) => void;
 disabled: boolean;
 onSave: (role: string, selector: string | null) => Promise<void>;
}) {
 const t = useText();
 const [pickerOpen, setPickerOpen] = useState(false);
 const [saving, setSaving] = useState(false);

 // 角色值 = 模型 selector + 可选的 `:思考档` 后缀；两截分开显示、分开改
 const { base, level } = splitSelector(current ?? "");
 // 档位候选按该模型声明的档裁剪；目录里查不到（自定义 / 角色别名）退回全集——不挡用户，
 // 非法档 omp 自己会忽略，但界面不给一个必然无效的窄集合
 const model = catalog.find((m) => m.selector === base);
 const levels = model ? thinkingLevelsOf(model.thinking) : [...THINKING_ORDER];
 // 明确不支持思考的模型（可用档只有 off）不显示档位按钮，免得点开只有「默认 / off」两项
 const canLevel = current !== null && levels.length > 1;

 const pick = async (m: ModelInfo) => {
  setPickerOpen(false);
  setSaving(true);
  await onSave(role, m.selector);
  setSaving(false);
 };

 const setLevel = async (lv: string | null) => {
  setSaving(true);
  await onSave(role, withLevel(base, lv));
  setSaving(false);
 };

 const clear = async () => {
  setSaving(true);
  await onSave(role, null);
  setSaving(false);
 };

 return (
  <div className="py-2.5">
   <div className="flex min-h-11 flex-wrap items-center gap-2">
    <div className="min-w-0 basis-full @min-[600px]/panel:w-32 @min-[600px]/panel:basis-auto">
     <div className="truncate text-sm">{label}</div>
     {label !== role && <div className="font-mono text-xs text-muted">{role}</div>}
    </div>
    <div className="min-w-0 basis-full font-mono text-xs break-all @min-[600px]/panel:flex-1 @min-[600px]/panel:basis-0">
     {current ? (
      <span>
       {base}
       {level && <span className="ml-1 rounded border border-border px-1 text-[10px]">{level}</span>}
      </span>
     ) : (
      <span className="text-muted">{t.roleUnset}</span>
     )}
    </div>
    {canLevel && (
     /* 思考档 = 浮层下拉（`EnumSelect`）：空值档 = 「不写后缀」，交给 omp 自己的
        `defaultThinkingLevel`，所以 `value` 用空串、`display` 显示「默认」 */
     <EnumSelect
      label={fmt(t.roleLevelAria, label)}
      value={level ?? ""}
      display={level ?? t.roleLevelDefault}
      choices={[
       { value: "", label: t.roleLevelDefault },
       ...levels.map((lv) => ({ value: lv, label: lv })),
      ]}
      disabled={saving || disabled}
      triggerTitle={t.roleLevelDefaultHint}
      triggerClassName={LEVEL_TRIGGER_CLASS}
      onPick={(lv) => void setLevel(lv === "" ? null : lv)}
     />
    )}
    <button
     onClick={() => setPickerOpen(true)}
     disabled={saving || disabled}
     className="shrink-0 cursor-pointer rounded-md border border-border px-2.5 py-1 text-[13px] transition-colors duration-100 hover:bg-hover disabled:opacity-50"
     aria-label={fmt(t.rolePick + " {0}", label)}
     aria-haspopup="dialog"
    >
     {t.rolePick}
    </button>
    {current && (
     <button
      onClick={() => void clear()}
      disabled={saving || disabled}
      className="shrink-0 cursor-pointer rounded-md border border-border px-2.5 py-1 text-[13px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground disabled:opacity-50"
      aria-label={fmt(t.roleClear + " {0}", label)}
     >
      {t.roleClear}
     </button>
    )}
    {saving && <Loader size={12} className="shrink-0 animate-spin text-muted" aria-hidden />}
   </div>

   {pickerOpen && (
    <ModelPickerDialog
     title={fmt(t.pickModelTitle + " · {0}", label)}
     models={models}
     selected={base}
     onPick={(m) => void pick(m)}
     onClose={() => setPickerOpen(false)}
     myModels={myModels}
     onToggleStar={onToggleStar}
    />
   )}
  </div>
 );
}
