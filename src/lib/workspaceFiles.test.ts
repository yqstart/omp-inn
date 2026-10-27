import { describe, expect, it } from "vitest";
import type { CheckoutView, ProjectFiles, ProjectView, WorkspaceView } from "@shared/types";
import {
 buildRefItems,
 buildRefTree,
 flattenRefTree,
 highlightName,
 isFileRow,
 joinAbs,
 rankRefItems,
 referenceLabel,
 referenceScope,
 referenceTarget,
 hasWorkspaceRefs,
 relativeToCwd,
 type RefItem,
} from "./workspaceFiles";

function project(id: string, path: string, workspaceId: string | null, missing = false): ProjectView {
 return { id, path, name: id.toUpperCase(), missing, sessionCount: 0, workspaceId };
}

function checkout(path: string, projectId: string, isMain = true): CheckoutView {
 return { projectId, projectName: projectId.toUpperCase(), path, branch: "main", head: null, isMain, missing: false };
}

function group(id: string, projectIds: string[]): WorkspaceView {
 return { id, name: `组-${id}`, createdAt: 0, projectIds };
}

function files(path: string, list: string[], error: string | null = null): ProjectFiles {
 return { path, files: list, truncated: false, error };
}

const item = (rel: string): RefItem => ({ projectId: "p", projectName: "P", rel, abs: `/p/${rel}` });

describe("引用浮层范围（referenceScope）", () => {
 it("多成员工作区：others = 除当前项目外的成员（保持注册顺序）", () => {
  const workspaces = [group("w1", ["be", "fe", "tools"])];
  const projects = [
   project("be", "/p/be", "w1"),
   project("fe", "/p/fe", "w1"),
   project("tools", "/p/tools", "w1"),
  ];
  const checkouts = [checkout("/p/fe", "fe")];
  const scope = referenceScope("/p/fe", workspaces, checkouts, projects);
  expect(scope.primary?.id).toBe("fe");
  expect(scope.others.map((p) => p.id)).toEqual(["be", "tools"]);
 });

 it("未分组 / 单成员工作区：没有其他项目（others 为空，primary 仍在）", () => {
  expect(referenceScope("/p/fe", [], [checkout("/p/fe", "fe")], [project("fe", "/p/fe", null)]))
   .toEqual({ primary: project("fe", "/p/fe", null), others: [] });
  const solo = referenceScope(
   "/p/fe",
   [group("w1", ["fe"])],
   [checkout("/p/fe", "fe")],
   [project("fe", "/p/fe", "w1")],
  );
  expect(solo.others).toEqual([]);
 });

 it("成员目录丢失 / 当前项目目录丢失：剔除与降级", () => {
  const projects = [project("fe", "/p/fe", "w1"), project("be", "/p/be", "w1", true)];
  const scope = referenceScope("/p/fe", [group("w1", ["fe", "be"])], [checkout("/p/fe", "fe")], projects);
  expect(scope.primary?.id).toBe("fe");
  expect(scope.others).toEqual([]);
  expect(referenceScope("/p/fe", [group("w1", ["fe"])], [checkout("/p/fe", "fe")], [project("fe", "/p/fe", "w1", true)]))
   .toEqual({ primary: null, others: [] });
 });

 it("cwd 在 worktree：经目录行命中当前项目", () => {
  const projects = [project("fe", "/p/fe", "w1"), project("be", "/p/be", "w1")];
  const checkouts = [checkout("/p/fe", "fe", false), checkout("/wt/fe-x", "fe", false)];
  const scope = referenceScope("/wt/fe-x", [group("w1", ["fe", "be"])], checkouts, projects);
  expect(scope.primary?.id).toBe("fe");
  expect(scope.others.map((p) => p.id)).toEqual(["be"]);
 });

 it("未知 cwd：两个字段都空", () => {
  expect(referenceScope("/no/such/dir", [group("w1", ["fe"])], [], [project("fe", "/p/fe", "w1")]))
   .toEqual({ primary: null, others: [] });
 });
});

describe("工作区文件引用入口的可用性（hasWorkspaceRefs）", () => {
 const workspaces = [group("w1", ["fe", "be"])];
 const projects = [project("fe", "/p/fe", "w1"), project("be", "/p/be", "w1")];

 it("项目在多成员工作区：可用", () => {
  expect(hasWorkspaceRefs("/p/fe", workspaces, [checkout("/p/fe", "fe")], projects)).toBe(true);
 });

 it("未进入工作区的项目：不可用（没有跨项目可引用）", () => {
  expect(hasWorkspaceRefs("/p/fe", [], [checkout("/p/fe", "fe")], [project("fe", "/p/fe", null)])).toBe(false);
  // 有工作区、但当前项目不在里面
  expect(hasWorkspaceRefs("/p/fe", workspaces, [checkout("/p/fe", "fe")], [project("fe", "/p/fe", null), ...projects.slice(1)]))
   .toBe(false);
 });

 it("单成员工作区 / 其他成员目录丢失 / 未知 cwd：不可用", () => {
  expect(hasWorkspaceRefs("/p/fe", [group("w1", ["fe"])], [checkout("/p/fe", "fe")], [project("fe", "/p/fe", "w1")]))
   .toBe(false);
  expect(hasWorkspaceRefs(
   "/p/fe",
   workspaces,
   [checkout("/p/fe", "fe")],
   [project("fe", "/p/fe", "w1"), project("be", "/p/be", "w1", true)],
  )).toBe(false);
  expect(hasWorkspaceRefs("/no/such/dir", workspaces, [], projects)).toBe(false);
 });
});

describe("候选构建（buildRefItems）", () => {
 it("按项目展开文件、拼绝对路径；error 组跳过；项目名按路径回查", () => {
  const projects = [project("fe", "/p/fe", "w1"), project("be", "/p/be", "w1")];
  const items = buildRefItems(
   [files("/p/fe", ["src/a.ts"]), files("/p/be", [], "fatal: not a git repository"), files("/p/x", ["b.ts"])],
   projects,
  );
  expect(items).toHaveLength(2);
  expect(items[0]).toEqual({ projectId: "fe", projectName: "FE", rel: "src/a.ts", abs: "/p/fe/src/a.ts" });
  expect(items[1]).toEqual({ projectId: "/p/x", projectName: "x", rel: "b.ts", abs: "/p/x/b.ts" });
 });
});

describe("模糊排序（rankRefItems）", () => {
 it("空 query：原序取前 limit 条", () => {
  const items = [item("a.ts"), item("b.ts"), item("c.ts")];
  expect(rankRefItems("  ", items, 2).map((i) => i.rel)).toEqual(["a.ts", "b.ts"]);
 });

 it("打分档位：末段精确 > 末段前缀 > 路径段首/前缀 > 非词边界包含", () => {
  const items = [
   item("apply/inner.ts"), // 文件名的子序列也谈不上（无 a）→ 丢弃
   item("src/capitalize.ts"), // 末段包含但不在词边界（cap|italize 中间）
   item("src/api/x.ts"), // 路径段首
   item("api/x.ts"), // 整串路径前缀（与段首同档，短路径先）
   item("src/api.ts"), // 末段前缀
   item("src/api"), // 末段精确
  ];
  expect(rankRefItems("api", items, 10).map((i) => i.rel)).toEqual([
   "src/api",
   "src/api.ts",
   "api/x.ts",
   "src/api/x.ts",
   "src/capitalize.ts",
  ]);
 });

 it("词边界处包含（x-api-client.ts）优于文件名中间的包含（capitalize.ts）", () => {
  const items = [item("src/utils/capitalize.ts"), item("src/lib/x-api-client.ts")];
  expect(rankRefItems("api", items, 10).map((i) => i.rel)).toEqual([
   "src/lib/x-api-client.ts",
   "src/utils/capitalize.ts",
  ]);
 });

 it("子序列起点有加成：mts 先 main.ts（起点在文件名开头），再 format.ts", () => {
  const items = [item("src/utils/format.ts"), item("src/main.ts")];
  expect(rankRefItems("mts", items, 10).map((i) => i.rel)).toEqual(["src/main.ts", "src/utils/format.ts"]);
 });

 it("子序列只在文件名内、且跨度受限（不再有跨目录假匹配）", () => {
  const items = [
   item("src/assets/approval-menu/approval-mine-selected.svg"), // 跨目录散布的 m-a-i-n → 丢弃
   item("src/main.ts"),
   item("src/mainLayout.vue"),
  ];
  expect(rankRefItems("main", items, 10).map((i) => i.rel)).toEqual(["src/main.ts", "src/mainLayout.vue"]);
  // 紧凑子序列仍可用：mts → main.ts（types.ts 里没有 m）
  expect(rankRefItems("mts", [item("src/main.ts"), item("src/api/types.ts")], 10).map((i) => i.rel))
   .toEqual(["src/main.ts"]);
 });

 it("多词 = 全部命中（AND），分数相加", () => {
  const items = [item("src/api/client.ts"), item("src/api/types.ts"), item("docs/api.md"), item("src/main.ts")];
  // docs/api.md 缺少 "src"；src/main.ts 缺少 "api"
  expect(rankRefItems("src api", items, 10).map((i) => i.rel)).toEqual([
   "src/api/types.ts",
   "src/api/client.ts",
  ]);
 });

 it("大小写不敏感 + 同分按短路径优先", () => {
  const items = [item("zz/api.ts"), item("a/api.ts")];
  expect(rankRefItems("API", items, 10).map((i) => i.rel)).toEqual(["a/api.ts", "zz/api.ts"]);
 });

 it("不匹配的丢弃；limit 生效", () => {
  const items = [item("src/a.ts"), item("src/b.ts"), item("readme.md")];
  expect(rankRefItems("md", items, 10).map((i) => i.rel)).toEqual(["readme.md"]);
  expect(rankRefItems("s", items, 2)).toHaveLength(2);
 });
});

describe("目录树（buildRefTree / flattenRefTree）", () => {
 it("浏览态（默认）：目录在前、同级按名字；同名目录合并；行序号与渲染顺序一致（目录行也参与导航）", () => {
  const rows = flattenRefTree(buildRefTree([
   item("src/main.js"),
   item("src/layout/menu/x.vue"),
   item("README.md"),
   item("src/layout/menu/y.vue"),
  ]));
  expect(rows).toEqual([
   { kind: "dir", name: "src", rel: "src", depth: 0, index: 0 },
   { kind: "dir", name: "layout", rel: "src/layout", depth: 1, index: 1 },
   { kind: "dir", name: "menu", rel: "src/layout/menu", depth: 2, index: 2 },
   { kind: "file", name: "x.vue", item: item("src/layout/menu/x.vue"), depth: 3, index: 3 },
   { kind: "file", name: "y.vue", item: item("src/layout/menu/y.vue"), depth: 3, index: 4 },
   { kind: "file", name: "main.js", item: item("src/main.js"), depth: 1, index: 5 },
   { kind: "file", name: "README.md", item: item("README.md"), depth: 0, index: 6 },
  ]);
  expect(rows.filter(isFileRow)).toHaveLength(4);
 });

 it("搜索态（byRank）：同级按名次排，目录用子树最佳名次浮到最前", () => {
  const items = [item("src/main.ts"), item("src/api/client.ts"), item("README.md")];
  const rows = flattenRefTree(buildRefTree(items, true));
  expect(rows.map((row) => (isFileRow(row) ? row.name : `${row.name}/`))).toEqual([
   "src/",
   "main.ts",
   "api/",
   "client.ts",
   "README.md",
  ]);
 });

 it("空段 / 顶层文件都不炸", () => {
  const rows = flattenRefTree(buildRefTree([item("a.ts"), item("")]));
  expect(rows).toEqual([{ kind: "file", name: "a.ts", item: item("a.ts"), depth: 0, index: 0 }]);
 });

 it("折叠目录：目录行保留、整棵子树跳过、行序号仍连续（目录行也占一位）", () => {
  const tree = buildRefTree([
   item("src/main.js"),
   item("src/layout/menu/x.vue"),
   item("README.md"),
  ]);
  expect(flattenRefTree(tree, (rel) => rel === "src")).toEqual([
   { kind: "dir", name: "src", rel: "src", depth: 0, index: 0 },
   { kind: "file", name: "README.md", item: item("README.md"), depth: 0, index: 1 },
  ]);
  // 折叠内层：只跳它自己的子树，外层不受影响
  const rows = flattenRefTree(tree, (rel) => rel === "src/layout");
  expect(rows.map((row) => (isFileRow(row) ? row.name : `${row.name}/`))).toEqual([
   "src/",
   "layout/",
   "main.js",
   "README.md",
  ]);
  expect(rows.map((row) => row.index)).toEqual([0, 1, 2, 3]);
 });
});

describe("命中高亮（highlightName）", () => {
 it("连续词整段命中；子序列逐字符命中；无命中不标记", () => {
  expect(highlightName("main.ts", ["main"])).toEqual([
   { text: "main", hit: true },
   { text: ".ts", hit: false },
  ]);
  expect(highlightName("main.ts", ["mts"])).toEqual([
   { text: "m", hit: true },
   { text: "ain.", hit: false },
   { text: "ts", hit: true },
  ]);
  expect(highlightName("client.ts", ["api"])).toEqual([{ text: "client.ts", hit: false }]);
 });
});

describe("路径拼接（joinAbs）", () => {
 it("根带尾斜杠不产生双斜杠", () => {
  expect(joinAbs("/a/", "x.ts")).toBe("/a/x.ts");
  expect(joinAbs("/a", "sub/x.ts")).toBe("/a/sub/x.ts");
 });
});

describe("引用路径口径（相对优先，绝对兜底）", () => {
 it("会话目录内的条目给相对路径", () => {
  expect(relativeToCwd("/w/alpha", "/w/alpha/src/a.ts")).toBe("src/a.ts");
  expect(relativeToCwd("/w/alpha/", "/w/alpha/src/a.ts")).toBe("src/a.ts");
  expect(referenceTarget("/w/alpha", "/w/alpha/src/a.ts")).toBe("src/a.ts");
 });

 it("目录本身 / 目录外的条目：不给相对路径（保留绝对路径）", () => {
  // 会话目录自己
  expect(relativeToCwd("/w/alpha", "/w/alpha")).toBeNull();
  expect(relativeToCwd("/w/alpha", "/w/alpha/")).toBeNull();
  // 同前缀但不是子目录（`/w/alpha-2` 不是 `/w/alpha` 的子路径）
  expect(relativeToCwd("/w/alpha", "/w/alpha-2/a.ts")).toBeNull();
  // 上一层（跨项目）：绝不用 `../` 把解析引到别的目录
  expect(relativeToCwd("/w/alpha", "/w/beta/a.ts")).toBeNull();
  expect(referenceTarget("/w/alpha", "/w/beta/a.ts")).toBe("/w/beta/a.ts");
 });

 it("含空格 / 中文路径照样相对化", () => {
  expect(referenceTarget("/w/alpha", "/w/alpha/docs/设计 稿.md")).toBe("docs/设计 稿.md");
 });

 it("芯片短名：文件给名字，目录补尾斜杠", () => {
  expect(referenceLabel("src/components/FileTree.tsx", false)).toBe("FileTree.tsx");
  expect(referenceLabel("src/components", true)).toBe("components/");
  expect(referenceLabel("/abs/path/dir/", true)).toBe("dir/");
  expect(referenceLabel("a.ts", false)).toBe("a.ts");
 });
});
