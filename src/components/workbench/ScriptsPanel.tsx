import { useEffect, useState } from "react";
import { Edit, Play, Plus, Refresh, Trash } from "reicon-react";
import { api } from "@shared/api";
import type { ScriptCatalog } from "@shared/types";
import { type CustomScript, useApp } from "../../stores/app";
import { fmt } from "../../lib/locale";
import { useText } from "../../lib/useText";

/** 稳定的空数组引用：selector 里 `?? EMPTY` 每次新建数组会让 zustand 无限重渲染。 */
const EMPTY: CustomScript[] = [];

/**
 * 右栏「脚本」页签（V43）：把项目里能跑的东西摆出来，点一下就在右栏终端里执行。
 *
 * - **项目脚本**（只读）：`discover_scripts` 扫清单文件——`package.json` 的 scripts（按锁文件判包管理器）、
 *   `Cargo.toml` 与 `.cargo` aliases、`go.mod`、`manage.py` / `pyproject.toml`、
 *   `Makefile` / `justfile` / `Taskfile`。进面板 / 切项目 / 点刷新时重扫。
 * - **自定义脚本**：本应用偏好（`store.customScripts`，按项目目录分组，不写用户仓库），行内可增删改。
 * - **执行**：`runInTerminal(cwd, command)` —— 展开右栏 + 切到终端页签，命令由该 cwd 的
 *   `TerminalPane` 在 shell 起来后写进 PTY（面板侧只管投递，不自己起进程）。
 *
 * 状态口径：识别结果**连 cwd 一起存**（`result.cwd`），切项目时旧结果自动失效——这样「加载中」
 * 是派生值，不必在 effect 里同步 setState（级联渲染）也能正确显示。
 */
export function ScriptsPanel({ cwd, visible }: { cwd: string; visible: boolean }) {
 const t = useText();
 const custom = useApp((s) => s.customScripts[cwd] ?? EMPTY);
 const runInTerminal = useApp((s) => s.runInTerminal);
 const [result, setResult] = useState<{ cwd: string; catalog: ScriptCatalog | null; error: string | null } | null>(
  null,
 );
 const [refreshSeq, setRefreshSeq] = useState(0);
 /** 编辑中的自定义脚本：`id` 为 null = 新建。 */
 const [draft, setDraft] = useState<{ id: string | null; name: string; command: string } | null>(null);
 const catalog = result && result.cwd === cwd ? result.catalog : null;
 const error = result && result.cwd === cwd ? result.error : null;
 const loading = catalog === null && error === null;

 useEffect(() => {
  // 面板常驻挂载：只有这个页签**真的显示过**才扫描项目（切回来重扫一次，保证清单新鲜）
  if (!visible) return;
  let alive = true;
  void api.discoverScripts(cwd).then(
   (c) => {
    if (alive) setResult({ cwd, catalog: c, error: null });
   },
   (err: unknown) => {
    if (alive) setResult({ cwd, catalog: null, error: String(err) });
   },
  );
  return () => {
   alive = false;
  };
 }, [cwd, refreshSeq, visible]);

 const saveDraft = () => {
  if (!draft) return;
  const name = draft.name.trim();
  const command = draft.command.trim();
  if (!name || !command) return;
  const s = useApp.getState();
  if (draft.id) s.updateCustomScript(cwd, draft.id, { name, command });
  else s.addCustomScript(cwd, name, command);
  setDraft(null);
 };

 const ecosystems = catalog?.ecosystems ?? [];
 const scripts = catalog?.scripts ?? [];
 const draftReady = !!draft && draft.name.trim().length > 0 && draft.command.trim().length > 0;

 return (
  <div className="flex h-full min-h-0 flex-col">
   <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border-soft px-2">
    <span className="min-w-0 flex-1 truncate text-[11px] text-muted" title={ecosystems.join(" · ")}>
     {loading
      ? t.scriptsDetecting
      : ecosystems.length > 0
       ? fmt(t.scriptsEcosystems, ecosystems.join(" · "))
       : t.scriptsProjectTitle}
    </span>
    <button
     onClick={() => {
      // 清掉当前结果回到「识别中」，再自增触发重扫（都在事件里，effect 不做同步 setState）
      setResult(null);
      setRefreshSeq((n) => n + 1);
     }}
     className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-faint transition-colors duration-100 hover:bg-hover hover:text-foreground"
     aria-label={t.filesRefresh}
     title={t.filesRefresh}
    >
     <Refresh size={11} aria-hidden />
    </button>
   </div>
   <div className="min-h-0 flex-1 overflow-y-auto py-1 pr-1">
    {/* 项目脚本（只读识别结果） */}
    {error ? (
     <p className="px-3 py-1 text-[11px] text-danger" title={error}>
      {t.scriptsDetectFailed}
     </p>
    ) : scripts.length === 0 ? (
     <p className="px-3 py-2 text-[11px] leading-relaxed text-faint">
      {loading ? t.scriptsDetecting : t.scriptsEmpty}
     </p>
    ) : (
     scripts.map((s) => (
      // 标题用脚本名：多开时标签行一眼看出哪个终端在跑哪条脚本
      <ScriptRow key={`${s.source}:${s.name}`} script={s} onRun={() => runInTerminal(cwd, s.command, s.name)} />
     ))
    )}

    {/* 自定义脚本（本应用偏好） */}
    <div className="mt-2 flex h-7 items-center gap-1 border-t border-border-soft px-2 pt-1.5">
     <span className="min-w-0 flex-1 truncate text-[11px] font-medium tracking-wide text-muted">
      {t.scriptsCustomTitle}
     </span>
     <button
      onClick={() => setDraft({ id: null, name: "", command: "" })}
      className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-faint transition-colors duration-100 hover:bg-hover hover:text-foreground"
      aria-label={t.scriptsNew}
      title={t.scriptsNew}
     >
      <Plus size={11} aria-hidden />
     </button>
    </div>
    {draft && (
     <div className="mx-2 mt-1 rounded-md border border-border bg-surface p-2">
      <input
       autoFocus
       value={draft.name}
       onChange={(e) => setDraft({ ...draft, name: e.target.value })}
       onKeyDown={(e) => {
        if (e.key === "Enter") saveDraft();
        if (e.key === "Escape") setDraft(null);
       }}
       placeholder={t.scriptsNamePlaceholder}
       aria-label={t.scriptsNamePlaceholder}
       className="h-7 w-full rounded-md border border-border bg-surface px-2 text-[12px] outline-none focus:border-accent"
      />
      <input
       value={draft.command}
       onChange={(e) => setDraft({ ...draft, command: e.target.value })}
       onKeyDown={(e) => {
        if (e.key === "Enter") saveDraft();
        if (e.key === "Escape") setDraft(null);
       }}
       placeholder={t.scriptsCommandPlaceholder}
       aria-label={t.scriptsCommandPlaceholder}
       className="mt-1.5 h-7 w-full rounded-md border border-border bg-surface px-2 font-mono text-[11px] outline-none focus:border-accent"
      />
      <div className="mt-1.5 flex items-center justify-end gap-1">
       <button
        onClick={() => setDraft(null)}
        className="h-6 cursor-pointer rounded-md px-2 text-[11px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
       >
        {t.cancel}
       </button>
       <button
        onClick={saveDraft}
        disabled={!draftReady}
        className="h-6 cursor-pointer rounded-md bg-primary px-2.5 text-[11px] text-primary-foreground transition-opacity duration-100 hover:opacity-90 disabled:cursor-default disabled:opacity-40"
       >
        {t.scriptsSave}
       </button>
      </div>
     </div>
    )}
    {custom.length === 0 && !draft ? (
     <p className="px-3 py-2 text-[11px] text-faint">{t.scriptsCustomEmpty}</p>
    ) : (
     custom.map((s) => (
      <ScriptRow
       key={s.id}
       script={s}
       onRun={() => runInTerminal(cwd, s.command, s.name)}
       onEdit={() => setDraft({ id: s.id, name: s.name, command: s.command })}
       onDelete={() => useApp.getState().removeCustomScript(cwd, s.id)}
      />
     ))
    )}
   </div>
  </div>
 );
}

/**
 * 一行脚本：整行点 = 在终端里跑；命令预览在行尾（完整命令进 title）。
 * 自定义脚本多两个行尾键（编辑 / 删除），hover 时才替换掉命令预览；项目脚本显示来源文件。
 */
function ScriptRow({
 script,
 onRun,
 onEdit,
 onDelete,
}: {
 script: { name: string; command: string; source?: string };
 onRun: () => void;
 onEdit?: () => void;
 onDelete?: () => void;
}) {
 const t = useText();
 const custom = !!onEdit;
 return (
  <div className="group flex h-7 items-center gap-1 rounded-md pr-1 transition-colors duration-100 hover:bg-hover">
   <button
    onClick={onRun}
    className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 pl-2 text-left"
    title={`${script.name} — ${script.command}`}
   >
    <Play size={11} aria-hidden className="shrink-0 text-faint" />
    <span className="min-w-0 flex-1 truncate text-[12px]">{script.name}</span>
    <span
     className={`max-w-[45%] shrink-0 truncate font-mono text-[10px] text-faint ${custom ? "group-hover:hidden" : ""}`}
    >
     {script.command}
    </span>
    {!custom && script.source && <span className="shrink-0 text-[10px] text-faint">{script.source}</span>}
   </button>
   {custom && (
    <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
     <button
      onClick={onEdit}
      className="flex size-5 cursor-pointer items-center justify-center rounded text-faint transition-colors duration-100 hover:bg-active hover:text-foreground"
      aria-label={t.scriptsEdit}
      title={t.scriptsEdit}
     >
      <Edit size={11} aria-hidden />
     </button>
     <button
      onClick={onDelete}
      className="flex size-5 cursor-pointer items-center justify-center rounded text-faint transition-colors duration-100 hover:bg-active hover:text-danger"
      aria-label={t.scriptsDelete}
      title={t.scriptsDelete}
     >
      <Trash size={11} aria-hidden />
     </button>
    </span>
   )}
  </div>
 );
}
