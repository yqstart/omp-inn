import { useCallback, useEffect, useRef, useState } from "react";
import { Bolt, Command, Folder, Nodes, Plus, X } from "reicon-react";
import { WORKBENCH_MAX, WORKBENCH_MIN, useApp } from "../../stores/app";
import { resolveContext } from "../../lib/context";
import { useText } from "../../lib/useText";
import { wslDistroOf } from "../../lib/wsl";
import { FileTree } from "./FileTree";
import { GitGraphPanel } from "./GitGraphPanel";
import { ScriptsPanel } from "./ScriptsPanel";
import { TerminalPane } from "./TerminalPane";

/** 右栏宽度上限还要给中列留出可用宽度：窗口扣除左栏后至少留这么多（消息列 + 输入卡）。 */
const CENTER_MIN = 420;
/** 手柄聚焦时 ←→ 微调步长。 */
const STEP = 8;

/**
 * 右栏工作台（V42 / V43 / V44 / V51）：**文件 / Git 图谱 / 脚本 / 终端**四个页签。
 *
 * - 始终停靠为第三栏（打开 = 主区变三栏，会话列让位、不遮盖）；开关 `workbenchOpen` 只决定这一栏在不在。
 * - 面板**常驻挂载**（收起 / 切页签只改显隐）：终端进程与 xterm 回看缓冲不因为收起右栏而丢。
 * - **左缘可拖调宽**（260–640，持久化；口径与左栏 `SidebarShell` 同一套：3px 隐身热区、
 *   悬停 / 拖拽高亮、焦点下 ←→ 微调）。拖拽按「指针到右栏右缘的距离」算宽度——主区有外边距
 *   也不影响手感；另有窗口约束（给中列留 `CENTER_MIN`）。
 * - 目标目录 = 当前会话的工作目录（`resolveContext`）——**新建的终端**用它当 cwd；
 *   已经开着的终端是用户的（多开、各自一个常驻 shell），不随会话切换被杀或改目录，
 *   应用退出统一收尾（`pty.rs`）。
 */
export function WorkbenchPanel() {
 const t = useText();
 const open = useApp((s) => s.workbenchOpen);
 const setOpen = useApp((s) => s.setWorkbenchOpen);
 const tab = useApp((s) => s.workbenchTab);
 const setTab = useApp((s) => s.setWorkbenchTab);
 const settingsTabActive = useApp((s) => s.settingsTabActive);
 const projects = useApp((s) => s.projects);
 const sessions = useApp((s) => s.sessions);
 const activeSessionId = useApp((s) => s.activeSessionId);
 const terminals = useApp((s) => s.terminals);
 const activeTerminalId = useApp((s) => s.activeTerminalId);
 const newTerminal = useApp((s) => s.newTerminal);
 const closeTerminal = useApp((s) => s.closeTerminal);
 const setActiveTerminal = useApp((s) => s.setActiveTerminal);
 const sidebarWidth = useApp((s) => s.sidebarWidth);
 const width = useApp((s) => s.workbenchWidth);
 const setWorkbenchWidth = useApp((s) => s.setWorkbenchWidth);
 const { cwd } = resolveContext(projects, sessions, activeSessionId);
 const visible = open && !settingsTabActive;
 const asideRef = useRef<HTMLElement | null>(null);
 /** 拖拽中的快速判断（不进渲染）；热区 / 拖拽的视觉态用 state（render 里不许读 ref）。 */
 const dragging = useRef(false);
 const [hot, setHot] = useState(false);
 const [draggingUi, setDraggingUi] = useState(false);

 /** 当前允许的最大宽度：窗口扣掉左栏（窄窗下左栏是抽屉、不占位）与中列最小宽度后取小。 */
 const maxWidthNow = useCallback(() => {
  if (typeof window === "undefined") return WORKBENCH_MAX;
  const left = window.innerWidth < 768 ? 0 : sidebarWidth;
  return Math.max(WORKBENCH_MIN, Math.min(WORKBENCH_MAX, window.innerWidth - left - CENTER_MIN));
 }, [sidebarWidth]);

 const resizeTo = useCallback(
  (w: number) => setWorkbenchWidth(Math.min(w, maxWidthNow())),
  [setWorkbenchWidth, maxWidthNow],
 );

 // 拖拽：指针到右栏右缘的距离就是目标宽度（主区外边距有多少都不影响手感）
 useEffect(() => {
  const move = (e: PointerEvent) => {
   if (!dragging.current) return;
   const el = asideRef.current;
   if (!el) return;
   resizeTo(el.getBoundingClientRect().right - e.clientX);
  };
  const up = () => {
   if (!dragging.current) return;
   dragging.current = false;
   setDraggingUi(false);
   document.body.style.cursor = "";
   document.body.style.userSelect = "";
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  return () => {
   window.removeEventListener("pointermove", move);
   window.removeEventListener("pointerup", up);
  };
 }, [resizeTo]);

 // 窗口宽度对齐：挂载时先量一次（上次会话可能留下超出当前窗口的宽度），变窄时把超限宽度收回
 // ——否则右栏会把中列挤扁（值没变不写）。同步到 store 是 effect 的正当用途。
 useEffect(() => {
  const clampToWindow = () => {
   const max = maxWidthNow();
   if (useApp.getState().workbenchWidth > max) setWorkbenchWidth(max);
  };
  clampToWindow();
  window.addEventListener("resize", clampToWindow);
  return () => window.removeEventListener("resize", clampToWindow);
 }, [maxWidthNow, setWorkbenchWidth]);

 // 进终端页签时保证至少有一个终端（列表空就按当前会话目录新建一个）；已经有终端就不动——
 // 多开的那几个是用户的，不许被会话切换重置。同步到 store 是 effect 的正当用途。
 useEffect(() => {
  if (!visible || tab !== "terminal" || !cwd) return;
  if (useApp.getState().terminals.length > 0) return;
  newTerminal(cwd);
 }, [visible, tab, cwd, newTerminal]);

 const tabButton = (
  key: "files" | "graph" | "scripts" | "terminal",
  Icon: typeof Folder,
  label: string,
  title = label,
 ) => (
  <button
   onClick={() => setTab(key)}
   aria-pressed={tab === key}
   aria-label={title}
   title={title}
   className={`flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[11px] whitespace-nowrap transition-colors duration-100 ${
    tab === key ? "bg-active text-foreground" : "text-muted hover:bg-hover hover:text-foreground"
   }`}
  >
   <Icon size={12} aria-hidden />
   <span>{label}</span>
  </button>
 );

 return (
  <aside
   ref={asideRef}
   style={{ width }}
   className={`${visible ? "flex" : "hidden"} relative shrink-0 flex-col overflow-hidden border-l border-border bg-sidebar`}
   aria-label={t.workbenchTitle}
  >
   {/* 左缘拖拽热区（口径同左栏：平时 3px 隐身、悬停 / 拖拽 6px 高亮；← 向左扩、→ 向右收） */}
   <div
    role="separator"
    aria-orientation="vertical"
    aria-label={t.workbenchResizeAria}
    aria-valuemin={WORKBENCH_MIN}
    aria-valuemax={Math.round(maxWidthNow())}
    aria-valuenow={Math.round(width)}
    tabIndex={0}
    onKeyDown={(e) => {
     if (e.key === "ArrowLeft") resizeTo(width + STEP);
     if (e.key === "ArrowRight") resizeTo(width - STEP);
    }}
    onPointerDown={(e) => {
     dragging.current = true;
     setDraggingUi(true);
     document.body.style.cursor = "col-resize";
     document.body.style.userSelect = "none";
     (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    }}
    onPointerEnter={() => setHot(true)}
    onPointerLeave={() => {
     if (!dragging.current) setHot(false);
    }}
    className={`absolute top-0 left-0 z-10 h-full cursor-col-resize touch-none transition-colors focus-visible:outline-none ${
     hot || draggingUi ? "w-1.5 bg-accent/45" : "w-[3px] bg-transparent"
    }`}
   />
   <header className="flex h-(--h-chrome) shrink-0 items-center gap-1 border-b border-border px-2">
    {/* 四个页签在窄栏（260px）可能放不下：页签区自己横向滚动，关闭键固定在外侧 */}
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
     {tabButton("files", Folder, t.workbenchFiles)}
     {tabButton("graph", Nodes, t.workbenchGraph, t.workbenchGraphTitle)}
     {tabButton("scripts", Bolt, t.workbenchScripts)}
     {tabButton("terminal", Command, t.workbenchTerminal)}
    </div>
    <button
     onClick={() => setOpen(false)}
     className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
     aria-label={t.workbenchCloseAria}
     title={t.workbenchCloseAria}
    >
     <X size={13} aria-hidden />
    </button>
   </header>
   {/* 文件页签与终端页签都保持挂载：切页签不打断终端、也不丢树的展开位置 */}
   <div className={`min-h-0 flex-1 ${tab === "files" ? "" : "hidden"}`}>
    {cwd ? (
     <FileTree root={cwd} />
    ) : (
     <p className="px-3.5 py-4 text-[12px] text-faint">{t.workbenchNoSession}</p>
    )}
   </div>
   {/* Git 图谱页签：常驻挂载，只有真的显示过才拉提交历史（`visible` 传给面板自己判） */}
   <div className={`min-h-0 flex-1 ${tab === "graph" ? "" : "hidden"}`}>
    {cwd ? (
     <GitGraphPanel cwd={cwd} visible={visible && tab === "graph"} />
    ) : (
     <p className="px-3.5 py-4 text-[12px] text-faint">{t.workbenchNoSession}</p>
    )}
   </div>
   {/* 脚本页签：常驻挂载，但只有真的显示过才扫描项目（`visible` 传给面板自己判） */}
   <div className={`min-h-0 flex-1 ${tab === "scripts" ? "" : "hidden"}`}>
    {cwd ? (
     <ScriptsPanel cwd={cwd} visible={visible && tab === "scripts"} />
    ) : (
     <p className="px-3.5 py-4 text-[12px] text-faint">{t.workbenchNoSession}</p>
    )}
   </div>
   {/* 终端页签（V44 多开）：上面是终端标签行（切换 / 新建 / 关闭），下面是当前终端。
       所有终端都保持挂载：切标签只切显隐，回看缓冲与常驻 shell 都不丢。 */}
   <div className={`flex min-h-0 flex-1 flex-col ${tab === "terminal" ? "" : "hidden"}`}>
    {cwd ? (
     <>
      <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border-soft px-1">
       {terminals.map((term) => (
        <div
         key={term.id}
         className={`flex h-6 shrink-0 items-center rounded-md pr-0.5 pl-2 text-[11px] transition-colors duration-100 ${
          term.id === activeTerminalId ? "bg-active text-foreground" : "text-muted hover:bg-hover hover:text-foreground"
         }`}
        >
         <button
          onClick={() => setActiveTerminal(term.id)}
          className="max-w-[96px] cursor-pointer truncate"
          title={`${term.title} — ${term.cwd}${wslDistroOf(term.cwd) ? ` (WSL: ${wslDistroOf(term.cwd)})` : ""}`}
         >
          {term.title}
         </button>
         <button
          onClick={() => closeTerminal(term.id)}
          aria-label={t.terminalClose}
          title={t.terminalClose}
          className="ml-0.5 flex size-4 shrink-0 cursor-pointer items-center justify-center rounded text-faint transition-colors duration-100 hover:bg-hover hover:text-foreground"
         >
          <X size={10} aria-hidden />
         </button>
        </div>
       ))}
       <button
        onClick={() => newTerminal(cwd)}
        aria-label={t.terminalNew}
        title={t.terminalNew}
        className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-faint transition-colors duration-100 hover:bg-hover hover:text-foreground"
       >
        <Plus size={11} aria-hidden />
       </button>
      </div>
      <div className="relative min-h-0 flex-1">
       {terminals.map((term) => (
        <TerminalPane
         key={term.id}
         id={term.id}
         cwd={term.cwd}
         visible={visible && tab === "terminal" && term.id === activeTerminalId}
        />
       ))}
      </div>
     </>
    ) : (
     <p className="px-3.5 py-4 text-[12px] text-faint">{t.workbenchNoSession}</p>
    )}
   </div>
  </aside>
 );
}
