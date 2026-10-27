import { useEffect, useRef, type KeyboardEvent } from "react";
import { AlertTriangle, Check, CheckCircle, Loader, X } from "reicon-react";
import type { ChangeFile, CommitMode, CommitPhase } from "@shared/types";
import { useApp } from "../../stores/app";
import {
	cancelCommitTask,
	closeCommitPanel,
	commitAndMaybePush,
	fullCommit,
	generateMessage,
	isCommitTaskRunning,
	pushWorkspace,
	selectAllCommitFiles,
	setCommitFileSelected,
	setCommitMessage,
	setCommitMode,
} from "../../lib/commitTasks";
import { COMMIT_LANGS, type CommitLang } from "../../lib/commitLang";
import { checkoutLabel } from "../../lib/checkouts";
import { useDialogFocus } from "../../lib/useDropdown";
import { useText } from "../../lib/useText";
import { LOCALE_NAMES, type TextKey } from "../../lib/locale";
import { Switch } from "../settings/Switch";

/**
 * 提交 / 推送浮层（V19）。
 *
 * - 单例：显示 `activeCommitCwd` 指向的任务；Esc / 点遮罩 / 「后台运行」都是**关闭浮层**
 *   （运行中 = 转后台，任务与行徽章继续；终态 = 清除记录）。
 * - **快速轨**（默认）：勾选文件 → 「生成提交信息」（一次 `omp -p` 单轮，秒级）→ 编辑框里
 *   过目 / 手改 → 「提交」或「提交并推送」；
 * - **完整轨**（可选）：走 `omp commit`（AI 信息 + changelog 维护 + 校验器），日志流式；
 * - 勾选 = 本次提交包含哪些文件；生成与提交都会把勾选同步到 git 暂存区（后端复查子集）；
 * - **提交信息语言**（`system` / 中文 / English）按**项目**记忆：控件改的是本项目的偏好，
 *   下次任务发起时由 `lib/commitTasks.ts` 解析成给模型的要求；运行中锁住。
 */

/** 阶段文案（中英字典键）。 */
const PHASE_KEY: Record<CommitPhase, TextKey> = {
	idle: "gitPhaseIdle",
	checking: "gitPhaseChecking",
	generating: "gitPhaseGenerating",
	generated: "gitPhaseGenerated",
	committing: "gitPhaseCommitting",
	pushing: "gitPhasePushing",
	committed: "gitPhaseCommitted",
	pushed: "gitPhasePushed",
	noop: "gitPhaseNoop",
	failed: "gitPhaseFailed",
	canceled: "gitPhaseCanceled",
};

/** 阶段色调（token，见 index.css）。 */
const PHASE_TONE: Record<CommitPhase, string> = {
	idle: "text-muted",
	checking: "text-muted",
	generating: "text-accent",
	generated: "text-muted",
	committing: "text-accent",
	pushing: "text-accent",
	committed: "text-ok",
	pushed: "text-ok",
	noop: "text-muted",
	failed: "text-danger",
	canceled: "text-faint",
};

/** 文件状态 chip：未跟踪 `??`，已跟踪取 porcelain 的 XY（两位相同只显示一位）。 */
function statusChip(file: ChangeFile): string {
	if (file.untracked) return "??";
	const xy = `${file.index}${file.worktree}`.trim();
	return xy.length === 2 && xy[0] === xy[1] ? xy[0] : xy || "M";
}

export function CommitTaskPanel() {
	const activeCwd = useApp((s) => s.activeCommitCwd);
	if (!activeCwd) return null;
	// key：切换到另一个工作区的任务时重建（滚动位置与焦点都回到新任务）
	return <CommitTaskCard key={activeCwd} cwd={activeCwd} />;
}

function CommitTaskCard({ cwd }: { cwd: string }) {
	const t = useText();
	const task = useApp((s) => s.commitTasks[cwd]);
	const workspace = useApp((s) => s.checkouts.find((w) => w.path === cwd));
	const ahead = useApp((s) => s.workspaceGitStates[cwd]?.ahead ?? 0);
	// 提交信息语言按**项目**记忆（项目的主目录与全部 worktree 共用一份）
	const projectId = useApp((s) => s.checkouts.find((w) => w.path === cwd)?.projectId ?? null);
	const langPref = useApp((s) => (projectId ? s.commitLangPrefs[projectId] : undefined));
	const setCommitLangPref = useApp((s) => s.setCommitLangPref);
	const cardRef = useRef<HTMLDivElement>(null);
	// 弹窗体（唯一滚动区）：日志到达新行时自动滚底
	const bodyRef = useRef<HTMLDivElement>(null);
	useDialogFocus(cardRef, true, closeCommitPanel);

	// 日志自动滚底（新行到达时）
	useEffect(() => {
		const el = bodyRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [task?.log.length]);

	if (!task) return null;
	const running = isCommitTaskRunning(task.phase);
	const files = task.files;
	const hasFiles = files.length > 0;
	const allSelected = hasFiles && task.selected.length === files.length;
	const canCommit = hasFiles && task.selected.length > 0 && task.message.trim().length > 0;
	const mode = task.mode;

	// ---------- 提交信息语言（按项目） ----------
	const lang = langPref?.lang ?? "system";
	const remembered = langPref?.remembered ?? false;
	// 运行中锁住（本次任务的参数已定，改了也只影响下次）；工作区没落在任何项目上时无处可存
	const langLocked = running || !projectId;
	const langLabels: Record<CommitLang, string> = {
		system: t.gitMsgLangSystem,
		zh: LOCALE_NAMES["zh-CN"],
		en: LOCALE_NAMES.en,
	};
	const pickLang = (next: CommitLang) => {
		if (langLocked || !projectId) return;
		setCommitLangPref(projectId, { lang: next, remembered });
	};
	const toggleRemember = () => {
		if (langLocked || !projectId) return;
		setCommitLangPref(projectId, { lang, remembered: !remembered });
	};
	// 单选组的方向键：左/右在当前组内循环切换（与左栏的三档分段控件同款）
	const onLangKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
		if (!dir || langLocked) return;
		const at = COMMIT_LANGS.indexOf(lang);
		pickLang(COMMIT_LANGS[(at + dir + COMMIT_LANGS.length) % COMMIT_LANGS.length]);
	};

	const MODE_OPTIONS: readonly CommitMode[] = ["fast", "full"];
	const pickMode = (next: CommitMode) => {
		if (running || next === mode) return;
		setCommitMode(cwd, next);
	};
	// 分段控件的方向键口径与左栏两个控件一致：左/右在组内循环
	const onModeKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
		if (!dir || running) return;
		const at = MODE_OPTIONS.indexOf(mode);
		pickMode(MODE_OPTIONS[(at + dir + MODE_OPTIONS.length) % MODE_OPTIONS.length]);
	};
	const accentBtn =
		"cursor-pointer rounded-md border border-transparent bg-primary px-3.5 py-1.5 text-[13px] font-medium text-primary-foreground transition-colors duration-100 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40";
	const plainBtn =
		"cursor-pointer rounded-md border border-border px-3.5 py-1.5 text-[13px] transition-colors duration-100 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40";

	return (
		<div
			className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
			onClick={closeCommitPanel}
		>
			<div
				ref={cardRef}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-label={t.gitPanelTitle}
				className="flex max-h-[85dvh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-elevated shadow-dialog"
				onClick={(e) => e.stopPropagation()}
			>
				{/* 弹窗头：标题 + 阶段徽章（固定不滚动） */}
				<div className="flex shrink-0 items-start gap-3 border-b border-border-soft p-5 pb-4">
					<div className="min-w-0 flex-1">
						<div className="text-[15px] font-semibold tracking-tight">{t.gitPanelTitle}</div>
						<div className="mt-1 min-w-0 truncate font-mono text-[12px] text-muted">
							{workspace ? checkoutLabel(workspace) : cwd}
						</div>
					</div>
					<PhaseBadge phase={task.phase} />
				</div>

				{/* 轨道选择：快速（默认）/ 完整（omp commit，含 CHANGELOG） */}
				<div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-soft px-5 py-2.5">
					<span className="text-[12px] text-muted">{t.gitPanelModeLabel}</span>
					<div
						role="radiogroup"
						aria-label={t.gitPanelModeLabel}
						onKeyDown={onModeKeyDown}
						className="flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-surface/60 p-0.5"
					>
						{MODE_OPTIONS.map((value) => {
							const selected = value === mode;
							return (
								<button
									key={value}
									type="button"
									role="radio"
									aria-checked={selected}
									disabled={running}
									onClick={() => pickMode(value)}
									className={`h-6 cursor-pointer rounded-sm px-2 text-[12px] transition-colors duration-100 ${selected ? "bg-active text-accent" : "text-muted hover:bg-hover hover:text-foreground"
										} disabled:cursor-not-allowed disabled:opacity-40`}
								>
									{value === "fast" ? t.gitPanelModeFast : t.gitPanelModeFull}
								</button>
							);
						})}
					</div>
				</div>

				{/* 弹窗体：唯一纵向滚动区（头尾固定） */}
				<div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto">
					{mode === "full" && (
						<div className="border-b border-border-soft px-5 py-2 text-[11px] leading-4 text-faint">
							{t.gitFullCommitHint}
							{task.selected.length === 0 && hasFiles ? ` · ${t.gitFullCommitNoSelection}` : ""}
						</div>
					)}

					{/* 快速轨：文件勾选 */}
					{mode === "fast" && (
						<div className="border-b border-border-soft px-5 py-3">
							<div className="mb-1.5 flex items-center justify-between gap-3">
								<span className="text-[11px] font-medium tracking-wide text-faint">{t.gitPanelFiles}</span>
								{hasFiles && (
									<button
										type="button"
										disabled={running}
										onClick={() => selectAllCommitFiles(cwd, !allSelected)}
										className="cursor-pointer rounded-sm px-1.5 py-0.5 text-[11px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
									>
										{allSelected ? t.gitPanelSelectNone : t.gitPanelSelectAll}
									</button>
								)}
							</div>
							{hasFiles ? (
								<ul className="max-h-44 space-y-0.5 overflow-y-auto">
									{files.map((file) => {
										const on = task.selected.includes(file.path);
										const label = file.origPath ? `${file.origPath} → ${file.path}` : file.path;
										return (
											<li key={file.path}>
												<div className="flex min-h-7 items-center gap-2 rounded-sm px-1 text-[12px] hover:bg-hover">
													<button
														type="button"
														role="checkbox"
														aria-checked={on}
														aria-label={label}
														disabled={running}
														onClick={() => setCommitFileSelected(cwd, file.path, !on)}
														className={`flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm border transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-40 ${on ? "border-accent bg-primary text-primary-foreground" : "border-border bg-surface"
															}`}
													>
														{on && <Check size={9} aria-hidden />}
													</button>
													<span className="w-4 shrink-0 text-center font-mono text-[10px] text-faint">
														{statusChip(file)}
													</span>
													<span className="min-w-0 flex-1 truncate font-mono" title={label}>
														{file.path}
													</span>
													{!file.untracked && (file.add > 0 || file.del > 0) && (
														<span className="shrink-0 font-mono text-[10px] leading-none">
															<span className="text-ok">+{file.add}</span>{" "}
															<span className="text-danger">−{file.del}</span>
														</span>
													)}
												</div>
											</li>
										);
									})}
								</ul>
							) : (
								<p className="px-1 py-1 text-[12px] text-faint">
									{ahead > 0 ? t.gitPanelAheadOnly.replace("{0}", String(ahead)) : t.gitPanelNoFiles}
								</p>
							)}
						</div>
					)}

					{/* 快速轨：可编辑的提交信息 */}
					{mode === "fast" && (
						<div className="border-b border-border-soft px-5 py-3">
							<textarea
								value={task.message}
								onChange={(e) => setCommitMessage(cwd, e.target.value)}
								readOnly={running}
								rows={4}
								placeholder={t.gitMsgPlaceholder}
								aria-label={t.gitMsgPlaceholder}
								className="w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 font-mono text-[12px] leading-5 break-words outline-none focus:border-accent read-only:opacity-70"
							/>
							<p className="mt-1.5 text-[11px] leading-4 text-faint">{t.gitPanelNote}</p>
						</div>
					)}

					{/* 完整轨：`omp commit` 的流式日志 */}
					{mode === "full" && (
						<div className="min-h-[120px] bg-surface/40 px-5 py-4 font-mono text-[12px] leading-5 break-words whitespace-pre-wrap text-muted">
							{task.log.map((line, i) => (
								// 日志是追加流，index 即身份（内容可能重复，不能用内容当 key）
								<div key={i}>{line}</div>
							))}
							{task.log.length === 0 && <div className="text-faint">…</div>}
						</div>
					)}

					{task.commits.length > 0 && (
						<div className="border-t border-border-soft px-5 py-3">
							<div className="mb-1.5 text-[11px] font-medium tracking-wide text-faint">{t.gitResultCommits}</div>
							<ul className="space-y-1">
								{task.commits.map((c) => (
									<li key={c.sha} className="flex items-baseline gap-2 text-[12px]">
										<span className="shrink-0 font-mono text-faint">{c.sha}</span>
										<span className="min-w-0 flex-1 break-words">{c.subject}</span>
									</li>
								))}
							</ul>
						</div>
					)}

					{task.error && (
						<div className="border-t border-border-soft px-5 py-3">
							<pre className="max-h-32 overflow-y-auto font-mono text-[11.5px] leading-5 break-words whitespace-pre-wrap text-muted">
								{task.error}
							</pre>
							{task.hint && <p className="mt-2 text-[12px] leading-5 text-warn">{task.hint}</p>}
						</div>
					)}

					<div className="border-t border-border-soft px-5 py-3">
						<div className="flex items-center justify-between gap-3">
							<span className="text-[12px] text-muted">{t.gitMsgLangLabel}</span>
							<div
								role="radiogroup"
								aria-label={t.gitMsgLangLabel}
								onKeyDown={onLangKeyDown}
								className="flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-surface/60 p-0.5"
							>
								{COMMIT_LANGS.map((value) => {
									const selected = value === lang;
									return (
										<button
											key={value}
											type="button"
											role="radio"
											aria-checked={selected}
											disabled={langLocked}
											onClick={() => pickLang(value)}
											className={`h-6 cursor-pointer rounded-sm px-2 text-[12px] transition-colors duration-100 ${selected ? "bg-active text-accent" : "text-muted hover:bg-hover hover:text-foreground"
												} disabled:cursor-not-allowed disabled:opacity-40`}
										>
											{langLabels[value]}
										</button>
									);
								})}
							</div>
						</div>
						<div className="mt-2.5 flex items-center justify-between gap-3">
							<span className="text-[12px] text-muted" title={t.gitMsgLangRememberTitle}>
								{t.gitMsgLangRemember}
							</span>
							<Switch on={remembered} disabled={langLocked} label={t.gitMsgLangRemember} onToggle={toggleRemember} />
						</div>
						{lang === "zh" && <p className="mt-2 text-[11px] leading-4 text-faint">{t.gitMsgLangZhNote}</p>}
						{running && <p className="mt-2 text-[11px] leading-4 text-faint">{t.gitMsgLangLocked}</p>}
					</div>
				</div>

				{/* 弹窗尾：按钮行（固定不滚动） */}
				<div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border-soft p-4 pt-3">
					{running ? (
						<>
							<button type="button" onClick={() => cancelCommitTask(cwd)} className={plainBtn}>
								{t.gitPanelCancel}
							</button>
							<button type="button" onClick={closeCommitPanel} className={accentBtn}>
								{t.gitPanelBackground}
							</button>
						</>
					) : mode === "fast" ? (
						<>
							<button
								type="button"
								disabled={!hasFiles || task.selected.length === 0}
								title={task.selected.length === 0 && hasFiles ? t.gitMsgEmpty : undefined}
								onClick={() => generateMessage(cwd)}
								className={task.generated ? plainBtn : accentBtn}
							>
								{task.generated ? t.gitRegenerate : t.gitGenerate}
							</button>
							<button
								type="button"
								disabled={!canCommit}
								title={canCommit ? undefined : t.gitMsgEmpty}
								onClick={() => commitAndMaybePush(cwd, false)}
								className={task.generated && canCommit ? accentBtn : plainBtn}
							>
								{t.gitCommit}
							</button>
							<button
								type="button"
								disabled={!canCommit}
								title={canCommit ? undefined : t.gitMsgEmpty}
								onClick={() => commitAndMaybePush(cwd, true)}
								className={plainBtn}
							>
								{t.gitCommitPush}
							</button>
							{!hasFiles && ahead > 0 && (
								<button type="button" onClick={() => pushWorkspace(cwd)} className={accentBtn}>
									{t.gitPush}
								</button>
							)}
							<button type="button" onClick={closeCommitPanel} className={plainBtn}>
								{t.gitPanelClose}
							</button>
						</>
					) : (
						<>
							<button
								type="button"
								disabled={!hasFiles || running}
								onClick={() => fullCommit(cwd)}
								className={accentBtn}
							>
								{t.gitFullCommit}
							</button>
							{task.commits.length > 0 && (
								<button type="button" onClick={() => pushWorkspace(cwd)} className={plainBtn}>
									{t.gitPush}
								</button>
							)}
							<button type="button" onClick={closeCommitPanel} className={plainBtn}>
								{t.gitPanelClose}
							</button>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

/** 阶段徽章：图标 + 文案（颜色不是唯一信号——文案在旁）。 */
function PhaseBadge({ phase }: { phase: CommitPhase }) {
	const t = useText();
	const running = isCommitTaskRunning(phase);
	const Icon = phase === "failed" ? AlertTriangle : phase === "canceled" ? X : running ? Loader : CheckCircle;
	return (
		<span className={`flex shrink-0 items-center gap-1.5 text-[12px] font-medium ${PHASE_TONE[phase]}`}>
			<Icon size={13} aria-hidden className={running ? "animate-spin" : ""} />
			{t[PHASE_KEY[phase]]}
		</span>
	);
}
