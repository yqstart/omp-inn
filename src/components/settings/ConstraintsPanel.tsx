import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader, Plus, Refresh, Trash2 } from "reicon-react";
import { api } from "@shared/api";
import type { ConstraintFile, ConstraintsView } from "@shared/types";
import { useApp } from "../../stores/app";
import { fmt, type Text } from "../../lib/locale";
import type { SettingsFocusRequest } from "../../lib/settingsTabs";
import { useText } from "../../lib/useText";
import { useVisibleRefresh } from "../../lib/useVisibleRefresh";
import { isMacKeyboard } from "../../lib/platform";
import {
  constraintKey,
  newRuleName,
  parseRuleDoc,
  ruleDisplayName,
  ruleKindOf,
  splitFrontmatter,
  validateConstraintText,
  type ConstraintIssue,
  type RuleKind,
} from "../../lib/constraints";
import { ConfirmDialog } from "../ConfirmDialog";

/**
 * 设置 ›「omp 约束」：编辑 omp 的**全局**约束文件与规则文件。
 *
 * - `AGENTS.md`：用户级上下文约束（每次会话启动注入；普通 Markdown，不解析 frontmatter）；
 * - `RULES.md`：sticky 硬规则（始终 always-apply、每轮重挂）；
 * - `rules/*.{md,mdc}`：独立规则（文件名即规则名；`enabled: false` 停用）。
 *
 * **三种文件都是直接编辑整份 Markdown**（2026-10-19 用户口径：去掉「表单 / 源码」两档，
 * 表单那套逐字段编辑退场）——文本原样保存，frontmatter 由用户自己写；`lib/constraints.ts`
 * 的解析只用于列表摘要的类型标签与保存前的结构校验（读不懂的 frontmatter 等于坏规则）。
 *
 * 数据面：清单来自 `get_omp_constraints`（固定两份文件 + rules/ 下的文件，一次读全）；
 * 保存 / 新建 / 删除走后端（乐观锁 + 备份 + 原子写）。草稿在**模块级缓存**里跨设置页签 /
 * 设置视图保留（切到模型页看一眼再回来不会丢未保存内容），「重新加载」才丢弃。
 *
 * 视图口径（2026-10-19 用户口径）：**选中文件默认展示预览**——这里主要是看约束内容，
 * 打开就落到可编辑的裸文本既不好读、也容易误改；点「编辑」才换成整份 Markdown 编辑框。
 * 唯一的例外是**新建规则**：刚建出来的文件是空的，用户下一步就是写内容，直接进编辑态。
 */

type EditorState = {
  /** 整份 Markdown（含 frontmatter）：保存时原样写回。 */
  source: string;
  dirty: boolean;
};

/**
 * 未保存草稿的模块级缓存：面板切设置页签 / 关掉设置视图都会卸载，草稿不能跟着丢。
 * 只在内存里（应用重启即清）；文件被外部改过时保存会撞乐观锁，不会静默覆盖。
 */
const draftCache = new Map<string, EditorState>();

/** 标题行上的类型徽标（总是生效 / 实时注入 / 规则手册）。 */
const KIND_BADGE = "rounded border border-border px-1.5 py-0.5 text-[10px] text-muted";

function stateFromFile(file: ConstraintFile): EditorState {
  return { source: file.content, dirty: false };
}

function kindLabel(kind: RuleKind, t: Text): string {
  if (kind === "always") return t.constraintsKindAlways;
  if (kind === "ttsr") return t.constraintsKindTtsr;
  return t.constraintsKindRulebook;
}

function issueText(issue: ConstraintIssue, t: Text): string {
  if (issue.kind === "tooLarge") return fmt(t.constraintsTooLarge, String(issue.bytes));
  if (issue.kind === "nul") return t.constraintsNul;
  return fmt(t.constraintsParseError, issue.detail);
}

/**
 * 行尾的类型标签：只有独立规则需要，而且**「规则手册」是默认类型、不重复上标签**——
 * 每行都挂一个同样的「规则手册」只是噪音；只有「总是生效 / 实时注入」这种需要一眼认出的
 * 类型才标出来。规则的 description 放在编辑器标题区（选中后可见），列表行不塞说明。
 */
function fileBadge(file: ConstraintFile, t: Text): string | null {
  if (file.kind !== "rule" || file.error) return null;
  const parsed = parseRuleDoc(file.content);
  if (!parsed.ok) return null;
  const kind = ruleKindOf(parsed.doc.fields);
  return kind === "rulebook" ? null : kindLabel(kind, t);
}

/** 编辑框里指的是同一份文件：预览只铺正文（frontmatter 不进正文渲染）。 */
function previewText(source: string): string {
  const split = splitFrontmatter(source);
  return split.frontmatter === null ? source : split.body;
}

/** 预览里的链接不跳转：设置页不是浏览器，跳走会丢掉整个视图。 */
const PREVIEW_COMPONENTS: Components = {
  a: ({ children }) => <span className="text-accent">{children}</span>,
};

function MarkdownPreview({ text, empty }: { text: string; empty: string }) {
  if (!text.trim()) return <p className="text-[13px] text-muted">{empty}</p>;
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={PREVIEW_COMPONENTS}>
      {text}
    </ReactMarkdown>
  );
}

/**
 * Markdown 编辑框高度跟着内容走：编辑框内部不滚动，整页的滚动只发生在设置页内容区
 * （2026-10-19 用户口径）。值变化（输入 / 切换文件 / 重新加载）与宽度变化（窗口 / 分栏 /
 * 设置页重新显示）都会改变换行数，两种都要重算；`active` 用来覆盖「编辑 ↔ 预览」切换
 * 造成的重新挂载——那时 ref 换了元素但值可能没变。
 */
function useAutoGrowTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  active: boolean,
) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = -1;
    const fit = () => {
      // 设置页隐藏时（display: none）量不到尺寸，跳过，别把高度压成 0
      if (el.clientWidth === 0) return;
      width = el.clientWidth;
      const style = window.getComputedStyle(el);
      // scrollHeight 不含边框：border-box 下不补回来底部会差一行（又出现内部滚动）
      const border =
        (Number.parseFloat(style.borderTopWidth) || 0) +
        (Number.parseFloat(style.borderBottomWidth) || 0);
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight + border}px`;
    };
    fit();
    // 宽度变化要重算高度；jsdom（单测）没有 ResizeObserver，按项目惯例跳过观察
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== width) fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, value, active]);
}

/**
 * 文件列表的一行：**单行 32px**（名称 + 类型标签，**不带文件图标**——每行都是一份
 * Markdown，图标不提供额外信息）。行 = 外层容器（选中 / hover 底色）+ 选择按钮（名称区）
 * + 可选的删除键（独立规则，hover / 键盘聚焦时显形）——删除键必须与选择按钮是**兄弟**，
 * button 不能套 button。**不挂原生 `title`**：浏览器那枚黑底提示框与产品样式无关，说明
 * 放到编辑器标题区（选中即可见）。旧形态是两行的大块（py-1.5 + 第二行说明），在设置内容区
 * 里铺满整宽、占位又高；现在按设计系统的列表行档（§4.2）收敛，按容器宽排成竖列或两列。
 */
function FileRow({
  file,
  selected,
  dirty,
  onSelect,
  onDelete,
}: {
  file: ConstraintFile;
  selected: boolean;
  dirty: boolean;
  onSelect: () => void;
  /** 独立规则才有：行尾删除键（点开二次确认，不直接删）。 */
  onDelete?: () => void;
}) {
  const t = useText();
  const title = file.kind === "rule" ? ruleDisplayName(file.name) : file.name;
  const badge = fileBadge(file, t);
  return (
    <div
      className={`group/row flex h-8 w-full min-w-0 items-center rounded-md transition-colors duration-100 ${selected
        ? "bg-active text-foreground"
        : "text-muted hover:bg-hover hover:text-foreground"
        }`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2 text-left"
      >
        <span className="truncate text-[13px]">{title}</span>
        {badge && (
          <span
            className={`shrink-0 rounded border border-border px-1 py-0.5 text-[10px] leading-none ${selected ? "text-muted" : "text-faint"}`}
          >
            {badge}
          </span>
        )}
        {dirty && (
          <>
            <span className="size-1.5 shrink-0 rounded-full bg-warn" aria-hidden />
            <span className="sr-only">{t.constraintsUnsaved}</span>
          </>
        )}
      </button>
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`${t.constraintsDelete}：${title}`}
          className={`mr-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-faint transition-[color,background-color,opacity] duration-100 hover:bg-hover hover:text-danger focus-visible:opacity-100 group-hover/row:opacity-100 ${selected ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0 group-hover/row:pointer-events-auto"}`}
        >
          <Trash2 size={12} aria-hidden />
        </button>
      )}
    </div>
  );
}

export function ConstraintsPanel({
  focusRequest,
  onFocusDone,
}: {
  focusRequest?: SettingsFocusRequest | null;
  onFocusDone?: () => void;
}) {
  const t = useText();
  const settingsTabActive = useApp((s) => s.settingsTabActive);
  const [view, setView] = useState<ConstraintsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [staleError, setStaleError] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, EditorState>>(() => {
    const init: Record<string, EditorState> = {};
    for (const [key, value] of draftCache) init[key] = value;
    return init;
  });
  const [selected, setSelected] = useState("agents:AGENTS.md");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  // 默认预览：打开设置页看到的是渲染后的 Markdown，不是可编辑的裸文本。
  const [preview, setPreview] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newStem, setNewStem] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConstraintFile | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const loadSeq = useRef(0);
  const loadedOnce = useRef(false);
  const flashTimer = useRef<number | null>(null);

  const updateStates = useCallback(
    (updater: (prev: Record<string, EditorState>) => Record<string, EditorState>) => {
      setStates((prev) => {
        const next = updater(prev);
        // 草稿跨挂载保留（切设置页签 / 关设置视图）；写缓存与 setState 同步发生。
        draftCache.clear();
        for (const [key, value] of Object.entries(next)) draftCache.set(key, value);
        return next;
      });
    },
    [],
  );

  const load = useCallback(async (): Promise<boolean> => {
    const seq = ++loadSeq.current;
    try {
      const next = await api.getOmpConstraints();
      if (seq !== loadSeq.current) return false;
      loadedOnce.current = true;
      setView(next);
      setLoadError(null);
      setStaleError(null);
      setSelected((prev) => {
        if (next.files.some((file) => constraintKey(file.kind, file.name) === prev)) return prev;
        const first = next.files[0];
        return first ? constraintKey(first.kind, first.name) : "agents:AGENTS.md";
      });
      return true;
    } catch (error) {
      if (seq !== loadSeq.current) return false;
      const message = error instanceof Error ? error.message : String(error);
      if (loadedOnce.current) setStaleError(message);
      else setLoadError(message);
      return false;
    }
  }, []);

  // 设置视图重新激活时刷新清单（在 omp TUI / 文件管理器里改过，回来就该看到）；
  // 草稿不清——「重新加载」才是显式丢弃。
  useEffect(() => {
    if (!settingsTabActive) return;
    // 放进任务队列再发请求：effect 体内不直接 setState（与 ModelsPanel 同一口径）。
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [settingsTabActive, load]);

  // 页头刷新钮退场后（2026-10-19），外部改动（在别的编辑器里改了这些文件）靠焦点回读补上：
  // 本页编辑的正是 `~/.omp/agent` 下的文件，被外部改动的概率不低。`load()` 不动草稿。
  useVisibleRefresh(() => void load());

  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  const selectFile = useCallback((key: string) => {
    setSelected(key);
    setConflict(false);
    setSaveError(null);
    setSavedFlash(false);
    // 切换文件回到预览（默认视图）；要改内容再点「编辑」。
    setPreview(true);
    setDeleteTarget(null);
    setDeleteError(null);
  }, []);

  // 设置搜索跳转：命中文件 → 选中它（列表还没回来时等加载完成再执行）。
  useEffect(() => {
    if (!focusRequest || !view) return;
    const timer = window.setTimeout(() => {
      if (view.files.some((file) => constraintKey(file.kind, file.name) === focusRequest.key)) {
        selectFile(focusRequest.key);
      }
      onFocusDone?.();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusRequest, view, selectFile, onFocusDone]);

  const files = view?.files ?? [];
  const rules = files.filter((file) => file.kind === "rule");
  const agentsFile = files.find((file) => file.kind === "agents") ?? null;
  const rulesFile = files.find((file) => file.kind === "rules") ?? null;
  const currentFile = files.find((file) => constraintKey(file.kind, file.name) === selected) ?? null;
  const currentState = currentFile ? states[selected] ?? stateFromFile(currentFile) : null;
  const currentKind = currentFile?.kind ?? "";
  const currentSource = currentState?.source ?? "";

  // 类型标签从**当前文本**派生（frontmatter 读不懂就不下结论）；解析很轻，击键即更新。
  const ruleFields = useMemo(() => {
    if (currentKind !== "rule") return null;
    const parsed = parseRuleDoc(currentSource);
    return parsed.ok ? parsed.doc : null;
  }, [currentKind, currentSource]);

  // 编辑框高度随内容展开，滚动交给设置页内容区（预览态没有编辑框）。
  useAutoGrowTextarea(sourceRef, currentSource, currentFile !== null && !preview);

  const patchState = useCallback(
    (key: string, file: ConstraintFile, patch: (state: EditorState) => EditorState) => {
      updateStates((prev) => {
        const base = prev[key] ?? stateFromFile(file);
        return { ...prev, [key]: patch(base) };
      });
    },
    [updateStates],
  );

  const updateSource = (source: string) => {
    if (!currentFile) return;
    patchState(selected, currentFile, (state) => ({ ...state, source, dirty: true }));
  };

  const save = useCallback(
    async (force = false) => {
      if (!currentFile || !currentState || saving || currentFile.error) return;
      const text = currentState.source;
      const issue = validateConstraintText(currentFile.kind, text);
      if (issue) {
        setSaveError(issueText(issue, t));
        return;
      }
      setSaving(true);
      setSaveError(null);
      setConflict(false);
      try {
        const written = await api.writeOmpConstraint(
          currentFile.kind,
          currentFile.name,
          text,
          force ? null : currentFile.exists ? currentFile.hash : "",
        );
        setView((prev) =>
          prev
            ? {
              ...prev,
              files: prev.files.map((file) =>
                file.kind === written.kind && file.name === written.name ? written : file,
              ),
            }
            : prev,
        );
        updateStates((prev) => ({ ...prev, [selected]: stateFromFile(written) }));
        setStaleError(null);
        setSavedFlash(true);
        if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => setSavedFlash(false), 2000);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as { cause?: { code?: string } } | null)?.cause?.code;
        if (code === "CONSTRAINT_CONFLICT") setConflict(true);
        setSaveError(message);
      } finally {
        setSaving(false);
      }
    },
    [currentFile, currentState, saving, selected, t, updateStates],
  );

  // ⌘S / Ctrl+S 只在焦点位于本面板内时接管（不抢聊天输入框与搜索框）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!settingsTabActive || event.isComposing) return;
      const mod = isMacKeyboard() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!mod || event.key.toLowerCase() !== "s") return;
      if (!panelRef.current?.contains(document.activeElement)) return;
      event.preventDefault();
      void save();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsTabActive, save]);

  const reloadFile = async () => {
    if (!currentFile) return;
    const key = selected;
    const ok = await load();
    if (!ok) return;
    updateStates((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setConflict(false);
    setSaveError(null);
    setDeleteTarget(null);
  };

  const create = async () => {
    const check = newRuleName(newStem);
    if (check.error || !check.name) {
      setCreateError(check.error === "empty" ? t.constraintsNameEmpty : t.constraintsNameInvalid);
      return;
    }
    if (files.some((file) => file.kind === "rule" && file.name === check.name)) {
      setCreateError(t.constraintsRuleExists);
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    try {
      const created = await api.createOmpRule(check.name);
      setView((prev) => (prev ? { ...prev, files: [...prev.files, created] } : prev));
      updateStates((prev) => ({
        ...prev,
        [constraintKey("rule", created.name)]: stateFromFile(created),
      }));
      selectFile(constraintKey("rule", created.name));
      // 新建出来的文件是空的：下一步就是写内容，跳过预览直接进编辑态。
      setPreview(false);
      setNewStem("");
      setCreating(false);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreateBusy(false);
    }
  };

  /**
   * 删除一份规则（列表行尾的删除键与编辑器底部入口共用）：按**目标文件**删，不依赖当前
   * 选中的是哪一份；失败时弹窗保持打开、错误就地显示（可重试或取消）。
   */
  const remove = async (target: ConstraintFile) => {
    if (target.kind !== "rule" || deleteBusy) return;
    const key = constraintKey("rule", target.name);
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api.deleteOmpRule(target.name);
      setView((prev) =>
        prev
          ? {
            ...prev,
            files: prev.files.filter((file) => !(file.kind === "rule" && file.name === target.name)),
          }
          : prev,
      );
      updateStates((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      if (selected === key) selectFile("agents:AGENTS.md");
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleteBusy(false);
    }
  };

  /** 打开删除确认（列表行尾的删除键 / 编辑器底部入口）：只记目标，不动编辑器选中。 */
  const askDelete = (file: ConstraintFile) => {
    setDeleteError(null);
    setDeleteTarget(file);
  };

  const currentTitle = currentFile
    ? currentFile.kind === "rule"
      ? ruleDisplayName(currentFile.name)
      : currentFile.name
    : "";

  // 编辑区上方一行说明：三种文件各自提示它的加载口径。
  const docHint =
    currentKind === "agents"
      ? t.constraintsAgentsDocHint
      : currentKind === "rules"
        ? t.constraintsStickyForced
        : t.constraintsSourceHint;

  return (
    <div ref={panelRef} className="settings-panel">
     {/* 页头整行已按用户口径退场（2026-10-19）：说明 / 刷新钮 / agentDir 读数都不再上界面
         （当前文件的全路径在编辑器标题行里本来就有）；重读时机 = 切走页签再回来（重挂）、
         窗口重新获得焦点（`useVisibleRefresh`）与编辑器工具行的「重新加载」 */}
     {staleError && (
        <p role="alert" className="mt-3 rounded border border-warn/40 bg-warn/5 px-2 py-1.5 text-[13px] text-warn">
          {t.listRefreshFailed}：{staleError}
        </p>
      )}
      {view?.rulesError && (
        <p role="alert" className="mt-3 rounded border border-warn/40 bg-warn/5 px-2 py-1.5 text-[13px] text-warn">
          {view.rulesError}
        </p>
      )}

      {loadError && !view ? (
        <div className="mt-4 flex flex-col items-start gap-2">
          <p role="alert" className="text-[13px] text-danger">
            {t.constraintsLoadFailed}：{loadError}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[13px] transition-colors duration-100 hover:bg-hover"
          >
            {t.retry}
          </button>
        </div>
      ) : !view ? (
        <p className="mt-4 text-[13px] text-muted">{t.constraintsLoading}</p>
      ) : (
        <div className="mt-4 flex flex-col gap-5 @min-[760px]/panel:flex-row">
          <nav
            aria-label={t.tabConstraints}
            className="grid w-full shrink-0 grid-cols-1 gap-4 @min-[520px]/panel:grid-cols-2 @min-[760px]/panel:flex @min-[760px]/panel:w-60 @min-[760px]/panel:flex-col"
          >
            <section className="min-w-0">
              <h3 className="truncate px-2 text-xs font-medium text-muted">{t.constraintsGroupAgents}</h3>
              <div className="mt-1 flex flex-col gap-0.5">
                {agentsFile && (
                  <FileRow
                    file={agentsFile}
                    selected={selected === constraintKey("agents", agentsFile.name)}
                    dirty={states[constraintKey("agents", agentsFile.name)]?.dirty === true}
                    onSelect={() => selectFile(constraintKey("agents", agentsFile.name))}
                  />
                )}
              </div>
            </section>
            <section className="min-w-0">
              <h3 className="truncate px-2 text-xs font-medium text-muted">{t.constraintsGroupRules}</h3>
              <div className="mt-1 flex flex-col gap-0.5">
                {rulesFile && (
                  <FileRow
                    file={rulesFile}
                    selected={selected === constraintKey("rules", rulesFile.name)}
                    dirty={states[constraintKey("rules", rulesFile.name)]?.dirty === true}
                    onSelect={() => selectFile(constraintKey("rules", rulesFile.name))}
                  />
                )}
              </div>
            </section>
            <section className="min-w-0 @min-[520px]/panel:col-span-2">
              <div className="flex items-center gap-2">
                <h3 className="truncate px-2 text-xs font-medium text-muted">{t.constraintsGroupIndep}</h3>
                <button
                  type="button"
                  onClick={() => {
                    setCreating(true);
                    setNewStem("");
                    setCreateError(null);
                  }}
                  className="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[11px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
                >
                  <Plus size={10} aria-hidden />
                  {t.constraintsNewRule}
                </button>
              </div>
              {creating && (
                <form
                  className="mt-1.5 rounded-md border border-border bg-surface p-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void create();
                  }}
                >
                  <input
                    autoFocus
                    value={newStem}
                    onChange={(event) => {
                      setNewStem(event.target.value);
                      setCreateError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        setCreating(false);
                        setNewStem("");
                        setCreateError(null);
                      }
                    }}
                    placeholder={t.constraintsNewRulePlaceholder}
                    spellCheck={false}
                    autoComplete="off"
                    className="h-8 w-full min-w-0 rounded-md border border-border bg-surface px-2 text-[12px] outline-none transition-colors duration-100 placeholder:text-faint focus:border-accent"
                  />
                  {createError && <p className="mt-1 text-[11px] text-danger">{createError}</p>}
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <button
                      type="submit"
                      disabled={createBusy}
                      className="h-7 cursor-pointer rounded-md border border-border px-2.5 text-[12px] transition-colors duration-100 hover:bg-hover disabled:opacity-40"
                    >
                      {t.constraintsCreate}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCreating(false);
                        setNewStem("");
                        setCreateError(null);
                      }}
                      className="h-7 cursor-pointer rounded-md px-2 text-[12px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
                    >
                      {t.cancel}
                    </button>
                    {createBusy && <Loader size={11} className="animate-spin text-muted" aria-hidden />}
                  </div>
                </form>
              )}
              <div className="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 @min-[520px]/panel:grid-cols-2 @min-[760px]/panel:grid-cols-1">
                {rules.length === 0 ? (
                  <p className="col-span-1 truncate px-2 py-1 text-[11px] leading-4 text-faint @min-[520px]/panel:col-span-2">
                    {t.constraintsNoRules}
                  </p>
                ) : (
                  rules.map((file) => {
                    const key = constraintKey("rule", file.name);
                    return (
                      <FileRow
                        key={key}
                        file={file}
                        selected={selected === key}
                        dirty={states[key]?.dirty === true}
                        onSelect={() => selectFile(key)}
                        onDelete={() => askDelete(file)}
                      />
                    );
                  })
                )}
              </div>
            </section>
          </nav>

          <div className="min-w-0 flex-1">
            {!currentFile || !currentState ? (
              <p className="text-[13px] text-muted">{t.constraintsLoading}</p>
            ) : (
              <section aria-label={currentTitle}>
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-sm font-medium">{currentTitle}</h2>
                      {currentKind === "rules" && (
                        <span className={KIND_BADGE}>{t.constraintsKindAlways}</span>
                      )}
                      {currentKind === "rule" && ruleFields && (
                        <span className={KIND_BADGE}>{kindLabel(ruleKindOf(ruleFields.fields), t)}</span>
                      )}
                      {currentState.dirty && (
                        <span className="rounded border border-warn/40 bg-warn/5 px-1.5 py-0.5 text-[10px] text-warn">
                          {t.constraintsUnsaved}
                        </span>
                      )}
                      {savedFlash && <span className="text-[11px] text-accent">{t.constraintsSaved}</span>}
                    </div>
                    <p className="mt-0.5 font-mono text-[11px] break-all text-faint">
                      {currentFile.path}
                    </p>
                    {currentKind === "rule" && ruleFields?.fields.description && (
                      <p className="mt-1 text-[11px] leading-4 text-muted">{ruleFields.fields.description}</p>
                    )}
                    {currentKind === "rule" && ruleFields && ruleFields.extraFields.length > 0 && (
                      <p className="mt-1 text-[11px] text-muted">
                        {fmt(t.constraintsExtraFields, String(ruleFields.extraFields.length))}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void reloadFile()}
                      className="flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-[12px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
                    >
                      <Refresh size={11} aria-hidden />
                      {t.constraintsReload}
                    </button>
                    <button
                      type="button"
                      onClick={() => void save()}
                      disabled={!currentState.dirty || saving || currentFile.error !== null}
                      title={t.constraintsSaveHint}
                      className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 text-[12px] transition-colors duration-100 hover:bg-hover disabled:opacity-40"
                    >
                      {saving && <Loader size={11} className="animate-spin" aria-hidden />}
                      {saving ? t.constraintsSaving : t.constraintsSave}
                    </button>
                  </div>
                </div>

                {!currentFile.exists && (
                  <p className="mt-2 text-[11px] text-muted">{t.constraintsMissing}</p>
                )}
                {currentFile.error && (
                  <p role="alert" className="mt-2 rounded border border-danger/40 bg-danger/5 px-2 py-1.5 text-[13px] text-danger">
                    {t.constraintsUnreadable}：{currentFile.error}
                  </p>
                )}
                {conflict && (
                  <div
                    role="alert"
                    className="mt-2 rounded border border-warn/40 bg-warn/5 px-2.5 py-2 text-[13px] text-warn"
                  >
                    <p>{t.constraintsConflict}</p>
                    <p className="mt-0.5 text-xs">{t.constraintsConflictHint}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void reloadFile()}
                        className="h-7 cursor-pointer rounded-md border border-border px-2.5 text-[12px] text-foreground transition-colors duration-100 hover:bg-hover"
                      >
                        {t.constraintsReload}
                      </button>
                      <button
                        type="button"
                        onClick={() => void save(true)}
                        disabled={saving}
                        className="h-7 cursor-pointer rounded-md border border-warn/50 px-2.5 text-[12px] transition-colors duration-100 hover:bg-warn/10 disabled:opacity-40"
                      >
                        {t.constraintsOverwrite}
                      </button>
                    </div>
                  </div>
                )}
                {saveError && !conflict && (
                  <p role="alert" className="mt-2 rounded border border-danger/40 bg-danger/5 px-2 py-1.5 text-[13px] text-danger">
                    {saveError}
                  </p>
                )}

                <div className="mt-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted">{docHint}</p>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setPreview(false)}
                        aria-pressed={!preview}
                        className={`h-6 cursor-pointer rounded-md border px-2 text-[11px] transition-colors duration-100 ${!preview
                          ? "border-accent/50 bg-active text-foreground"
                          : "border-border text-muted hover:bg-hover hover:text-foreground"
                          }`}
                      >
                        {t.constraintsEditMode}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPreview(true)}
                        aria-pressed={preview}
                        className={`h-6 cursor-pointer rounded-md border px-2 text-[11px] transition-colors duration-100 ${preview
                          ? "border-accent/50 bg-active text-foreground"
                          : "border-border text-muted hover:bg-hover hover:text-foreground"
                          }`}
                      >
                        {t.constraintsPreview}
                      </button>
                    </div>
                  </div>
                  {preview ? (
                    <div className="md-body mt-2 min-h-[240px] rounded-md border border-border-soft bg-surface p-3 text-[13px] leading-6">
                      <MarkdownPreview text={previewText(currentSource)} empty={t.constraintsPreviewEmpty} />
                    </div>
                  ) : (
                    <textarea
                      ref={sourceRef}
                      value={currentSource}
                      onChange={(event) => updateSource(event.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                      aria-label={currentTitle}
                      className="mt-2 min-h-[380px] w-full resize-none overflow-hidden rounded-md border border-border bg-surface p-2.5 font-mono text-[12.5px] leading-5 outline-none transition-colors duration-100 focus:border-accent"
                    />
                  )}
                </div>
              </section>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        danger
        title={deleteTarget ? fmt(t.constraintsDeleteConfirm, ruleDisplayName(deleteTarget.name)) : t.constraintsDelete}
        detail={deleteError ?? t.constraintsDeleteDetail}
        confirmLabel={t.delete}
        onConfirm={() => {
          if (deleteTarget && !deleteBusy) void remove(deleteTarget);
        }}
        onCancel={() => {
          setDeleteTarget(null);
          setDeleteError(null);
        }}
      />
    </div>
  );
}
