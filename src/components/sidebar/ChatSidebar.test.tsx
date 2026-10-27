// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectView, SessionView } from "@shared/types";
import { useApp } from "../../stores/app";
import { fmt, TEXT } from "../../lib/locale";
import { ChatSidebar } from "./ChatSidebar";

/** `vi.mock` 的工厂会被提升：用 `vi.hoisted` 拿能在用例里改行为的 mock。 */
const mock = vi.hoisted(() => ({
 listSessions: vi.fn(),
 listProjects: vi.fn(async () => [] as unknown[]),
 listWorkspaces: vi.fn(async () => [] as unknown[]),
 listCheckouts: vi.fn(async () => [] as unknown[]),
 createWorkspace: vi.fn(),
 updateWorkspace: vi.fn(async () => undefined),
 deleteWorkspace: vi.fn(async () => undefined),
 deleteSessions: vi.fn(),
 archiveSessions: vi.fn(),
 removeProject: vi.fn(async () => undefined),
 moveProject: vi.fn(async () => [] as unknown[]),
 pullWorkspace: vi.fn(),
}));
vi.mock("@shared/api", () => ({
 api: {
  listSessions: mock.listSessions,
  listProjects: mock.listProjects,
  listWorkspaces: mock.listWorkspaces,
  listCheckouts: mock.listCheckouts,
  createWorkspace: mock.createWorkspace,
  updateWorkspace: mock.updateWorkspace,
  deleteWorkspace: mock.deleteWorkspace,
  deleteSessions: mock.deleteSessions,
  archiveSessions: mock.archiveSessions,
  removeProject: mock.removeProject,
  moveProject: mock.moveProject,
  pullWorkspace: mock.pullWorkspace,
 },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
 openPath: vi.fn(async () => undefined),
 openUrl: vi.fn(async () => undefined),
 revealItemInDir: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.10.0") }));

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

const P1: ProjectView = { id: "p1", path: "/w/alpha", name: "alpha", missing: false, sessionCount: 2, workspaceId: "w1" };
const P2: ProjectView = { id: "p2", path: "/w/beta", name: "beta", missing: false, sessionCount: 1, workspaceId: "w1" };
const P3: ProjectView = { id: "p3", path: "/w/solo", name: "solo", missing: false, sessionCount: 0, workspaceId: null };
/** 覆盖层里的工作区（P1 / P2 的归属）：store 预置与后端回包必须是同一份——
 *  冷启动会把两份一起拉回来（`loadCheckouts`），夹具里两处不一致就会互相顶掉。 */
const W1 = { id: "w1", name: "全栈", createdAt: 0, projectIds: ["p1", "p2"] };

/** 会话行相对时间的锚点：用「相对当前」的时间戳，断言「5分 / 3小时 / 2天」（测试间不跨档）。 */
const NOW = Date.now();
const MIN = 60_000;

const session = (id: string, projectId: string | null, title: string, archived = false, timestamp = NOW - 5 * MIN): SessionView => ({
 id,
 projectId,
 title,
 cwd: projectId === "p1" ? "/w/alpha" : projectId === "p2" ? "/w/beta" : "/tmp/scratch",
 timestamp,
 archived,
 corrupt: false,
 note: null,
 running: false,
});

const SESSIONS: SessionView[] = [
 session("s1", "p1", "登录页重构"),
 session("s2", "p2", "后端接口联调", false, NOW - 3 * 60 * MIN),
 session("s3", null, "游离会话", false, NOW - 2 * 24 * 60 * MIN),
 session("s4", "p1", "已归档的旧会话", true),
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
 mock.listSessions.mockReset();
 mock.listSessions.mockResolvedValue({ sessions: SESSIONS, totalFiles: 4, scannedFiles: 4 });
 mock.listProjects.mockReset();
 mock.listProjects.mockResolvedValue([]);
 mock.listWorkspaces.mockReset();
 mock.listWorkspaces.mockResolvedValue([W1]);
 mock.listCheckouts.mockReset();
 mock.listCheckouts.mockResolvedValue([]);
 mock.createWorkspace.mockReset();
 mock.updateWorkspace.mockReset();
 mock.deleteWorkspace.mockReset();
 mock.deleteSessions.mockReset();
 mock.deleteSessions.mockImplementation(async (ids: string[]) => ({ ok: ids.length, failed: [] }));
 mock.archiveSessions.mockReset();
 mock.archiveSessions.mockImplementation(async (ids: string[]) => ({ ok: ids.length, failed: [] }));
 mock.removeProject.mockReset();
 mock.removeProject.mockResolvedValue(undefined);
 mock.moveProject.mockReset();
 mock.moveProject.mockResolvedValue([]);
 mock.pullWorkspace.mockReset();
 mock.pullWorkspace.mockResolvedValue({ status: "up-to-date", conflicts: [], detail: "" });
 // 「上次选中的会话」（启动展开口径的数据源）：默认清掉，用例自己造
 localStorage.removeItem("omp.lastSession.v1");
 useApp.setState({
  projects: [P1, P2],
  workspaceGroups: [W1],
  sessions: [],
  activeSessionId: null,
  locale: "zh-CN",
  workspaceGitStates: {},
  commitTasks: {},
  pullStates: {},
  pullConflictCwd: null,
  // 会话行状态点由这两份运行期状态派生：默认清掉，用例自己造（否则用例之间互相污染）
  statusBySession: {},
  unreadBySession: {},
 });
 container = document.createElement("div");
 document.body.append(container);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
});

/** 渲染并等 `list_sessions` 那一趟落地。 */
async function open(): Promise<void> {
 await act(async () => {
  root.render(<ChatSidebar />);
 });
 await act(async () => { });
}

function summaryFor(text: string): HTMLElement {
 const el = [...container.querySelectorAll<HTMLElement>("summary")].find((s) => (s.textContent ?? "").includes(text));
 if (!el) throw new Error(`summary 不存在：${text}`);
 return el;
}

describe("聊天侧栏的工作区分段（V21 容器在聊天形态的投影）", () => {
 it("有自定义工作区：按组分段，工作区头带成员数，会话挂在自己的项目下", async () => {
  await open();
  const text = container.textContent ?? "";
  expect(text).toContain("全栈");
  // 工作区头的成员计数（`wsGroupCount` = 「N 个项目」）
  expect(container.querySelector('[aria-label="2 个项目"]')).not.toBeNull();
  // 会话按项目落在工作区段内：段里同时有项目名与它会话的标题
  const section = container.querySelector("details.group\\/ws");
  expect(section?.textContent).toContain("alpha");
  expect(section?.textContent).toContain("登录页重构");
  expect(section?.textContent).toContain("后端接口联调");
  // 未归属会话仍在（它不属于任何项目）
  expect(text).toContain("游离会话");
  // 已归档的会话不列
  expect(text).not.toContain("已归档的旧会话");
 });

 it("未进组的项目：进「未分组」段（同一个分段排布）", async () => {
  act(() => {
   useApp.setState({ projects: [P1, P3] });
  });
  await open();
  const text = container.textContent ?? "";
  expect(text).toContain("全栈");
  expect(text).toContain("未分组");
  expect(text).toContain("solo");
 });

 it("冷启动（内存 store 全空）：工作区清单与项目一起拉回来，不塌成平铺", async () => {
  // 重启后的真实状态：内存 store 是空的，覆盖层里工作区与归属都还在（后端数据没丢）
  act(() => {
   useApp.setState({ projects: [], workspaceGroups: [] });
  });
  mock.listProjects.mockResolvedValue([P1, P2]);
  mock.listWorkspaces.mockResolvedValue([W1]);
  await open();
  expect(mock.listWorkspaces, "冷启动必须拉工作区清单").toHaveBeenCalled();
  expect(mock.listCheckouts, "冷启动也要补目录行（worktree 的引用范围 / 上游提示靠它）").toHaveBeenCalled();
  expect(container.querySelector("details.group\\/ws"), "工作区段应渲染").not.toBeNull();
  expect(container.textContent).toContain("全栈");
 });

 it("没有自定义工作区：平铺（不出现工作区头 / 未分组段）", async () => {
  act(() => {
   useApp.setState({ workspaceGroups: [], projects: [{ ...P1, workspaceId: null }, { ...P2, workspaceId: null }] });
  });
  mock.listWorkspaces.mockResolvedValue([]);
  await open();
  const text = container.textContent ?? "";
  expect(text).not.toContain("未分组");
  expect(container.querySelector("details.group\\/ws")).toBeNull();
  expect(text).toContain("alpha");
  expect(text).toContain("登录页重构");
 });
});

/**
 * 顶层分组的启动展开口径（2026-10-19 用户口径）：app 打开时**只展开第一个**工作区 / 项目，
 * 其余收着；上次关闭时选中的会话所在的那一个优先（记录与启动恢复同源：`lib/lastSession.ts`）。
 * 开合是受控的（`open` + `onToggle`）：系统只播种一次，之后随用户点击。
 */
describe("顶层分组的启动展开口径", () => {
 const P4: ProjectView = { id: "p4", path: "/w/data", name: "delta", missing: false, sessionCount: 0, workspaceId: "w2" };
 const W2 = { id: "w2", name: "数据组", createdAt: 0, projectIds: ["p4"] };

 /** 两个工作区（w1 = 全栈：alpha / beta；w2 = 数据组：delta）——用来区分「第一个」与「上次会话所在」。 */
 function twoSections(): void {
  act(() => {
   useApp.setState({ projects: [P1, P2, P4], workspaceGroups: [W1, W2] });
  });
  mock.listWorkspaces.mockResolvedValue([W1, W2]);
 }

 const sectionStates = (): boolean[] =>
  [...container.querySelectorAll<HTMLDetailsElement>("details.group\\/ws")].map((s) => s.open);
 const sectionHeads = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>("details.group\\/ws > summary")];

 it("有工作区：只展开第一个段，其余收着", async () => {
  twoSections();
  await open();
  expect(sectionStates()).toEqual([true, false]);
 });

 it("上次关闭时选中的会话在第二个段：展开的是那一个（不是第一个）", async () => {
  localStorage.setItem(
   "omp.lastSession.v1",
   JSON.stringify({ id: "s7", projectId: "p4", title: "数据迁移", cwd: "/w/data" }),
  );
  twoSections();
  await open();
  expect(sectionStates()).toEqual([false, true]);
 });

 it("平铺（没有工作区）：只展开第一个项目块", async () => {
  act(() => {
   useApp.setState({ workspaceGroups: [], projects: [{ ...P1, workspaceId: null }, { ...P4, workspaceId: null }] });
  });
  mock.listWorkspaces.mockResolvedValue([]);
  await open();
  const states = ["p1", "p4"].map((id) => container.querySelector<HTMLDetailsElement>(`[data-proj-row="${id}"]`)?.open);
  expect(states).toEqual([true, false]);
 });

 it("用户点击：收起第一个段、展开第二个段（受控开合跟着点击走）", async () => {
  twoSections();
  await open();
  await click(sectionHeads()[0]);
  expect(sectionStates(), "点段头即收起").toEqual([false, false]);
  await click(sectionHeads()[1]);
  expect(sectionStates(), "点另一个段头即展开").toEqual([false, true]);
 });
});

describe("项目分组头的行内悬浮图标（V43）", () => {
 it("行内四键 = 新建会话 / 移除项目 / 归档全部 / 删除全部；「提交」入口已移除", async () => {
  const t = TEXT["zh-CN"];
  await open();
  expect(container.querySelector(`button[aria-label="${t.gitCommitTitle}"]`), "提交入口应移除").toBeNull();
  expect(container.querySelector(`button[aria-label="${fmt(t.newSessionIn, "alpha")}"]`), "新建会话").not.toBeNull();
  expect(container.querySelector(`button[aria-label="${t.projRemove}"]`), "移除项目").not.toBeNull();
  expect(container.querySelector(`button[aria-label="${fmt(t.archiveAllIn, "alpha")}"]`), "归档全部").not.toBeNull();
  expect(container.querySelector(`button[aria-label="${fmt(t.deleteAllIn, "alpha")}"]`), "删除全部").not.toBeNull();
 });

 it("点「移除项目」→ 二次确认 → remove_project（只解绑，不删文件）", async () => {
  const t = TEXT["zh-CN"];
  await open();
  await click(container.querySelector<HTMLButtonElement>(`button[aria-label="${t.projRemove}"]`));
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.getAttribute("aria-label")).toBe(fmt(t.projRemoveTitle, "alpha"));
  expect(dialog?.textContent).toContain(t.projRemoveBody);
  const confirm = [...(dialog?.querySelectorAll("button") ?? [])].at(-1)!;
  await act(async () => {
   confirm.click();
  });
  expect(mock.removeProject).toHaveBeenCalledWith("p1");
 });

 it("点「归档全部」→ 归档该项目进行中的对话（已归档的除外）", async () => {
  const t = TEXT["zh-CN"];
  await open();
  await click(container.querySelector<HTMLButtonElement>(`button[aria-label="${fmt(t.archiveAllIn, "alpha")}"]`));
  expect(mock.archiveSessions).toHaveBeenCalledWith(["s1"]);
 });

 it("点「删除全部对话」→ 二次确认 → 只删该项目进行中的对话（已归档的除外）", async () => {
  const t = TEXT["zh-CN"];
  await open();
  await click(container.querySelector<HTMLButtonElement>(`button[aria-label="${fmt(t.deleteAllIn, "alpha")}"]`));
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.getAttribute("aria-label")).toBe(t.sessDeleteAllConfirm.replace("{0}", "1"));
  expect(dialog?.textContent).toContain(t.sessDeleteAllDetail);
  const confirm = [...(dialog?.querySelectorAll("button") ?? [])].at(-1)!;
  await act(async () => {
   confirm.click();
  });
  // alpha 列的进行中会话只有 s1；已归档的 s4 不在列表里，也不许被删
  expect(mock.deleteSessions).toHaveBeenCalledWith(["s1"]);
 });

 it("远程有落后提交时显示拉取徽章（下载图标），点击直接拉取", async () => {
  act(() => {
   useApp.setState({
    workspaceGitStates: { "/w/alpha": { path: "/w/alpha", isRepo: true, dirty: false, ahead: 0, behind: 8, upstream: "origin/main", upstreamGone: false } },
    commitTasks: {},
   });
  });
  await open();
  const badge = container.querySelector<HTMLButtonElement>(`button[aria-label="${fmt(TEXT["zh-CN"].gitPullTitle, 8)}"]`);
  expect(badge, "拉取徽章应渲染").not.toBeNull();
  expect(badge?.textContent).toContain("8");
  await act(async () => {
   badge!.click();
  });
  expect(mock.pullWorkspace).toHaveBeenCalledWith("/w/alpha");
 });

 it("有未推送提交时分组头显示待推送徽章（点击走推送）", async () => {
  act(() => {
   useApp.setState({
    workspaceGitStates: { "/w/alpha": { path: "/w/alpha", isRepo: true, dirty: false, ahead: 3, behind: 0, upstream: "origin/main", upstreamGone: false } },
    commitTasks: {},
   });
  });
  await open();
  const badge = container.querySelector(`button[aria-label="${TEXT["zh-CN"].gitPushTitle.replace("{0}", "3")}"]`);
  expect(badge, "待推送徽章应渲染").not.toBeNull();
  expect(badge?.textContent).toContain("3");
 });

 it("改名后的实时标题覆盖扫描行的旧标题", async () => {
  await open();
  expect(container.textContent).toContain("登录页重构");
  act(() => {
   useApp.setState({
    sessions: [{ id: "s1", projectId: "p1", title: "改名后的标题", cwd: "/w/alpha", timestamp: 1, archived: false, corrupt: false, note: "改名后的标题", running: true }],
   });
  });
  expect(container.textContent).toContain("改名后的标题");
 });
});

describe("会话行的状态点（DeepSeek Harness 口径：待处理 > 运行中 > 已完成 > 空闲）", () => {
 /** 行内定位：标题所在的那一行（`div.h-8` 是会话行 / 项目头的行高）。 */
 const rowOf = (title: string): HTMLElement | undefined =>
  [...container.querySelectorAll<HTMLElement>("div.h-8")].find((el) => (el.textContent ?? "").includes(title));

 it("打开过的会话：running 由实时状态派生——任务跑完转圈环立即消失，不被打开时的快照钉死", async () => {
  const t = TEXT["zh-CN"];
  // 场景：会话打开时没在跑（store 行落 open 时刻的 running=false 快照），随后任务开跑。
  useApp.setState({
   sessions: [session("s1", "p1", "登录页重构")],
   activeSessionId: "s1",
   statusBySession: { s1: { state: "running" } },
  });
  await open();
  expect(container.querySelector(`[aria-label="${t.statusRunning}"]`), "任务在跑：转圈环亮").not.toBeNull();
  // 任务完成：状态收敛 idle（omp-status 推送）——store 行的 running 快照没人更新
  act(() => {
   useApp.setState({ statusBySession: { s1: { state: "idle" } } });
  });
  expect(container.querySelector(`[aria-label="${t.statusRunning}"]`), "跑完：转圈环必须消失").toBeNull();
 });

 it("没打开过的会话：照旧用扫描行的 running 快照", async () => {
  const t = TEXT["zh-CN"];
  mock.listSessions.mockResolvedValue({
   sessions: [{ ...session("s1", "p1", "登录页重构"), running: true }],
   totalFiles: 1,
   scannedFiles: 1,
  });
  useApp.setState({ statusBySession: {} });
  await open();
  expect(container.querySelector(`[aria-label="${t.statusRunning}"]`), "扫描快照的转圈环不受影响").not.toBeNull();
 });

 it("等审批 / 等回答：主状态是待处理（橙点），行尾时间换成「待处理」标签", async () => {
  const t = TEXT["zh-CN"];
  useApp.setState({
   sessions: [session("s1", "p1", "登录页重构")],
   activeSessionId: "s1",
   statusBySession: { s1: { state: "awaiting-approval" } },
  });
  await open();
  expect(container.querySelector(`[aria-label="${t.statusAwaiting}"]`), "待处理点亮").not.toBeNull();
  expect(container.querySelector(`[aria-label="${t.statusRunning}"]`), "待处理压过运行中：不同时显示转圈环").toBeNull();
  const row = rowOf("登录页重构");
  const tag = [...(row?.querySelectorAll("span") ?? [])].find((el) => el.textContent === t.statusAwaitingTag && el.children.length === 0);
  expect(tag, "行尾换成待处理标签").not.toBeUndefined();
  expect(tag?.className, "待处理标签走 warn 色").toContain("text-warn");
  expect(tag?.getAttribute("title"), "悬停里仍能看到完整时间").toContain(String(new Date(NOW - 5 * MIN).getFullYear()));
  expect(row?.textContent, "行内相对时间被状态取代").not.toContain("5分");
 });

 it("后台跑完未读：给绿点（不再是行尾的对勾），位置在标题之前的行首槽里", async () => {
  const t = TEXT["zh-CN"];
  await open();
  act(() => {
   useApp.setState({ unreadBySession: { s1: true } });
  });
  const row = rowOf("登录页重构");
  const dot = row?.querySelector<HTMLElement>(`[aria-label="${t.statusDone}"]`);
  expect(dot, "完成未读点渲染").not.toBeNull();
  expect(dot?.dataset.state, "绿点走 done 档").toBe("done");
  const title = [...(row?.querySelectorAll("span") ?? [])].find((el) => el.textContent === "登录页重构");
  expect(title, "标题仍在").not.toBeUndefined();
  const order = dot !== null && dot !== undefined && title !== undefined ? dot.compareDocumentPosition(title) : 0;
  expect(order & Node.DOCUMENT_POSITION_FOLLOWING, "状态点在标题之前（行首槽）").toBeTruthy();
  act(() => {
   useApp.setState({ unreadBySession: {} });
  });
  expect(container.querySelector(`[aria-label="${t.statusDone}"]`), "清掉未读即无点").toBeNull();
 });
});

describe("会话行的时间展示（2026-10-13 对齐 ZCode 的紧凑相对时间）", () => {
 it("行内 = 刚刚/N分/N小时/N天，完整绝对时间在悬停 title，不再用固定宽度截断", async () => {
  await open();
  const text = container.textContent ?? "";
  expect(text).toContain("5分");
  expect(text).toContain("3小时");
  expect(text).toContain("2天");
  const row = [...container.querySelectorAll<HTMLElement>("div.h-8")].find((el) => (el.textContent ?? "").includes("登录页重构"));
  const timeSpan = [...(row?.querySelectorAll("span") ?? [])].find((el) => el.textContent === "5分" && el.hasAttribute("title"));
  expect(timeSpan, "行内时间应渲染成相对时间").not.toBeUndefined();
  const title = timeSpan?.getAttribute("title") ?? "";
  expect(title, "悬停给完整绝对时间").toContain(String(new Date(NOW - 5 * MIN).getFullYear()));
  expect(title).toContain(":");
  expect(timeSpan?.className, "时间不再受「固定宽度 + truncate」约束").not.toContain("truncate");
 });
});

describe("会话标题的显示口径（去掉开头的标题卡前缀：图标 + 短码）", () => {
 it("行里只显示去掉前缀后的标题，aria-label 同一口径；原始标题数据不动", async () => {
  const icon = "\u{F084D}";
  mock.listSessions.mockResolvedValue({
   sessions: [session("s9", "p1", `${icon} HGT: 修复输入框高度过高`)],
   totalFiles: 1,
   scannedFiles: 1,
  });
  await open();
  const row = [...container.querySelectorAll<HTMLElement>("div.h-8")].find((el) =>
   (el.textContent ?? "").includes("修复输入框高度过高"),
  );
  expect(row, "会话行应按去掉前缀后的标题渲染").not.toBeUndefined();
  expect(row?.textContent ?? "", "行里不该再出现图标码位").not.toContain(icon);
  expect(row?.textContent ?? "", "行里不该再出现标题卡短码").not.toContain("HGT:");
  expect(row?.querySelector("button")?.getAttribute("aria-label")).toBe("会话 修复输入框高度过高");
 });

 it("实测的标题卡形态（图标 + 大写短码）整段剥掉", async () => {
  mock.listSessions.mockResolvedValue({
   sessions: [session("s10", "p1", "\u{F0718} COMMIT: 提交推送后仍有修改标识")],
   totalFiles: 1,
   scannedFiles: 1,
  });
  await open();
  const text = container.textContent ?? "";
  expect(text).toContain("提交推送后仍有修改标识");
  expect(text, "行里不该再出现短码").not.toContain("COMMIT:");
 });
});

/** 输入框赋值：绕过 React 的 value 影子状态（与 `WorkspaceGroupDialog.test.tsx` 同一套）。 */
async function fill(input: HTMLInputElement | null, value: string): Promise<void> {
 const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
 await act(async () => {
  setter?.call(input, value);
  input?.dispatchEvent(new Event("input", { bubbles: true }));
 });
}

async function click(el: HTMLElement | null | undefined): Promise<void> {
 await act(async () => {
  el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
 });
}

describe("聊天侧栏的工作区标题行", () => {
 it("标题行给出「新建工作区」与「添加项目」两枚键", async () => {
  const t = TEXT["zh-CN"];
  await open();
  expect(container.textContent).toContain(t.workspaceTitle);
  expect(container.querySelector(`button[aria-label="${t.wsGroupNew}"]`), "新建工作区").not.toBeNull();
  expect(container.querySelector(`button[aria-label="${t.sidebarAddProjectAria}"]`), "添加项目").not.toBeNull();
 });

 it("点「新建工作区」打开同一个对话框；建完左栏立刻出现新段与其成员", async () => {
  const t = TEXT["zh-CN"];
  await open();
  expect(container.textContent).not.toContain("数据组");

  // 建完工作区后端的两个变化：项目归属改了、工作区清单多一组
  mock.createWorkspace.mockResolvedValue({ id: "w2", name: "数据组", createdAt: 0, projectIds: ["p2"] });
  mock.listProjects.mockResolvedValue([P1, { ...P2, workspaceId: "w2" }]);
  mock.listWorkspaces.mockResolvedValue([
   { id: "w1", name: "全栈", createdAt: 0, projectIds: ["p1"] },
   { id: "w2", name: "数据组", createdAt: 0, projectIds: ["p2"] },
  ]);

  await click(container.querySelector<HTMLButtonElement>(`button[aria-label="${t.wsGroupNew}"]`));
  const nameInput = container.querySelector<HTMLInputElement>(`input[placeholder="${t.wsGroupNamePlaceholder}"]`);
  expect(nameInput, "点标题行的 Layers 应打开工作区对话框").not.toBeNull();
  await fill(nameInput, "数据组");
  const beta = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((b) =>
   (b.closest("label")?.textContent ?? "").includes("beta"),
  );
  await click(beta);
  expect(beta?.checked, "勾选成员项目").toBe(true);
  await click([...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === t.wsGroupCreate));

  expect(mock.createWorkspace).toHaveBeenCalledWith("数据组", ["p2"]);
  // 项目行必须重拉：归属没刷新的话新组在聊天左栏是「没有成员的空组」，按口径不占段
  expect(mock.listProjects, "建完要重拉项目行").toHaveBeenCalled();
  const created = [...container.querySelectorAll("details.group\\/ws")].find((s) => (s.textContent ?? "").includes("数据组"));
  expect(created, "新工作区应作为分段出现在左栏").not.toBeUndefined();
  expect(created?.textContent).toContain("beta");
  // 对话框建完即关
  expect(container.querySelector(`input[placeholder="${t.wsGroupNamePlaceholder}"]`)).toBeNull();
 });
});

describe("左栏行级悬浮图标（V43）", () => {
 const t = TEXT["zh-CN"];

 it("会话行：归档键 → 归档该会话；删除键 → 二次确认 → delete_sessions", async () => {
  await open();
  const row = [...container.querySelectorAll<HTMLElement>("div.h-8")].find((el) => (el.textContent ?? "").includes("登录页重构"));
  expect(row, "会话行应渲染").not.toBeUndefined();
  await click(row?.querySelector<HTMLButtonElement>(`button[aria-label="${t.archiveChat}"]`));
  expect(mock.archiveSessions).toHaveBeenCalledWith(["s1"]);

  await click(row?.querySelector<HTMLButtonElement>(`button[aria-label="${t.deleteChat}"]`));
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.getAttribute("aria-label")).toBe("登录页重构");
  expect(dialog?.textContent).toContain(t.sessDeleteConfirm);
  const confirm = [...(dialog?.querySelectorAll("button") ?? [])].at(-1)!;
  await act(async () => {
   confirm.click();
  });
  expect(mock.deleteSessions).toHaveBeenCalledWith(["s1"]);
 });

 it("「未归属会话」组头：归档全部 / 删除全部两键；删除走二次确认", async () => {
  await open();
  const head = summaryFor(t.orphanChats);
  await click(head.querySelector<HTMLButtonElement>(`button[aria-label="${t.archiveOrphanAll}"]`));
  expect(mock.archiveSessions).toHaveBeenCalledWith(["s3"]);

  await click(head.querySelector<HTMLButtonElement>(`button[aria-label="${t.deleteOrphanAll}"]`));
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.getAttribute("aria-label")).toBe(t.sessDeleteAllConfirm.replace("{0}", "1"));
  const confirm = [...(dialog?.querySelectorAll("button") ?? [])].at(-1)!;
  await act(async () => {
   confirm.click();
  });
  expect(mock.deleteSessions).toHaveBeenCalledWith(["s3"]);
 });

 it("工作区段头：删除键走二次确认并调 delete_workspace", async () => {
  await open();
  const head = summaryFor("全栈");
  await click(head.querySelector<HTMLButtonElement>(`button[aria-label="${t.wsGroupDelete}"]`));
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.getAttribute("aria-label")).toBe(t.wsGroupDeleteTitle.replace("{0}", "全栈"));
  const confirm = [...(dialog?.querySelectorAll("button") ?? [])].at(-1)!;
  await act(async () => {
   confirm.click();
  });
  expect(mock.deleteWorkspace).toHaveBeenCalledWith("w1");
 });

 it("段头编辑键打开对话框并回填名字", async () => {
  await open();
  const head = summaryFor("全栈");
  await click(head.querySelector<HTMLButtonElement>(`button[aria-label="${fmt(t.wsGroupEditTitle, "全栈")}"]`));
  const input = container.querySelector<HTMLInputElement>(`input[placeholder="${t.wsGroupNamePlaceholder}"]`);
  expect(input?.value).toBe("全栈");
 });

 it("「未分组」段头不渲染编辑 / 删除键", async () => {
  act(() => {
   useApp.setState({ projects: [P1, P3] });
  });
  await open();
  const head = summaryFor(t.wsGroupUngrouped);
  expect(head.querySelector(`button[aria-label="${t.wsGroupDelete}"]`)).toBeNull();
  expect(head.querySelector(`button[aria-label="${fmt(t.wsGroupEditTitle, "未分组")}"]`)).toBeNull();
 });
});

/**
 * 删除 / 归档后的行状态（2026-10-15 用户实测）：
 * 左栏把 `store.sessions` 当真相覆盖并会把「扫描结果里没有的行」补回来（见 `mergedSessions`），
 * 所以删过的行如果还留在 store 缓存里，下一次刷新就会整行复活——用户看到的是
 * 「点删除以后未归属会话里又冒出一个会话」（删除后行没消失、还被顶到组首）。
 */
describe("会话删除 / 归档后的行状态（不许从 store 缓存复活）", () => {
 const t = TEXT["zh-CN"];

 /** 行内删除键 → 二次确认 → 确认真删。 */
 async function deleteRowVia(title: string): Promise<void> {
  const row = [...container.querySelectorAll<HTMLElement>("div.h-8")].find((el) => (el.textContent ?? "").includes(title));
  expect(row, `会话行应渲染：${title}`).not.toBeUndefined();
  await click(row?.querySelector<HTMLButtonElement>(`button[aria-label="${t.deleteChat}"]`));
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog, "删除要走二次确认").not.toBeNull();
  await act(async () => {
   ([...(dialog?.querySelectorAll("button") ?? [])].at(-1) as HTMLButtonElement).click();
  });
 }

 it("删掉的会话不从 store 缓存补回；删的是当前会话时激活一并清掉", async () => {
  // store 里留着这一行（点开过 / 从列表打开过）——渲染时它同时出现在扫描行与 store 行里
  useApp.setState({ sessions: [session("s3", null, "游离会话")], activeSessionId: "s3" });
  await open();
  expect(container.textContent).toContain("游离会话");
  // 后端真相：s3 已删 → 删除后那一次 list_sessions 不再返回它
  mock.listSessions.mockResolvedValue({ sessions: SESSIONS.filter((s) => s.id !== "s3"), totalFiles: 3, scannedFiles: 3 });

  await deleteRowVia("游离会话");

  expect(mock.deleteSessions).toHaveBeenCalledWith(["s3"]);
  expect(useApp.getState().sessions.some((s) => s.id === "s3"), "缓存里也不留删掉的行").toBe(false);
  expect(container.textContent, "删掉的行不许从 store 缓存补回来").not.toContain("游离会话");
  expect(useApp.getState().activeSessionId, "删的是当前会话：激活要清掉，别停在死会话上").toBeNull();
 });

 it("删的是别的会话时，当前会话的激活不受影响", async () => {
  useApp.setState({ sessions: [session("s1", "p1", "登录页重构")], activeSessionId: "s1" });
  await open();
  mock.listSessions.mockResolvedValue({ sessions: SESSIONS.filter((s) => s.id !== "s3"), totalFiles: 3, scannedFiles: 3 });

  await deleteRowVia("游离会话");

  expect(useApp.getState().activeSessionId).toBe("s1");
 });

 it("归档过的会话不再留在「进行中」（store 缓存的旧 archived 不许把它顶回来）", async () => {
  useApp.setState({ sessions: [session("s3", null, "游离会话")] });
  await open();
  const row = [...container.querySelectorAll<HTMLElement>("div.h-8")].find((el) => (el.textContent ?? "").includes("游离会话"));
  // 归档后端真相：覆盖层标记 + 下一次扫描回传 archived=true
  mock.listSessions.mockResolvedValue({
   sessions: SESSIONS.map((s) => (s.id === "s3" ? { ...s, archived: true } : s)),
   totalFiles: 4,
   scannedFiles: 4,
  });

  await click(row?.querySelector<HTMLButtonElement>(`button[aria-label="${t.archiveChat}"]`));

  expect(mock.archiveSessions).toHaveBeenCalledWith(["s3"]);
  expect(container.textContent, "已归档的会话不列").not.toContain("游离会话");
 });
});

/** 指针事件：jsdom 里用 MouseEvent 补 `pointerId`（控制器只读 clientX/clientY/pointerId）。 */
function pointer(type: string, x: number, y: number, pointerId = 1): Event {
 const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
 Object.defineProperty(e, "pointerId", { value: pointerId });
 return e;
}

/** 给元素钉一份矩形（jsdom 没有布局：拖拽落点判定全靠 `getBoundingClientRect`）。 */
function stubRect(el: Element, top: number, height: number): void {
 (el as HTMLElement).getBoundingClientRect = () => ({
  top, bottom: top + height, left: 0, right: 300, x: 0, y: top, width: 300, height,
  toJSON: () => ({}),
 }) as DOMRect;
}

describe("项目拖拽排序（V26 控制器，v1 自终端左栏迁移）", () => {
 it("拖拽的 DOM 钩子齐备：项目块 = data-proj-row + data-project-drag；段容器 = data-group-drop", async () => {
  await open();
  const row = container.querySelector('[data-proj-row="p1"]');
  expect(row, "项目块要带 data-proj-row（落点判定的行条目）").not.toBeNull();
  expect(row?.querySelector("[data-project-drag]"), "项目名区要带 data-project-drag（拖拽手柄）").not.toBeNull();
  expect(container.querySelector('[data-group-drop="w1"]'), "工作区段 = 容器落点").not.toBeNull();
 });

 it("平铺模式：整段是「未分组」容器；拖到另一行之前 → move_project（顺序 + 归属一次写）", async () => {
  act(() => {
   useApp.setState({ workspaceGroups: [], projects: [{ ...P1, workspaceId: null }, { ...P2, workspaceId: null }] });
  });
  mock.listWorkspaces.mockResolvedValue([]);
  mock.moveProject.mockResolvedValue([{ ...P2, workspaceId: null }, { ...P1, workspaceId: null }]);
  await open();

  const scroll = container.querySelector("aside div.overflow-y-auto");
  const drop = container.querySelector('[data-group-drop=""]');
  const p1 = container.querySelector('[data-proj-row="p1"]');
  const p2 = container.querySelector('[data-proj-row="p2"]');
  expect(scroll && drop && p1 && p2, "滚动容器、平铺容器与两个项目块都要在").toBeTruthy();
  stubRect(scroll!, 100, 300);
  stubRect(drop!, 100, 300);
  stubRect(p1!, 120, 36);
  stubRect(p2!, 160, 36);

  const handle = p2!.querySelector("[data-project-drag]")!;
  await act(async () => {
   handle.dispatchEvent(pointer("pointerdown", 50, 178));
  });
  // 移动超过 4px 才进入拖拽态：幽灵卡出现在 body 的 portal 里
  await act(async () => {
   window.dispatchEvent(pointer("pointermove", 50, 140));
  });
  expect(document.querySelector("[data-drag-ghost]"), "拖拽中要有跟手幽灵卡").not.toBeNull();

  // 落在 p1 上半段（中线之上）= 插到 p1 之前
  await act(async () => {
   window.dispatchEvent(pointer("pointerup", 50, 126));
  });
  expect(document.querySelector("[data-drag-ghost]"), "松手后幽灵卡要收掉").toBeNull();
  expect(mock.moveProject).toHaveBeenCalledWith("p2", null, ["p2", "p1"]);
 });

 it("原地松开（顺序与归属都没变）不发请求", async () => {
  act(() => {
   useApp.setState({ workspaceGroups: [], projects: [{ ...P1, workspaceId: null }, { ...P2, workspaceId: null }] });
  });
  mock.listWorkspaces.mockResolvedValue([]);
  await open();
  const scroll = container.querySelector("aside div.overflow-y-auto");
  const drop = container.querySelector('[data-group-drop=""]');
  const p1 = container.querySelector('[data-proj-row="p1"]');
  const p2 = container.querySelector('[data-proj-row="p2"]');
  stubRect(scroll!, 100, 300);
  stubRect(drop!, 100, 300);
  stubRect(p1!, 120, 36);
  stubRect(p2!, 160, 36);

  const handle = p2!.querySelector("[data-project-drag]")!;
  await act(async () => {
   handle.dispatchEvent(pointer("pointerdown", 50, 178));
   window.dispatchEvent(pointer("pointermove", 50, 150));
   window.dispatchEvent(pointer("pointerup", 50, 178));
  });
  expect(mock.moveProject).not.toHaveBeenCalled();
 });
});
