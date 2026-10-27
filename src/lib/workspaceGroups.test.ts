import { describe, expect, it } from "vitest";
import type { CheckoutView, ProjectView } from "@shared/types";
import { projectIdForPath } from "./workspaceGroups";

const projects: ProjectView[] = [
 { id: "a", path: "/a", name: "Alpha", missing: false, sessionCount: 0, workspaceId: null },
 { id: "b", path: "/b", name: "Front", missing: false, sessionCount: 0, workspaceId: "w1" },
 { id: "c", path: "/c", name: "Back", missing: false, sessionCount: 0, workspaceId: "w1" },
];
const checkouts: CheckoutView[] = [
 { projectId: "a", projectName: "Alpha", path: "/a", branch: "main", head: null, isMain: true, missing: false },
 { projectId: "b", projectName: "Front", path: "/b", branch: "main", head: null, isMain: true, missing: false },
 { projectId: "b", projectName: "Front", path: "/b/.wt/x", branch: "x", head: null, isMain: false, missing: false },
 { projectId: "c", projectName: "Back", path: "/c", branch: "main", head: null, isMain: true, missing: false },
];

describe("cwd → 项目解析", () => {
 it("worktree 目录按目录行精确匹配到项目", () => {
  expect(projectIdForPath("/b/.wt/x", checkouts, projects)).toBe("b");
 });

 it("目录行里没有的 cwd 按项目主目录前缀兜底（最长优先）", () => {
  expect(projectIdForPath("/c/sub/dir", checkouts, projects)).toBe("c");
  // 前缀命中多个项目时取最长的那个
  const nested: ProjectView[] = [{ ...projects[0], id: "inner", path: "/a/sub" }];
  expect(projectIdForPath("/a/sub/file.ts", [...checkouts, { projectId: "inner", projectName: "Inner", path: "/a/sub", branch: "main", head: null, isMain: true, missing: false }], [...projects, ...nested])).toBe("inner");
 });

 it("对不上任何项目的目录 → null", () => {
  expect(projectIdForPath("/tmp/ghost", checkouts, projects)).toBeNull();
 });
});
