// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { loadLastSession, normalizeLastSession, saveLastSession } from "./lastSession";

beforeEach(() => {
 localStorage.clear();
});

describe("上次选中的会话（关闭 app 时的那个，下次打开接着看）", () => {
 it("normalizeLastSession：缺 id / 非对象一律丢弃，字段按类型兜底", () => {
  expect(normalizeLastSession(null)).toBeNull();
  expect(normalizeLastSession("s-1")).toBeNull();
  expect(normalizeLastSession([])).toBeNull();
  expect(normalizeLastSession({ projectId: "p1" })).toBeNull();
  expect(normalizeLastSession({ id: "   " })).toBeNull();
  expect(normalizeLastSession({ id: " s-1 ", projectId: "", title: 7 })).toEqual({
   id: "s-1",
   projectId: null,
   title: "",
   cwd: "",
  });
 });

 it("存取往返；内容没变不重写（坏 JSON 当没记录）", () => {
  expect(loadLastSession()).toBeNull();
  const rec = { id: "s-1", projectId: "p1", title: "登录页重构", cwd: "/w/alpha" };
  saveLastSession(rec);
  expect(loadLastSession()).toEqual(rec);
  // 同内容再存一次：写盘被跳过（比较后再写），值保持一致
  localStorage.setItem("omp.lastSession.v1", JSON.stringify(rec));
  saveLastSession({ ...rec });
  expect(loadLastSession()).toEqual(rec);
  // 坏 JSON：当没记录，不抛
  localStorage.setItem("omp.lastSession.v1", "{not json");
  expect(loadLastSession()).toBeNull();
 });

 it("未归属会话（projectId 为 null）照常记录", () => {
  saveLastSession({ id: "s-9", projectId: null, title: "游离会话", cwd: "/tmp/scratch" });
  expect(loadLastSession()?.projectId).toBeNull();
  expect(loadLastSession()?.id).toBe("s-9");
 });
});
