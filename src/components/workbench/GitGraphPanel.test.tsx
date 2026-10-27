// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeSet, GitCommitDetail, GitGraphCommit, GitGraphPage } from "@shared/types";
import { useApp } from "../../stores/app";
import { TEXT } from "../../lib/locale";

/**
 * 右栏「Git 图谱」页签（V51）：提交图渲染 / 搜索过滤 / 分页 / 提交详情 / diff 弹窗。
 * 后端三条 git 命令整块 mock——本用例只验证面板的取数口径与交互。
 */
const { apiMock } = vi.hoisted(() => ({
 apiMock: {
  gitGraph: vi.fn(),
  getChangeSet: vi.fn(),
  gitCommitDetail: vi.fn(),
  gitCommitDiff: vi.fn(),
  gitFileDiff: vi.fn(),
 },
}));
vi.mock("@shared/api", () => ({ api: apiMock }));

import { GitGraphPanel } from "./GitGraphPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const zh = TEXT["zh-CN"];
const CWD = "/w/alpha";

const commits: GitGraphCommit[] = [
 {
  hash: "m1",
  parents: ["a1", "b1"],
  author: "张三",
  email: "z@x",
  at: 1_700_000_000,
  subject: "merge feat",
  refs: [
   { name: "main", kind: "head" },
   { name: "origin/main", kind: "remote" },
  ],
 },
 { hash: "a1", parents: ["r1"], author: "张三", email: "z@x", at: 1_699_999_000, subject: "feat: a", refs: [] },
 { hash: "b1", parents: ["r1"], author: "李四", email: "l@x", at: 1_699_998_000, subject: "feat: b", refs: [] },
 { hash: "r1", parents: [], author: "张三", email: "z@x", at: 1_699_997_000, subject: "root", refs: [] },
];

const page = (over: Partial<GitGraphPage> = {}): GitGraphPage => ({
 isRepo: true,
 root: CWD,
 branch: "main",
 branches: [
  { name: "main", ref: "refs/heads/main", kind: "branch" },
  { name: "origin/main", ref: "refs/remotes/origin/main", kind: "remote" },
 ],
 commits,
 hasMore: false,
 ...over,
});

const changes: ChangeSet = {
 isRepo: true,
 branch: "main",
 head: null,
 upstream: null,
 upstreamGone: false,
 ahead: 0,
 behind: 0,
 files: [{ path: "w.txt", origPath: null, index: " ", worktree: "M", untracked: false, add: 2, del: 1 }],
};

const detail: GitCommitDetail = {
 hash: "a1",
 parents: ["r1"],
 author: "张三",
 authorEmail: "z@x",
 at: 1_699_999_000,
 subject: "feat: a",
 body: "正文说明",
 bodyTruncated: false,
 files: [{ path: "a.txt", origPath: null, status: "M", add: 1, del: 0, binary: false }],
 filesTruncated: false,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
 vi.clearAllMocks();
 apiMock.gitGraph.mockResolvedValue(page());
 apiMock.getChangeSet.mockResolvedValue(changes);
 apiMock.gitCommitDetail.mockResolvedValue(detail);
 apiMock.gitCommitDiff.mockResolvedValue({ kind: "diff", text: "diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-a\n+new", truncated: false });
 apiMock.gitFileDiff.mockResolvedValue({ kind: "diff", text: "diff --git a/w.txt b/w.txt\n+changed" });
 useApp.setState({ locale: "zh-CN" });
 container = document.createElement("div");
 document.body.append(container);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
});

async function render(visible = true) {
 await act(async () => {
  root.render(<GitGraphPanel cwd={CWD} visible={visible} />);
 });
}

/** 受控输入要经原生 setter + input 事件，React 才认这次改动。 */
function setInput(el: HTMLInputElement, value: string) {
 const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
 setter?.call(el, value);
 el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("GitGraphPanel", () => {
 it("拉提交历史与未提交改动：渲染提交行、引用 chip 与工作区行", async () => {
  await render();
  expect(apiMock.gitGraph).toHaveBeenCalledWith(CWD, null, 200, 0);
  expect(apiMock.getChangeSet).toHaveBeenCalledWith(CWD);
  expect(container.querySelectorAll("[data-commit]")).toHaveLength(4);
  expect(container.textContent).toContain("merge feat");
  expect(container.textContent).toContain("feat: b");
  expect(container.textContent).toContain("main");
  expect(container.textContent).toContain("origin/main");
  expect(container.textContent).toContain(zh.graphUncommitted);
 });

 it("点提交 = 取详情并列出文件；点文件 = 取提交内 diff", async () => {
  await render();
  await act(async () => {
   container.querySelector<HTMLButtonElement>('[data-commit="a1"]')?.click();
  });
  expect(apiMock.gitCommitDetail).toHaveBeenCalledWith(CWD, "a1");
  expect(container.textContent).toContain("正文说明");
  expect(container.textContent).toContain("a.txt");

  await act(async () => {
   container.querySelector<HTMLButtonElement>('[data-diff-path="a.txt"]')?.click();
  });
  expect(apiMock.gitCommitDiff).toHaveBeenCalledWith(CWD, "a1", "a.txt");
  expect(container.textContent).toContain("+new");
 });

 it("点未提交改动行 = 列工作区文件；点文件 = 打开工作区 diff", async () => {
  await render();
  const working = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
   b.textContent?.includes(zh.graphUncommitted),
  );
  await act(async () => {
   working?.click();
  });
  expect(container.textContent).toContain("w.txt");
  await act(async () => {
   container.querySelector<HTMLButtonElement>('[data-diff-path="w.txt"]')?.click();
  });
  expect(apiMock.gitFileDiff).toHaveBeenCalledWith(`${CWD}/w.txt`);
  expect(container.textContent).toContain("+changed");
 });

 it("刷新后未提交改动消失：工作区行与详情一起退场", async () => {
  await render();
  const working = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
   b.textContent?.includes(zh.graphUncommitted),
  );
  await act(async () => {
   working?.click();
  });
  expect(container.textContent).toContain("w.txt");

  apiMock.getChangeSet.mockResolvedValue({ ...changes, files: [] });
  await act(async () => {
   container.querySelector<HTMLButtonElement>(`button[aria-label="${zh.filesRefresh}"]`)?.click();
  });
  expect(container.textContent).not.toContain(zh.graphUncommitted);
  expect(container.textContent).not.toContain("w.txt");
 });

 it("文本筛选只作用于已加载提交，图谱按可见集合重算", async () => {
  await render();
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${zh.graphFilterPlaceholder}"]`);
  expect(input).not.toBeNull();
  await act(async () => {
   setInput(input!, "feat: b");
  });
  expect(container.querySelectorAll("[data-commit]")).toHaveLength(1);
  expect(container.querySelector('[data-commit="b1"]')).not.toBeNull();
  await act(async () => {
   setInput(input!, "zzz");
  });
  expect(container.textContent).toContain(zh.graphNoMatch);
 });

 it("有下一页时「加载更多」按已加载条数跳页", async () => {
  apiMock.gitGraph.mockResolvedValueOnce(page({ commits: commits.slice(0, 2), hasMore: true }));
  apiMock.gitGraph.mockResolvedValueOnce(page({ commits: commits.slice(2), hasMore: false }));
  await render();
  expect(container.querySelectorAll("[data-commit]")).toHaveLength(2);
  const more = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
   b.textContent?.includes(zh.graphLoadMore),
  );
  await act(async () => {
   more?.click();
  });
  expect(apiMock.gitGraph).toHaveBeenLastCalledWith(CWD, null, 200, 2);
  expect(container.querySelectorAll("[data-commit]")).toHaveLength(4);
  expect(container.textContent).not.toContain(zh.graphLoadMore);
 });

 it("不是 git 仓库时给空态文案", async () => {
  apiMock.gitGraph.mockResolvedValue(
   page({ isRepo: false, root: null, branch: null, branches: [], commits: [], hasMore: false }),
  );
  await render();
  expect(container.textContent).toContain(zh.graphNotRepo);
 });

 it("页签没显示过就不拉数据", async () => {
  await render(false);
  expect(apiMock.gitGraph).not.toHaveBeenCalled();
  expect(apiMock.getChangeSet).not.toHaveBeenCalled();
 });
});
