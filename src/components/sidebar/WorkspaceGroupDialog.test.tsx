// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "@shared/api";
import type { ProjectView } from "@shared/types";
import { useApp } from "../../stores/app";
import { WorkspaceGroupDialog } from "./WorkspaceGroupDialog";

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("@shared/api", () => ({
 api: {
  addProject: vi.fn(async () => null),
  listProjects: vi.fn(async () => []),
  createWorkspace: vi.fn(async () => null),
  updateWorkspace: vi.fn(async () => undefined),
  deleteWorkspace: vi.fn(async () => undefined),
 },
}));

const EXISTING: ProjectView = { id: "pa", path: "/tmp/alpha", name: "alpha", missing: false, sessionCount: 0, workspaceId: null };
const NEWBIE: ProjectView = { id: "pn", path: "/tmp/newproj", name: "newproj", missing: false, sessionCount: 0, workspaceId: null };

let container: HTMLDivElement;
let root: Root;
let closed = 0;
const changed = vi.fn(async () => undefined);

beforeEach(() => {
 vi.clearAllMocks();
 closed = 0;
 useApp.setState({ projects: [EXISTING], workspaceGroups: [], locale: "zh-CN" });
 container = document.createElement("div");
 document.body.append(container);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
});

function renderDialog(): void {
 act(() => {
  root.render(
   <WorkspaceGroupDialog
    group={null}
    onClose={() => {
     closed += 1;
    }}
    onChanged={changed}
   />,
  );
 });
}

function byText(text: string): HTMLElement | null {
 return [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text) ?? null;
}

async function click(el: HTMLElement): Promise<void> {
 await act(async () => {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
 });
}

describe("工作区对话框：就地添加本地目录", () => {
 it("选目录 → 新项目进列表并自动勾选 → 创建时作为成员提交", async () => {
  vi.mocked(open).mockResolvedValue("/tmp/newproj");
  vi.mocked(api.addProject).mockResolvedValue(NEWBIE);
  vi.mocked(api.listProjects).mockResolvedValue([EXISTING, NEWBIE]);
  vi.mocked(api.createWorkspace).mockResolvedValue({ id: "w9", name: "新组", createdAt: 0, projectIds: ["pn"] });
  renderDialog();

  const add = byText("添加本地目录");
  expect(add).not.toBeNull();
  await click(add as HTMLElement);
  expect(vi.mocked(api.addProject)).toHaveBeenCalledWith("/tmp/newproj");

  // 新项目出现在列表里且已勾选
  const boxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(boxes.length).toBe(2);
  const newBox = boxes.find((b) => (b.closest("label")?.textContent ?? "").includes("newproj"));
  expect(newBox?.checked).toBe(true);
  // 左栏跟着刷新（新项目的目录行随后到达）
  expect(changed).toHaveBeenCalled();

  // 填名字 → 创建：成员集合含新项目
  const nameInput = container.querySelector<HTMLInputElement>('input[type="text"], input:not([type="checkbox"])');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
   setter?.call(nameInput, "新组");
   nameInput?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(byText("创建") as HTMLElement);
  expect(vi.mocked(api.createWorkspace)).toHaveBeenCalledWith("新组", ["pn"]);
  expect(closed).toBe(1);
 });

 it("取消目录选择不报错、不新增项目", async () => {
  vi.mocked(open).mockResolvedValue(null);
  renderDialog();
  await click(byText("添加本地目录") as HTMLElement);
  expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(1);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(vi.mocked(api.addProject)).not.toHaveBeenCalled();
 });

 it("添加失败就地显示错误（模态遮着侧栏，错误必须在这一层可见）", async () => {
  vi.mocked(open).mockResolvedValue("/tmp/bad");
  vi.mocked(api.addProject).mockRejectedValue(new Error("目录不存在，只能移除或重定位"));
  renderDialog();
  await click(byText("添加本地目录") as HTMLElement);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("目录不存在");
 });
});
