import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@shared/api";
import type { FallbackChainsInfo, ModelRolesInfo } from "@shared/types";
import { useApp } from "../../stores/app";
import { myModelEntries, orderModelsByStars, removeProviderModels, toggleMyModel } from "../../lib/myModels";
import { fmt } from "../../lib/locale";
import {
 activateRoleProfile,
 createRoleProfile,
 deleteRoleProfile,
 loadRoleProfiles,
 reconcileRoleProfiles,
 removeProviderFromRoleProfiles,
 renameRoleProfile,
 saveRoleProfiles,
 setRoleProfileRoles,
 type RoleProfilesState,
} from "../../lib/roleProfiles";
import { useText } from "../../lib/useText";
import { FallbackChainsSection } from "./FallbackChains";
import { ProvidersSection } from "./ProvidersSection";
import { RoleProfilesSection } from "./RoleProfilesSection";
import { StarToggle } from "./StarToggle";

/**
 * 设置 › 模型：omp 模型相关的**唯一管理面**（V12b 把原「供应商」页签整体并了进来）。
 * 区块顺序 = 使用动线：**供应商 → 我的模型 → 模型角色（多套配置）→ 失败转移**（先添加供应商，
 * 再在弹窗里挑选模型——挑进的进「我的模型」，在各选单里置顶）。
 *
 * 口径：
 * - **我的模型**（本应用偏好，localStorage；`src/lib/myModels.ts`）是**置顶排序**：
 *   候选始终是全量可用模型，星标项（`orderModelsByStars`）在角色 / 转移弹窗里置顶；
 *   挑没挑过都不缩小可选范围。**不写 omp 的 `enabledModels`**——omp 终端里
 *   `/model` 的可选范围不受影响。挑选入口 = 供应商行的「挑选模型」弹窗（V12c 起不再有
 *   平铺的「可用模型」目录——目录在弹窗里按供应商列出，带搜索过滤）。
 *   自定义供应商的「挑选模型」是**另一套语义**（2026-10-17）：它管的是 `models.yml` 里
 *   这个端点有哪些模型（「获取可用模型」拉候选 → 勾选 → 逐项调参），供应商配置弹窗里
 *   不再内嵌模型编辑区；**每行行尾星标 = 加入 / 移出「我的模型」**（2026-10-21，与登录型
 *   供应商的挑选面板同一份 `StarToggle` 口径，selector = `provider/id`）。
 * - **模型角色 = 多套本机配置，只有一套激活**（2026-10-20 用户口径，见
 *   `RoleProfilesSection.tsx` / `lib/roleProfiles.ts`）：omp 只有一张全局 `modelRoles`，
 *   激活配置的整表通过 `apply_model_roles` 写入 omp（未配置的角色按 omp 自己的回退规则解析，
 *   本页不复制那套规则）；未激活配置的修改只落在 localStorage。角色值可带 `:思考档` 后缀，
 *   档位候选按该模型声明的档裁剪。
 * - **omp 侧改完切回来就该看到**：角色与转移链在挂载时拉一次、**每次设置视图重新激活时重读**
 *   （在别处（omp TUI / CLI）改过 `modelRoles` 后，回到设置视图即刷新）；回读到的角色表与
 *   本地「上次写入 omp 的快照」不一致 = 外部改过，收进当前激活配置（`reconcileRoleProfiles`）。
 *   模型目录不额外重拉——`get_models` 后端有 5 分钟缓存，只有页内动作（挑选模型 / 改供应商）
 *   才走 `refresh_models` 强制重拉；页头的刷新钮已按用户口径退场（2026-10-19），且本页要跑
 *   `omp` 子进程，不挂焦点回读（一次 alt-tab 就是一次秒级子进程）。
 * - **Ctrl+P 快速切换环**（`cycleOrder`）没有手动编辑面（用户口径 2026-10-10）：环 = 模型
 *   角色的派生投影——后端 `sync_cycle_order` 按角色展示顺序取已配置模型、按模型基名保序
 *   去重（`:思考档` 后缀不算另一个模型；重复模型保留第一个出现的角色），已是目标值就不写。
 *   本页在**加载后**与**激活 / 编辑激活配置后**各同步一次；角色行的顺序即轮换顺序，页面上
 *   没有环开关 / 位次 / 排序按钮。
 * - 失败转移链（`retry.fallbackChains`）与角色同层，口径见 `FallbackChains.tsx`。
 * - 供应商（登录型 + 自定义）合并成一个「添加供应商」弹窗：登录型走 `omp auth-broker`
 *   （凭证进 omp 凭证库），自定义写 `<agentDir>/models.yml`——见 `ProvidersSection.tsx`。
 */

export function ModelsPanel() {
 const t = useText();
 const { models, set, myModels, setMyModels, settingsTabActive } = useApp();
 const [roles, setRoles] = useState<ModelRolesInfo | null>(null);
 const [chains, setChains] = useState<FallbackChainsInfo | null>(null);
 const [rolesError, setRolesError] = useState<string | null>(null);
 const [chainsError, setChainsError] = useState<string | null>(null);
 const [cycleError, setCycleError] = useState<string | null>(null);
 const [catalogError, setCatalogError] = useState<string | null>(null);
 const [busy, setBusy] = useState(false);
 const [profiles, setProfiles] = useState<RoleProfilesState | null>(() =>
  loadRoleProfiles(t.roleProfilesDefaultName),
 );
 /** 供应商清理后重挂载失败转移区块：清掉正在编辑的链的草稿（那条链可能刚被删掉）。 */
 const [chainsEpoch, setChainsEpoch] = useState(0);
 const profilesRef = useRef<RoleProfilesState | null>(profiles);
 const requestSeq = useRef(0);
 const rolesRevision = useRef(0);
 const chainsRevision = useRef(0);
 const roleWriting = useRef(false);
 const [savingRole, setSavingRole] = useState(false);

 /** 落盘 + 内存同步的唯一入口：所有配置改动都从这里过，`profilesRef` 供异步回调读最新值。 */
 const commitProfiles = useCallback((next: RoleProfilesState) => {
  profilesRef.current = next;
  saveRoleProfiles(next);
  setProfiles(next);
 }, []);

 /** 同步 Ctrl+P 轮换序：环 = 模型角色的派生投影，后端幂等（已是目标值不写）。
  *  页面加载与角色写入后各跑一次；失败只在角色区提示，不挡其它读取与操作。 */
 const syncCycle = useCallback(async () => {
  try {
   await api.syncCycleOrder();
   setCycleError(null);
  } catch (e) {
   setCycleError(e instanceof Error ? e.message : String(e || t.cycleSyncFailed));
  }
 }, [t.cycleSyncFailed]);

 /** 重读只接纳最新请求；写入后的真值不能被更早发出的读请求覆盖。 */
 const load = useCallback(async (force: boolean) => {
  const seq = ++requestSeq.current;
  const roleVersion = rolesRevision.current;
  const chainVersion = chainsRevision.current;
  /** 每个读取**各自到达即渲染**——目录（`omp models --json`，实测 2–10s；后端已收敛成
   *  单飞 + 缓存）不该拖着角色 / 转移链一起白等，那是「设置页要等好几秒」的主因。 */
  const each = <T,>(req: Promise<T>, apply: (v: T) => void, onError: (msg: string) => void) =>
   req.then(
    (v) => {
     if (seq === requestSeq.current) apply(v);
    },
    (e: unknown) => {
     if (seq === requestSeq.current) onError(e instanceof Error ? e.message : String(e || t.modelsLoadFailed));
    },
   );
  return Promise.all([
   each(
    api.getModelRoles(),
    (v) => {
     if (roleVersion !== rolesRevision.current || roleWriting.current) return;
     setRoles(v);
     setRolesError(null);
     // omp 回读 = 激活配置的真值：与本地「上次写入」快照不一致 = 外部改过，收进激活配置
     const next = reconcileRoleProfiles(
      profilesRef.current,
      v.roles,
      t.roleProfilesDefaultName,
     );
     if (next.changed) commitProfiles(next.state);
    },
    (msg) => {
     if (roleVersion !== rolesRevision.current || roleWriting.current) return;
     setRolesError(msg);
    },
   ),
   each(
    api.getFallbackChains(),
    (v) => {
     if (chainVersion !== chainsRevision.current) return;
     setChains(v);
     setChainsError(null);
    },
    (msg) => {
     if (chainVersion !== chainsRevision.current) return;
     setChainsError(msg);
    },
   ),
   // 环 = 角色表的派生投影：每次加载都同步一次（同时兜掉 omp 侧手改 / 历史遗留的环）
   syncCycle(),
   each(
    force ? api.refreshModels() : api.getModels(),
    (v) => {
     set({ models: v });
     setCatalogError(v.error ?? null);
    },
    (msg) => setCatalogError(msg),
   ),
  ]);
 }, [commitProfiles, set, syncCycle, t.modelsLoadFailed, t.roleProfilesDefaultName]);

 // 挂载时拉一次；**每次设置视图重新激活**（从聊天切回来）都重读——omp 侧（TUI / CLI）
 // 改过的模型角色与转移链，回到设置页就该看到，不该要求用户先点「刷新」或重开设置视图。
 // 模型目录走 `get_models` 的 5 分钟缓存（`models` 已在 store 里时不强制重拉），这轮重读很轻。
 useEffect(() => {
  if (!settingsTabActive) return;
  const timer = window.setTimeout(() => {
   void load(!models);
  }, 0);
  return () => {
   window.clearTimeout(timer);
   requestSeq.current += 1;
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载与激活态翻转时重读
 }, [settingsTabActive]);

 /** 写 omp 的**激活角色表**（激活一套配置 / 编辑激活配置共用）：后端整表覆盖 + 回读真值，
   *  写完顺手同步 Ctrl+P 轮换序。返回回读的真相；失败抛错给角色区就地提示。
   *  `rolesRevision` 在写入前后各加一：写入期间到达的旧读请求不许覆盖真值。 */
 const writeActiveRoles = useCallback(
  async (next: Record<string, string>) => {
   if (roleWriting.current) throw new Error(t.roleSaving);
   roleWriting.current = true;
   rolesRevision.current += 1;
   setSavingRole(true);
   try {
    const info = await api.applyModelRoles(next);
    setRoles(info);
    setRolesError(null);
    await syncCycle();
    return info;
   } finally {
    rolesRevision.current += 1;
    roleWriting.current = false;
    setSavingRole(false);
   }
  },
  [syncCycle, t.roleSaving],
 );

 /** 激活一套配置：写 omp 成功后才移动激活位（写失败保持原配置，界面不被乐观状态带偏）。 */
 const activateProfile = useCallback(
  async (id: string) => {
   const state = profilesRef.current;
   const target = state?.profiles.find((p) => p.id === id);
   if (!state || !target || id === state.activeId) return;
   const info = await writeActiveRoles(target.roles);
   commitProfiles(activateRoleProfile(profilesRef.current ?? state, id, info.roles));
  },
  [commitProfiles, writeActiveRoles],
 );

 /** 改一套配置里的一个角色：激活配置走 omp（整表写 + 回读），未激活配置只落本机。 */
 const editProfileRole = useCallback(
  async (id: string, role: string, selector: string | null) => {
   const state = profilesRef.current;
   const target = state?.profiles.find((p) => p.id === id);
   if (!state || !target) return;
   const next = { ...target.roles };
   const value = selector?.trim();
   if (value) next[role] = value;
   else delete next[role];
   if (id === state.activeId) {
    const info = await writeActiveRoles(next);
    commitProfiles(activateRoleProfile(profilesRef.current ?? state, id, info.roles));
   } else {
    commitProfiles(setRoleProfileRoles(state, id, next));
   }
  },
  [commitProfiles, writeActiveRoles],
 );

 /** 新建一套配置（未激活；名称与角色由新建弹窗保证），不改变当前激活位。 */
 const createProfile = useCallback(
  (name: string, roles: Record<string, string>) => {
   const { state } = createRoleProfile(
    profilesRef.current,
    name,
    t.roleProfilesDefaultName,
    roles,
   );
   commitProfiles(state);
  },
  [commitProfiles, t.roleProfilesDefaultName],
 );

 const renameProfile = useCallback(
  (id: string, name: string) => {
   const state = profilesRef.current;
   if (state) commitProfiles(renameRoleProfile(state, id, name));
  },
  [commitProfiles],
 );

 /** 删除一套配置：激活中的配置由 lib 拒绝（界面也禁用删除键），保证恰好一套激活。 */
 const removeProfile = useCallback(
  (id: string) => {
   const state = profilesRef.current;
   if (state) commitProfiles(deleteRoleProfile(state, id));
  },
  [commitProfiles],
 );

 const refreshAll = async () => {
  setBusy(true);
  try {
   await load(true);
  } finally {
   setBusy(false);
  }
 };

 /** 供应商登出 / 删除后：omp 侧（角色 / 转移链 / 轮换序）由后端清理并回读，
   *  本机侧（我的模型、多套角色配置）在这里同步删干净——否则切回那套配置会把
   *  已不存在的模型又写回 omp。失败抛给供应商区提示，不吞掉。 */
 const purgeProvider = useCallback(
  async (providerId: string) => {
   roleWriting.current = true;
   rolesRevision.current += 1;
   chainsRevision.current += 1;
   try {
    const info = await api.purgeProviderModels(providerId);
    setRoles(info.modelRoles);
    setRolesError(null);
    setChains(info.fallbackChains);
    setChainsError(null);
    setChainsEpoch((n) => n + 1);
    const state = profilesRef.current;
    if (state) {
     const next = removeProviderFromRoleProfiles(state, providerId, info.modelRoles.roles);
     if (next.changed) commitProfiles(next.state);
    }
    const before = useApp.getState().myModels;
    const remaining = removeProviderModels(before, providerId);
    if (remaining.length !== before.length) setMyModels(remaining);
   } finally {
    rolesRevision.current += 1;
    roleWriting.current = false;
   }
  },
  [commitProfiles, setMyModels],
 );

 const roleKeys = useMemo(() => {
  const builtin = roles?.builtin ?? [];
  const rest = Object.keys(roles?.roles ?? {}).filter((k) => !builtin.includes(k));
  return [...builtin, ...rest];
 }, [roles]);

 /** 目录数组：每次渲染新数组会让下面 useMemo 的依赖失效——按 `models` 记忆。 */
 const catalog = useMemo(() => models?.models ?? [], [models]);
 /** 模型选择器的候选（**星标置顶的唯一实现点**）：星标按挑选顺序在前、其余按目录顺序，不收窄范围。 */
 const candidates = useMemo(() => orderModelsByStars(catalog, myModels), [catalog, myModels]);
 /** 我的模型（按挑选顺序解析，含已不可用项——设置页要列出来给人清理）。 */
 const entries = useMemo(() => myModelEntries(myModels, catalog), [myModels, catalog]);

 return (
  <div className="settings-panel">
   {/* 页头整行已按用户口径退场（2026-10-19）：说明 / 刷新钮都不再上界面；重读时机 =
       切走页签再回来（重挂）+ 页内自身动作（保存供应商 / 挑选模型走 refreshAll，
       经 modelsRefreshed 广播）。角色写入的错误在角色区就地显示，不占页头。 */}

   {/* 供应商：添加（登录型 API key / OAuth + 自定义 models.yml）+ 按供应商挑选模型 */}
   <ProvidersSection onProviderRemoved={purgeProvider} />

   {/* 我的模型：本应用偏好；挑过之后下面角色 / 转移的候选只列这些 */}
   <section aria-label={t.myModelsSection} className="mt-6 shrink-0">
    <div className="flex flex-wrap items-center gap-2">
     <h3 className="text-xs font-medium text-muted">{t.myModelsSection}</h3>
     {entries.length > 0 && (
      <span className="font-mono text-[11px] text-faint">{fmt(t.myModelsCount, String(entries.length))}</span>
     )}
     {entries.length > 0 && (
      <button
       onClick={() => setMyModels([])}
       className="ml-auto flex h-7 cursor-pointer items-center rounded-md px-2 text-[12px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
      >
       {t.myModelsClear}
      </button>
     )}
    </div>
    {catalogError && (
     <p role="alert" className="mt-2 rounded border border-warn/40 bg-warn/5 px-2 py-1.5 text-[13px] text-warn">
      {catalogError}
     </p>
    )}
    <div className="mt-1 divide-y divide-border-soft">
     {entries.length === 0 ? (
      <p className="py-2 text-[13px] text-muted">{t.myModelsEmpty}</p>
     ) : (
      entries.map(({ selector, model }) => (
       <div key={selector} className="flex min-h-11 flex-wrap items-center gap-2 py-2.5">
        <StarToggle on name={model?.name ?? selector} onClick={() => setMyModels(toggleMyModel(myModels, selector))} />
        <span className="min-w-0 flex-1 truncate text-[13px]">{model?.name ?? selector}</span>
        {model && <span className="min-w-0 basis-full pl-9 font-mono text-[11px] break-all text-faint @min-[600px]/panel:ml-auto @min-[600px]/panel:basis-auto @min-[600px]/panel:pl-0">{selector}</span>}
        {!model && (
         <span className="shrink-0 rounded border border-warn/40 bg-warn/5 px-1.5 py-0.5 text-xs text-warn">
          {t.myModelsUnavailable}
         </span>
        )}
       </div>
      ))
     )}
    </div>
   </section>

   {/* 模型角色 = 多套配置的列表（2026-10-20 用户口径）：点击一套进去编辑角色；
       同一时间只有激活的那套写入 omp 生效。Ctrl+P 轮换序自动取激活配置的已配置模型。 */}
   <RoleProfilesSection
    roles={roles}
    rolesError={rolesError}
    cycleError={cycleError}
    busy={busy}
    saving={savingRole}
    profiles={profiles}
    candidates={candidates}
    catalog={catalog}
    myModels={myModels}
    onToggleStar={(s) => setMyModels(toggleMyModel(myModels, s))}
    onRetry={() => void refreshAll()}
    onCreate={createProfile}
    onRename={renameProfile}
    onDelete={removeProfile}
    onActivate={activateProfile}
    onEditRole={editProfileRole}
   />

   {/* 失败转移：omp retry.fallbackChains（模型请求失败时由备用模型接管）+ 两个配套开关 */}
   <FallbackChainsSection
    key={chainsEpoch}
    info={chains}
    models={candidates}
    catalog={catalog}
    roles={roleKeys}
    myModels={myModels}
    onToggleMyModel={(s) => setMyModels(toggleMyModel(myModels, s))}
    busy={busy}
    loadError={chainsError}
    onSaved={(info) => { chainsRevision.current += 1; setChains(info); }}
    onRefresh={() => void refreshAll()}
   />
  </div>
 );
}
