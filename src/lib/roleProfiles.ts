/**
 * **模型角色配置**（本应用偏好，omp 没有「多套 modelRoles」这个概念）。
 *
 * omp 全局只有一个 `modelRoles` record；本应用在壳侧维护多套命名配置，**只有一套处于激活态**，
 * 激活的那套整表写入 omp（`apply_model_roles`），因此聊天里的角色解析、失败转移与 Ctrl+P
 * 轮换序看到的始终是激活配置。
 *
 * 口径：
 * - 存储 = localStorage（与「我的模型」同一档，不写 omp 配置）；键 `omp.modelRoleProfiles.v1`。
 * - **外部改动以 omp 为真值**：每次回读 `modelRoles` 与 `applied`（最近一次写入 omp 的快照）
 *   对比，不一致 = 用户在 omp TUI / CLI 里改过 → 收进当前激活配置，再持久化。
 *   这样「omp 里改完，切回设置页就能看到」这条既有契约不变。
 * - 未激活配置的编辑只落在 localStorage；激活 / 编辑激活配置才走后端整表写入。
 * - 同一时间恰好一套激活（不允许「全部未激活」）：激活中的配置不能删除；至少保留一套。
 * - 角色名 / selector 的校验与后端 `apply_role_edit` 同口径：非法项在读取时丢弃，写入前由
 *   后端再校验一次（前端不是安全边界）。
 */

import { selectorBelongsToProvider } from "./modelSelector";

/** 持久化键（导出供测试与迁移逻辑使用；版本后缀与其它本应用偏好同模式）。 */
export const ROLE_PROFILES_KEY = "omp.modelRoleProfiles.v1";
const KEY = ROLE_PROFILES_KEY;
const VERSION = 1;
/** 配置名上限（与模型名等短标签同档；只影响界面显示与去重）。 */
export const ROLE_PROFILE_NAME_MAX = 40;
/** 与后端 `BUILTIN_ROLES` 同序（后端 `get_model_roles` 也会回传，读不到时用这份兜底）。 */
export const BUILTIN_ROLE_IDS = [
 "default",
 "smol",
 "slow",
 "vision",
 "plan",
 "commit",
 "tiny",
 "task",
 "advisor",
] as const;

export type RoleProfile = {
 id: string;
 name: string;
 /** 角色 id → 模型 selector（可带 `:思考档` 后缀），与 omp `modelRoles` 同形。 */
 roles: Record<string, string>;
};

export type RoleProfilesState = {
 version: 1;
 profiles: RoleProfile[];
 /** 恰好一个；状态始终指向 `profiles` 里的某一套。 */
 activeId: string;
 /** 最近一次写入 omp 的角色表（外部改动识别用）；`null` = 还没有可对照的写入。 */
 applied: Record<string, string> | null;
};

let idSeq = 0;
/** 配置 id：只在本机列表内唯一，不参与 omp 写入；时间戳 + 进程内序号足够。 */
export function newRoleProfileId(): string {
 idSeq += 1;
 return `role-profile-${Date.now().toString(36)}-${idSeq.toString(36)}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
 return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 控制字符（C0 + DEL）：写进 config.yml / JSON 没意义，读取时丢弃。 */
function hasControlChar(s: string): boolean {
 for (let i = 0; i < s.length; i += 1) {
  const code = s.charCodeAt(i);
  if (code < 0x20 || code === 0x7f) return true;
 }
 return false;
}

/** 角色名合法性（与后端 `validate_role_name` 同口径）：非空、无空白 / 控制字符。 */
function validRoleName(role: string): boolean {
 return role.length > 0 && !/\s/.test(role) && !hasControlChar(role);
}

/**
 * 归一化角色表：丢非字符串值、空白 selector、非法角色名；selector 去首尾空白。
 * 空值 / 非法形状 = 空表（未配置任何角色）。
 */
export function normalizeRoleMap(raw: unknown): Record<string, string> {
 if (!isRecord(raw)) return {};
 const out: Record<string, string> = {};
 for (const [role, value] of Object.entries(raw)) {
  if (typeof value !== "string" || !validRoleName(role)) continue;
  const selector = value.trim();
  if (!selector || hasControlChar(selector)) continue;
  out[role] = selector;
 }
 return out;
}

/** 角色表深比较（键顺序不算差异）。 */
export function sameRoleMap(a: Record<string, string>, b: Record<string, string>): boolean {
 const ak = Object.keys(a);
 const bk = Object.keys(b);
 if (ak.length !== bk.length) return false;
 return ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

function normalizeName(raw: unknown, fallback: string): string {
 if (typeof raw !== "string") return fallback;
 const name = raw.trim().slice(0, ROLE_PROFILE_NAME_MAX);
 return name || fallback;
}

/**
 * 归一化持久化状态：丢弃坏项、补齐 id / 名称、把 `activeId` 收敛到存在的配置。
 * 没有任何可用配置 / 形状不是对象 → `null`（交给 [`reconcileRoleProfiles`] 建默认配置）。
 */
export function normalizeRoleProfilesState(
 raw: unknown,
 defaultName: string,
): RoleProfilesState | null {
 if (!isRecord(raw) || !Array.isArray(raw.profiles)) return null;
 const ids = new Set<string>();
 const profiles: RoleProfile[] = [];
 for (const [i, item] of raw.profiles.entries()) {
  if (!isRecord(item)) continue;
  let id = typeof item.id === "string" ? item.id.trim() : "";
  if (!id || ids.has(id)) id = newRoleProfileId();
  ids.add(id);
  const fallback = i === 0 ? defaultName : `${defaultName} ${i + 1}`;
  profiles.push({
   id,
   name: normalizeName(item.name, fallback),
   roles: normalizeRoleMap(item.roles),
  });
 }
 if (profiles.length === 0) return null;
 const activeId =
  typeof raw.activeId === "string" && profiles.some((p) => p.id === raw.activeId)
   ? raw.activeId
   : profiles[0].id;
 const applied = isRecord(raw.applied) ? normalizeRoleMap(raw.applied) : null;
 return { version: VERSION, profiles, activeId, applied };
}

function sameProfile(a: RoleProfile, b: RoleProfile): boolean {
 return a.id === b.id && a.name === b.name && sameRoleMap(a.roles, b.roles);
}

/** 状态深比较（用于判断归一化 / 外部收编是否真的改了东西，避免无意义的 setState / 落盘）。 */
export function sameRoleProfilesState(a: RoleProfilesState, b: RoleProfilesState): boolean {
 if (a.activeId !== b.activeId || a.profiles.length !== b.profiles.length) return false;
 if (a.applied === null || b.applied === null) {
  if (a.applied !== b.applied) return false;
 } else if (!sameRoleMap(a.applied, b.applied)) {
  return false;
 }
 return a.profiles.every((p, i) => sameProfile(p, b.profiles[i]));
}

/** 读取本机配置；没有 / 坏数据 → null（随后由 omp 的当前角色表生成默认配置）。 */
export function loadRoleProfiles(defaultName = "配置"): RoleProfilesState | null {
 try {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(KEY);
  return raw ? normalizeRoleProfilesState(JSON.parse(raw), defaultName) : null;
 } catch {
  return null;
 }
}

/** 写失败不阻断本次操作（无痕模式 / 配额满与其它本应用偏好同口径）。 */
export function saveRoleProfiles(state: RoleProfilesState): void {
 try {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify(state));
 } catch {
  // 忽略：内存里的配置仍然可用，下次成功写入时自然补上
 }
}

/**
 * 用 omp 回读的角色表校准配置列表：
 * - 没有任何配置 → 用当前 omp 角色表建一套默认配置并激活（首次升级 / 清空 localStorage）；
 * - `applied` 与 omp 当前角色表不一致 → 外部改过，把当前角色表收进激活配置。
 * 返回 `changed = false` 时调用方不必落盘 / setState。
 */
export function reconcileRoleProfiles(
 state: RoleProfilesState | null,
 ompRoles: Record<string, string>,
 defaultName: string,
): { state: RoleProfilesState; changed: boolean } {
 const normalized = normalizeRoleProfilesState(state, defaultName);
 const current = normalizeRoleMap(ompRoles);
 if (!normalized) {
  const profile: RoleProfile = { id: newRoleProfileId(), name: defaultName, roles: current };
  return {
   state: { version: VERSION, profiles: [profile], activeId: profile.id, applied: current },
   changed: true,
  };
 }
 let next = normalized;
 if (next.applied === null || !sameRoleMap(next.applied, current)) {
  next = {
   ...next,
   applied: current,
   profiles: next.profiles.map((p) => (p.id === next.activeId ? { ...p, roles: current } : p)),
  };
 } else {
  // 不变量：omp 与上次写入一致时，激活配置的角色表也必须一致（坏数据 / 手工改过 localStorage 时收敛）
  const active = next.profiles.find((p) => p.id === next.activeId);
  if (active && !sameRoleMap(active.roles, current)) {
   next = {
    ...next,
    profiles: next.profiles.map((p) => (p.id === next.activeId ? { ...p, roles: current } : p)),
   };
  }
 }
 return { state: next, changed: !state || !sameRoleProfilesState(state, next) };
}

/** 新建一套未激活配置；`roles` 可带新建弹窗里先配好的角色（空 = 未配置）。
 *  列表为空时（理论上不会）新建的这套直接成为激活配置。 */
export function createRoleProfile(
 state: RoleProfilesState | null,
 name: string,
 defaultName = "配置",
 roles: Record<string, string> = {},
): { state: RoleProfilesState; profile: RoleProfile } {
 const base =
  normalizeRoleProfilesState(state, defaultName) ??
  ({ version: VERSION, profiles: [], activeId: "", applied: null } as RoleProfilesState);
 const profile: RoleProfile = {
  id: newRoleProfileId(),
  name: normalizeName(name, defaultName),
  roles: normalizeRoleMap(roles),
 };
 return {
  state: {
   ...base,
   profiles: [...base.profiles, profile],
   activeId: base.activeId || profile.id,
  },
  profile,
 };
}

/** 改名（空白 / 非法长度按上限截断；调用方负责查重）。找不到 id 时原样返回。 */
export function renameRoleProfile(
 state: RoleProfilesState,
 id: string,
 name: string,
): RoleProfilesState {
 const next = name.trim().slice(0, ROLE_PROFILE_NAME_MAX);
 if (!next || !state.profiles.some((p) => p.id === id)) return state;
 return { ...state, profiles: state.profiles.map((p) => (p.id === id ? { ...p, name: next } : p)) };
}

/** 删除一套配置；**激活中的配置不可删**（状态里必须恰好有一套生效）。 */
export function deleteRoleProfile(state: RoleProfilesState, id: string): RoleProfilesState {
 if (id === state.activeId || !state.profiles.some((p) => p.id === id)) return state;
 return { ...state, profiles: state.profiles.filter((p) => p.id !== id) };
}

/** 改一套（通常未激活）配置的角色表。激活配置的写入要走 [`activateRoleProfile`] 同步 `applied`。 */
export function setRoleProfileRoles(
 state: RoleProfilesState,
 id: string,
 roles: Record<string, string>,
): RoleProfilesState {
 const next = normalizeRoleMap(roles);
 if (!state.profiles.some((p) => p.id === id)) return state;
 return {
  ...state,
  profiles: state.profiles.map((p) => (p.id === id ? { ...p, roles: next } : p)),
 };
}

/**
 * 激活一套配置（调用方已经成功把它写进 omp）：更新激活位、角色表与 `applied`。
 * 也用于「编辑激活配置后」用 omp 回读的真值收敛状态。
 */
export function activateRoleProfile(
 state: RoleProfilesState,
 id: string,
 roles: Record<string, string>,
): RoleProfilesState {
 if (!state.profiles.some((p) => p.id === id)) return state;
 const next = normalizeRoleMap(roles);
 return {
  ...state,
  activeId: id,
  applied: next,
  profiles: state.profiles.map((p) => (p.id === id ? { ...p, roles: next } : p)),
 };
}

/**
 * 供应商登出 / 删除后的本地清理：**每套**配置里指向该供应商的角色都删除。
 *
 * - 激活配置直接采用 `ompRoles`（后端清理后的回读真值），避免前端与 omp 的判定口径漂移；
 * - `applied` 同步成同一份真值——否则下一次回读会把这次清理误判成「omp 被外部改过」，
 *   再把旧值收编回激活配置。
 */
export function removeProviderFromRoleProfiles(
 state: RoleProfilesState,
 providerId: string,
 ompRoles: Record<string, string>,
): { state: RoleProfilesState; changed: boolean } {
 const applied = normalizeRoleMap(ompRoles);
 const profiles = state.profiles.map((p) => {
  const roles =
   p.id === state.activeId
    ? applied
    : Object.fromEntries(
      Object.entries(p.roles).filter(
       ([, selector]) => !selectorBelongsToProvider(selector, providerId),
      ),
     );
  return sameRoleMap(p.roles, roles) ? p : { ...p, roles };
 });
 const next: RoleProfilesState = { ...state, profiles, applied };
 return { state: next, changed: !sameRoleProfilesState(state, next) };
}

/** 配置名是否已被别的配置占用（去首尾空白、精确比较）。 */
export function roleProfileNameTaken(
 profiles: RoleProfile[],
 name: string,
 exceptId?: string,
): boolean {
 const target = name.trim();
 if (!target) return false;
 return profiles.some((p) => p.id !== exceptId && p.name === target);
}

/** 编辑页的角色行顺序：omp 内置角色在前（固定顺序），自定义角色按配置里的键序排在后面。 */
export function roleProfileKeys(profile: RoleProfile, builtin: readonly string[]): string[] {
 const seen = new Set(builtin);
 return [...builtin, ...Object.keys(profile.roles).filter((k) => !seen.has(k))];
}
