// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
 ROLE_PROFILES_KEY,
 activateRoleProfile,
 createRoleProfile,
 deleteRoleProfile,
 loadRoleProfiles,
 normalizeRoleMap,
 normalizeRoleProfilesState,
 reconcileRoleProfiles,
 removeProviderFromRoleProfiles,
 renameRoleProfile,
 roleProfileKeys,
 roleProfileNameTaken,
 sameRoleMap,
 saveRoleProfiles,
 setRoleProfileRoles,
 type RoleProfilesState,
} from "./roleProfiles";

/**
 * 多套模型角色配置的纯逻辑：
 * - 归一化只接受合法角色名 / selector；
 * - 首次迁移用 omp 当前角色表建默认配置；
 * - omp 回读与本地「上次写入快照」不一致 = 外部改过 → 收进激活配置；
 * - 恰好一套激活（激活中的配置不能删），未激活配置的改动只在本机。
 */

const state = (): RoleProfilesState => ({
 version: 1,
 profiles: [
  { id: "p1", name: "日常", roles: { default: "demo/plain" } },
  { id: "p2", name: "提交", roles: { commit: "demo/commit" } },
 ],
 activeId: "p1",
 applied: { default: "demo/plain" },
});

beforeEach(() => {
 localStorage.clear();
});

describe("角色表归一化", () => {
 it("丢弃非字符串 / 空白 / 非法角色名，selector 去空白", () => {
  const out = normalizeRoleMap({
   default: "  demo/plain  ",
   smol: "   ",
   "bad role": "demo/x",
   broken: 42,
   "commit\n": "demo/y",
   "my-role_2": "demo/z:high",
  });
  expect(out).toEqual({ default: "demo/plain", "my-role_2": "demo/z:high" });
  expect(normalizeRoleMap(null)).toEqual({});
 });

 it("深比较不看键顺序", () => {
  expect(sameRoleMap({ a: "1", b: "2" }, { b: "2", a: "1" })).toBe(true);
  expect(sameRoleMap({ a: "1" }, { a: "1", b: "2" })).toBe(false);
  expect(sameRoleMap({ a: "1" }, { a: "2" })).toBe(false);
 });
});

describe("状态归一化与首次迁移", () => {
 it("activeId 悬空时收敛到第一套；空名称补默认名；重复 id 重新生成", () => {
  const normalized = normalizeRoleProfilesState(
   {
    version: 99,
    profiles: [
     { id: "p1", name: "", roles: { default: "demo/plain" } },
     { id: "p1", name: "重复", roles: {} },
    ],
    activeId: "ghost",
    applied: { default: "demo/plain" },
   },
   "默认配置",
  )!;
  expect(normalized.activeId).toBe("p1");
  expect(normalized.profiles).toHaveLength(2);
  expect(normalized.profiles[0].name).toBe("默认配置");
  expect(normalized.profiles[1].name).toBe("重复");
  expect(normalized.profiles[0].id).not.toBe(normalized.profiles[1].id);
 });

 it("没有本机配置 → 用 omp 当前角色表建一套默认配置并激活", () => {
  const { state: next, changed } = reconcileRoleProfiles(null, { slow: "demo/slow" }, "默认配置");
  expect(changed).toBe(true);
  expect(next.profiles).toHaveLength(1);
  expect(next.profiles[0].name).toBe("默认配置");
  expect(next.profiles[0].roles).toEqual({ slow: "demo/slow" });
  expect(next.activeId).toBe(next.profiles[0].id);
  expect(next.applied).toEqual({ slow: "demo/slow" });
 });

 it("omp 与上次写入一致时不变（changed = false）", () => {
  const first = reconcileRoleProfiles(null, { slow: "demo/slow" }, "默认配置");
  const again = reconcileRoleProfiles(first.state, { slow: "demo/slow" }, "默认配置");
  expect(again.changed).toBe(false);
  expect(again.state).toEqual(first.state);
 });
});

describe("外部改动收编", () => {
 it("omp 角色表与 applied 不同 → 只更新激活配置", () => {
  const before = state();
  const { state: next, changed } = reconcileRoleProfiles(
   before,
   { default: "demo/changed", advisor: "demo/advisor" },
   "默认配置",
  );
  expect(changed).toBe(true);
  expect(next.activeId).toBe("p1");
  expect(next.profiles.find((p) => p.id === "p1")!.roles).toEqual({
   default: "demo/changed",
   advisor: "demo/advisor",
  });
  // 未激活配置原样保留
  expect(next.profiles.find((p) => p.id === "p2")!.roles).toEqual({ commit: "demo/commit" });
  expect(next.applied).toEqual({ default: "demo/changed", advisor: "demo/advisor" });
 });

 it("旧状态没有 applied 时也按外部真值收编", () => {
  const before = { ...state(), applied: null };
  const { state: next } = reconcileRoleProfiles(before, { default: "demo/new" }, "默认配置");
  expect(next.profiles[0].roles).toEqual({ default: "demo/new" });
  expect(next.applied).toEqual({ default: "demo/new" });
 });

 it("omp 与 applied 一致但激活配置角色表漂了 → 收敛到 omp 真值", () => {
  const before: RoleProfilesState = {
   ...state(),
   profiles: [
    { id: "p1", name: "日常", roles: { default: "demo/stale" } },
    { id: "p2", name: "提交", roles: { commit: "demo/commit" } },
   ],
  };
  const { state: next, changed } = reconcileRoleProfiles(
   before,
   { default: "demo/plain" },
   "默认配置",
  );
  expect(changed).toBe(true);
  expect(next.profiles[0].roles).toEqual({ default: "demo/plain" });
  expect(next.profiles[1].roles).toEqual({ commit: "demo/commit" });
 });
});

describe("配置增删改与激活", () => {
 it("新建的配置未激活；列表为空时新建的自动激活", () => {
  const created = createRoleProfile(state(), "写作");
  expect(created.state.profiles).toHaveLength(3);
  expect(created.state.activeId).toBe("p1");
  expect(created.profile.roles).toEqual({});

  const empty = createRoleProfile(null, "  ");
  expect(empty.state.profiles).toHaveLength(1);
  expect(empty.state.activeId).toBe(empty.profile.id);
  expect(empty.profile.name).toBe("配置");
 });

 it("新建可带弹窗里先配好的角色（写入前归一化）", () => {
  const created = createRoleProfile(state(), "写作", "配置", {
   default: "  demo/plain  ",
   "bad role": "demo/x",
  });
  expect(created.profile.roles).toEqual({ default: "demo/plain" });
  expect(created.state.profiles[2].roles).toEqual({ default: "demo/plain" });
  expect(created.state.activeId).toBe("p1");
 });

 it("改名、改未激活配置的角色、名称查重", () => {
  const renamed = renameRoleProfile(state(), "p2", "  提交信息  ");
  expect(renamed.profiles[1].name).toBe("提交信息");
  expect(renameRoleProfile(renamed, "ghost", "x")).toBe(renamed);
  expect(renameRoleProfile(renamed, "p2", "   ")).toBe(renamed);

  const edited = setRoleProfileRoles(renamed, "p2", {
   commit: "  demo/commit2  ",
   "bad role": "demo/x",
  });
  expect(edited.profiles[1].roles).toEqual({ commit: "demo/commit2" });
  // 激活位与 applied 不受未激活配置编辑影响
  expect(edited.activeId).toBe("p1");
  expect(edited.applied).toEqual({ default: "demo/plain" });

  expect(roleProfileNameTaken(edited.profiles, "日常")).toBe(true);
  expect(roleProfileNameTaken(edited.profiles, " 日常 ", "p1")).toBe(false);
  expect(roleProfileNameTaken(edited.profiles, "不存在")).toBe(false);
 });

 it("激活一套配置会同步 applied 与这套的角色表", () => {
  const next = activateRoleProfile(state(), "p2", { commit: "demo/commit:low" });
  expect(next.activeId).toBe("p2");
  expect(next.profiles[1].roles).toEqual({ commit: "demo/commit:low" });
  expect(next.applied).toEqual({ commit: "demo/commit:low" });
  // p1 的配置保留（切回来还能用）
  expect(next.profiles[0].roles).toEqual({ default: "demo/plain" });
 });

 it("供应商移除后：每套配置删掉该供应商的角色，激活配置与 applied 采用 omp 真值", () => {
  const before: RoleProfilesState = {
   version: 1,
   profiles: [
    {
     id: "p1",
     name: "日常",
     roles: { default: "anth/claude", smol: "openai/gpt", legacy: "anthx/model" },
    },
    {
     id: "p2",
     name: "提交",
     roles: { commit: "anth/claude:high", plan: "openai/plan" },
    },
   ],
   activeId: "p1",
   applied: { default: "anth/claude", smol: "openai/gpt", legacy: "anthx/model" },
  };
  const ompRoles = { smol: "openai/gpt", legacy: "anthx/model" };
  const { state: next, changed } = removeProviderFromRoleProfiles(before, "anth", ompRoles);
  expect(changed).toBe(true);
  // 激活配置 = 后端清理后的真值（不重新推导）
  expect(next.profiles[0].roles).toEqual(ompRoles);
  // 未激活配置按同一规则过滤；`:档位` 后缀不影响前缀判定
  expect(next.profiles[1].roles).toEqual({ plan: "openai/plan" });
  // applied 同步，下一次回读不会把这次清理误判成外部改动
  expect(next.applied).toEqual(ompRoles);

  // 已经没有该供应商的引用：不产生新状态
  const again = removeProviderFromRoleProfiles(next, "anth", next.applied ?? {});
  expect(again.changed).toBe(false);
 });

 it("激活中的配置不能删；删未激活配置不动激活位", () => {
  const before = state();
  expect(deleteRoleProfile(before, "p1")).toBe(before);
  const next = deleteRoleProfile(before, "p2");
  expect(next.profiles.map((p) => p.id)).toEqual(["p1"]);
  expect(next.activeId).toBe("p1");
 });

 it("编辑页角色顺序 = 内置角色在前（固定顺序）+ 自定义角色按配置键序", () => {
  const keys = roleProfileKeys(
   { id: "p", name: "x", roles: { zeta: "demo/z", default: "demo/d", alpha: "demo/a" } },
   ["default", "smol", "advisor"],
  );
  expect(keys).toEqual(["default", "smol", "advisor", "zeta", "alpha"]);
 });
});

describe("localStorage 持久化", () => {
 it("保存后能读回；坏 JSON / 空列表按没有配置处理", () => {
  const before = state();
  saveRoleProfiles(before);
  expect(loadRoleProfiles("默认配置")).toEqual(before);

  localStorage.setItem(ROLE_PROFILES_KEY, "{broken");
  expect(loadRoleProfiles("默认配置")).toBeNull();

  localStorage.setItem(ROLE_PROFILES_KEY, JSON.stringify({ version: 1, profiles: [] }));
  expect(loadRoleProfiles("默认配置")).toBeNull();
 });
});
