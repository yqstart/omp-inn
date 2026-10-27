// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeFile, CheckoutView, CommitTaskView } from "@shared/types";
import { useApp } from "../../stores/app";
import { CommitTaskPanel } from "./CommitTaskPanel";

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@shared/api", () => ({
	api: {
		getChangeSet: vi.fn(async () => ({
			isRepo: true,
			branch: "main",
			head: null,
			upstream: null,
			upstreamGone: false,
			ahead: 0,
			behind: 0,
			files: [],
		})),
		generateCommitMessage: vi.fn(async () => undefined),
		commitSelected: vi.fn(async () => undefined),
		startFullCommit: vi.fn(async () => undefined),
		pushWorkspace: vi.fn(async () => undefined),
		cancelCommitTask: vi.fn(async () => undefined),
		getWorkspaceGitState: vi.fn(async () => []),
	},
}));

// `new Channel()` 会调 `window.__TAURI_INTERNALS__.transformCallback`（Tauri v2 在构造时就注册回调），
// jsdom 里没有这层，给一个最小桩：只要不抛错、返回一个数字 id 即可（测试不驱动回包）。
const internals = globalThis as { __TAURI_INTERNALS__?: unknown };

import { api } from "@shared/api";

/** 提交信息语言的作用域是**项目**：一个项目下挂主目录与 worktree 两个目录行。 */
const MAIN: CheckoutView = {
	projectId: "p1",
	projectName: "repo",
	path: "/repo",
	branch: "main",
	head: null,
	isMain: true,
	missing: false,
};
const WORKTREE: CheckoutView = { ...MAIN, path: "/repo/.wt/feat", branch: "feat", isMain: false };

function file(path: string, extra: Partial<ChangeFile> = {}): ChangeFile {
	return { path, origPath: null, index: " ", worktree: "M", untracked: false, add: 1, del: 0, ...extra };
}

/** 面板视图：三个文件（已改 / 已暂存 / 未跟踪），默认全选、没有生成过信息。 */
function task(cwd: string, extra: Partial<CommitTaskView> = {}): CommitTaskView {
	return {
		cwd,
		mode: "fast",
		phase: "idle",
		files: [file("src/a.ts"), file("src/b.ts", { index: "A" }), file("new.md", { index: "?", worktree: "?", untracked: true })],
		selected: ["src/a.ts", "src/b.ts", "new.md"],
		message: "",
		generated: false,
		log: [],
		commits: [],
		error: null,
		hint: null,
		startedAt: 0,
		...extra,
	};
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	localStorage.clear();
	internals.__TAURI_INTERNALS__ = {
		transformCallback: () => 0,
		invoke: async () => undefined,
	};
	container = document.createElement("div");
	document.body.appendChild(container);
	useApp.setState({
		locale: "zh-CN",
		checkouts: [MAIN, WORKTREE],
		commitLangPrefs: {},
		commitTasks: {},
		activeCommitCwd: null,
		workspaceGitStates: {},
	});
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

/** 打开某个工作区的任务浮层。 */
function show(cwd: string, extra: Partial<CommitTaskView> = {}): void {
	useApp.setState({ commitTasks: { [cwd]: task(cwd, extra) }, activeCommitCwd: cwd });
	root = createRoot(container);
	act(() => root.render(<CommitTaskPanel />));
}

const LANG_LABELS = ["系统默认", "简体中文", "English"];
const radios = () => [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
const langRadios = () => radios().filter((b) => LANG_LABELS.includes(b.textContent ?? ""));
const modeRadios = () => radios().filter((b) => !LANG_LABELS.includes(b.textContent ?? ""));
const checkboxes = () => [...container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
const remember = () => container.querySelector<HTMLButtonElement>('[role="switch"]')!;
const textarea = () => container.querySelector<HTMLTextAreaElement>("textarea")!;
const button = (text: string) =>
	[...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
const stored = () => JSON.parse(localStorage.getItem("omp.commitLang.v1") ?? "{}");

describe("提交信息语言控件（按项目记忆）", () => {
	it("三档默认选中「系统默认」，选中态由 aria-checked 表达", () => {
		show("/repo");
		expect(langRadios().map((b) => b.textContent)).toEqual(["系统默认", "简体中文", "English"]);
		expect(langRadios().map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
		expect(remember().getAttribute("aria-checked")).toBe("false");
	});

	it("选中文：先只进内存；勾「记住选择」后按项目写盘（并能跨工作区共享）", () => {
		show("/repo");
		act(() => langRadios()[1].click());
		expect(useApp.getState().commitLangPrefs.p1).toEqual({ lang: "zh", remembered: false });
		expect(stored()).toEqual({}); // 没记住 = 不落盘
		expect(container.textContent).toContain("摘要首词用英文过去式动词"); // 中文档的首词说明

		act(() => remember().click());
		expect(useApp.getState().commitLangPrefs.p1).toEqual({ lang: "zh", remembered: true });
		expect(stored()).toEqual({ p1: "zh" });

		// 同一项目的 worktree 打开浮层：同一份项目偏好（按项目，不按工作区）
		act(() => root.unmount());
		container.remove();
		container = document.createElement("div");
		document.body.appendChild(container);
		show("/repo/.wt/feat");
		expect(langRadios().map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
		expect(remember().getAttribute("aria-checked")).toBe("true");
	});

	it("取消「记住选择」：从盘里删键，本次运行仍用当前档", () => {
		show("/repo");
		act(() => langRadios()[2].click());
		act(() => remember().click());
		expect(stored()).toEqual({ p1: "en" });

		act(() => remember().click());
		expect(stored()).toEqual({});
		expect(useApp.getState().commitLangPrefs.p1).toEqual({ lang: "en", remembered: false });
		expect(langRadios()[2].getAttribute("aria-checked")).toBe("true");
	});

	it("运行中锁住：三档、记住开关与文件勾选都禁用，并说明下次提交生效", () => {
		show("/repo", { phase: "committing" });
		expect(langRadios().every((b) => b.disabled)).toBe(true);
		expect(remember().disabled).toBe(true);
		expect(checkboxes().every((b) => b.disabled)).toBe(true);
		expect(container.textContent).toContain("任务运行中不可修改");

		act(() => langRadios()[1].click()); // 禁用态点击不生效
		expect(useApp.getState().commitLangPrefs.p1).toBeUndefined();
	});
});

describe("文件勾选", () => {
	it("默认全选；点一行取消勾选只改选中集，不动作到文件快照", () => {
		show("/repo");
		expect(checkboxes().map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "true", "true"]);
		// 未跟踪文件的 chip 是 `??`
		expect(container.textContent).toContain("??");

		act(() => checkboxes()[1].click());
		const view = useApp.getState().commitTasks["/repo"];
		expect(view.selected).toEqual(["src/a.ts", "new.md"]);
		expect(view.files).toHaveLength(3);
		expect(checkboxes().map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "false", "true"]);
	});

	it("「全不选 / 全选」按钮作用于当前文件列表", () => {
		show("/repo");
		act(() => button("全不选")!.click());
		expect(useApp.getState().commitTasks["/repo"].selected).toEqual([]);
		act(() => button("全选")!.click());
		expect(useApp.getState().commitTasks["/repo"].selected).toEqual([
			"src/a.ts",
			"src/b.ts",
			"new.md",
		]);
	});
});

describe("快速轨", () => {
	it("生成：把勾选与语言要求交给后端，消息为空时不能提交", () => {
		show("/repo");
		expect(button("提交")!.disabled).toBe(true);
		expect(button("提交并推送")!.disabled).toBe(true);

		act(() => button("生成提交信息")!.click());
		expect(vi.mocked(api.generateCommitMessage)).toHaveBeenCalledWith(
			"/repo",
			["src/a.ts", "src/b.ts", "new.md"],
			null,
			expect.anything(),
		);
	});

	it("已生成：编辑框可改，提交与提交并推送把当前消息发出去", () => {
		show("/repo", { phase: "generated", message: "feat: Added 面板", generated: true });
		expect(textarea().readOnly).toBe(false);
		expect(button("重新生成")).toBeTruthy();
		expect(button("提交")!.disabled).toBe(false);

		act(() => {
			const el = textarea();
			const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
			setter?.call(el, "feat: Added 面板 v2");
			el.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(useApp.getState().commitTasks["/repo"].message).toBe("feat: Added 面板 v2");

		act(() => button("提交并推送")!.click());
		expect(vi.mocked(api.commitSelected)).toHaveBeenCalledWith(
			"/repo",
			["src/a.ts", "src/b.ts", "new.md"],
			"feat: Added 面板 v2",
			true,
			expect.anything(),
		);
	});

	it("没有改动但有未推送提交：给「推送」入口", () => {
		useApp.setState({
			workspaceGitStates: {
				"/repo": {
					path: "/repo",
					isRepo: true,
					dirty: false,
					ahead: 2,
					behind: 0,
					upstream: "origin/main",
					upstreamGone: false,
				},
			},
		});
		show("/repo", { files: [], selected: [] });
		expect(container.textContent).toContain("有 2 个提交待推送");
		act(() => button("推送")!.click());
		expect(vi.mocked(api.pushWorkspace)).toHaveBeenCalledWith("/repo", expect.anything());
	});
});

describe("完整轨", () => {
	it("切到完整模式：没有勾选区，点按钮跑 omp commit", () => {
		show("/repo");
		expect(modeRadios().map((b) => b.textContent)).toEqual(["快速", "完整（含 CHANGELOG）"]);

		act(() => modeRadios()[1].click());
		expect(useApp.getState().commitTasks["/repo"].mode).toBe("full");
		expect(checkboxes()).toHaveLength(0);
		expect(container.textContent).toContain("会维护 CHANGELOG.md");

		act(() => button("完整提交（含 CHANGELOG）")!.click());
		expect(vi.mocked(api.startFullCommit)).toHaveBeenCalledWith(
			"/repo",
			["src/a.ts", "src/b.ts", "new.md"],
			null,
			expect.anything(),
		);
	});
});
