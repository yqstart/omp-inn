// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApp } from "../../stores/app";
import { DiffDialog } from "./DiffDialog";

/**
 * 「查看改动」弹窗：三种 kind（diff 逐行着色 / untracked 全文新增 / none 文案）。
 */
const mock = vi.hoisted(() => ({
 gitFileDiff: vi.fn(async () => ({ kind: "none", text: "" })),
}));
vi.mock("@shared/api", () => ({ api: { gitFileDiff: mock.gitFileDiff } }));

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
 mock.gitFileDiff.mockResolvedValue({ kind: "none", text: "" });
 useApp.setState({ diffPath: null, locale: "zh-CN" });
 container = document.createElement("div");
 document.body.append(container);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
});

async function render(path: string | null) {
 act(() => useApp.setState({ diffPath: path }));
 await act(async () => {
  root.render(<DiffDialog />);
 });
}

describe("DiffDialog", () => {
 it("kind=diff：逐行按前缀着色", async () => {
  mock.gitFileDiff.mockResolvedValue({
   kind: "diff",
   text: "diff --git a/f b/f\nindex 1..2\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n context",
  });
  await render("/w/f");
  expect(mock.gitFileDiff).toHaveBeenCalledWith("/w/f");
  const pre = container.querySelector("pre")!;
  const rows = Array.from(pre.querySelectorAll("div"));
  expect(rows.map((r) => r.className)).toEqual([
   "text-faint",
   "text-faint",
   "text-faint",
   "text-faint",
   "text-accent",
   "text-danger",
   "text-ok",
   "text-muted",
  ]);
  expect(container.querySelector("div[title]")?.getAttribute("title")).toBe("/w/f");
 });

 it("kind=untracked：顶部提示 + 全文按新增", async () => {
  mock.gitFileDiff.mockResolvedValue({ kind: "untracked", text: "a\nb" });
  await render("/w/new");
  expect(container.textContent).toContain("新文件（未跟踪）全文");
  const rows = Array.from(container.querySelectorAll("pre div"));
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.className === "text-ok")).toBe(true);
 });

 it("kind=none：显示无改动文案", async () => {
  await render("/w/same");
  expect(container.textContent).toContain("与 HEAD 相比暂无改动");
 });
});
