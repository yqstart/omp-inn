import { useEffect, useRef, useState } from "react";
import { Download, Menu, SidebarRight } from "reicon-react";
import { openPath } from "@tauri-apps/plugin-opener";
import { api } from "@shared/api";
import { useApp } from "../../stores/app";
import { fmt } from "../../lib/locale";
import { isWindows } from "../../lib/platform";
import { useText } from "../../lib/useText";
import { refreshSessionView } from "../../lib/sessionOpen";
import { appendLocalNote } from "../../lib/localNote";
import { sessionTitleForDisplay } from "../../lib/sessionTitle";

/**
 * 中列顶部标题栏（v2 §1.2 形态；2026-10-19 按用户口径重排）：
 * **标题靠左**、紧跟一枚「导出会话」图标钮，右端只剩右栏工作台开关。高度走 `--h-chrome` 语义档。
 *
 * - 标题点击仍是就地改名（v1 口径保留：点标题改名的肌肉记忆不该被 v2 打断）：输入框回显
 *   **显示名**（`sessionTitleForDisplay`，omp 标题卡的图标 / 短码不进输入框），提交 = Enter
 *   或**点输入框外**（改过才写 omp 真名），Esc 取消；
 * - **左侧 `···` 菜单已退场**（2026-10-19 用户口径）：菜单里的动作各回原有入口——重命名 = 点标题
 *   （同一条链路）、归档会话 = 左栏行操作、会话统计 = `/status` 与卡底统计条；只有**导出会话**
 *   没有等价入口，留成标题右侧的图标钮（与输入框 `/export` 同一条后端命令）。图标用 `Download`
 *   系（下箭头 + 托盘）：2026-10-19 用户反馈 `Export` 的向上箭头看着像「上传」；
 * - 右端只剩「窗口 chrome」：上下文容量环与供应商用量 2026-10-14 搬进输入卡工具行
 *   （它们是「要不要再开一轮」的决策读数，跟输入框待在一起才有用）；
 * - 左端窄屏（<768px）保留抽屉入口，否则项目列表与设置不可达。
 * - **整条标题栏都是窗口拖拽区**（`data-tauri-drag-region="deep"`）：Tauri 的拖拽脚本只会
 *   对**直接命中**带属性的元素的 mousedown 生效（裸属性 / `"true"`），而这条标题栏的内容
 *   全在两层 flex 容器里——属性只挂在 `<header>` 上时，除了 72px 红绿灯留白和几像素的
 *   gap，按在标题栏任何地方都拖不动窗口（用户实测）。`deep` 让点击沿子树任意元素都算拖拽，
 *   交互件（标题按钮 / 导出 / 工作台开关 / 改名输入框）不带属性、脚本按 clickable 元素短路，
 *   点击语义不受影响；**空态标题是 disabled 按钮**，收不到 mousedown 还会挡住拖拽区，
 *   所以禁用态挂 `pointer-events-none` 把它让给标题栏。
 */
export function TopBar() {
 const { activeSessionId, sessions, set, workbenchOpen, setWorkbenchOpen } = useApp();
 const t = useText();
 const cur = sessions.find((s) => s.id === activeSessionId);
 /** 改名草稿：`original` = 打开时的回显值（**显示口径**，标题卡前缀已剥）——原样提交 = 没改名，不写 omp。 */
 const [draft, setDraft] = useState<{ text: string; original: string } | null>(null);
 const title = sessionTitleForDisplay(cur?.title?.trim() || "") || t.unnamedChat;
 const inputRef = useRef<HTMLInputElement | null>(null);
 /** 一次编辑只结算一次：同一次点击里 pointerdown 提交之后，blur 还会再来一发。 */
 const settledRef = useRef(false);
 const editing = draft !== null;

 // 每次打开输入框都清掉「已结算」的闸门（ref 只在 effect / 事件里碰，不在 render 里写）
 useEffect(() => {
  if (editing) settledRef.current = false;
 }, [editing]);

 /** 打开改名输入框：回显**显示名**——与标题显示同口径（备注非空优先，否则 omp 原标题；两者都按
  *  `sessionTitleForDisplay` 剥开头的前缀），图标 / 短码不进输入框，剥的只是回显、数据不动。 */
 const startEdit = () => {
  if (!cur) return;
  const raw = cur.note?.trim() ? cur.note : cur.title ?? "";
  const text = sessionTitleForDisplay(raw);
  setDraft({ text, original: text });
 };

 /**
  * 结算并关掉输入框：`commit` = 改过就写 omp 真名（V40 口径：`set_session_name` 落 jsonl 的
  * title 行，覆盖层的旧备注由后端一并清掉）；没改过 / 取消（Esc）就只关。
  */
 const settleEdit = (commit: boolean) => {
  const d = draft;
  if (settledRef.current) return;
  settledRef.current = true;
  setDraft(null);
  if (!commit || !d || !cur || d.text.trim() === d.original.trim()) return;
  const id = cur.id;
  void api.renameSession(id, d.text).then(() => refreshSessionView(id)).catch(() => undefined);
 };

 /** 点输入框外 = 提交（与 Enter 同一条链路）。不用 `onBlur` 当唯一入口：WKWebView 里点非聚焦元素
  *  不搬焦点，blur 不可靠（`useDropdown` 的「点外部」同理走 document pointerdown）。 */
 const settleRef = useRef(settleEdit);
 useEffect(() => {
  settleRef.current = settleEdit;
 });
 useEffect(() => {
  if (!editing) return;
  const onDown = (event: PointerEvent) => {
   if (event.target instanceof Node && inputRef.current?.contains(event.target)) return;
   settleRef.current(true);
  };
  document.addEventListener("pointerdown", onDown);
  return () => document.removeEventListener("pointerdown", onDown);
 }, [editing]);

 /** 导出会话 HTML（与 `/export` 同一条后端命令）：结果落一条本地 command 行，随后系统打开。 */
 const exportSession = async () => {
  if (!activeSessionId) return;
  try {
   const { path } = await api.exportSessionHtml(activeSessionId);
   if (path) {
    appendLocalNote(activeSessionId, fmt(t.exportDone, path));
    void openPath(path).catch(() => undefined);
   }
  } catch (e) {
   appendLocalNote(activeSessionId, e instanceof Error ? e.message : String(e));
  }
 };

 return (
  // Overlay 标题栏：整条是窗口拖拽区（`deep`：子元素里的空白也拖，交互件自己吃掉点击）；
  // 左侧留 72px 给 macOS 红绿灯；标题靠左（2026-10-19），右端只剩工作台开关
  <header
   data-tauri-drag-region="deep"
   className={`relative flex h-(--h-chrome) shrink-0 items-center gap-1 border-b border-border bg-background pr-2 ${isWindows() ? "pl-3" : "pl-[72px]"}`}
  >
   {/* 窄窗（<768px）左栏收起为抽屉：这里必须有打开入口，否则项目列表与设置不可达 */}
   <button
    onClick={() => set({ sidebarOpen: true })}
    className="flex cursor-pointer items-center justify-center rounded-md p-1.5 text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground md:hidden"
    aria-label={t.openSidebar}
    title={t.openSidebar}
   >
    <Menu size={16} aria-hidden />
   </button>
   {/* 左：标题（点击就地改名）+ 导出会话（标题右侧的图标钮） */}
   <div className="flex min-w-0 flex-1 items-center gap-0.5">
    {draft && cur ? (
     <input
      ref={inputRef}
      autoFocus
      value={draft.text}
      onChange={(e) => setDraft((d) => (d ? { ...d, text: e.target.value } : d))}
      onBlur={() => settleEdit(true)}
      onKeyDown={(e) => {
       // IME 组字的回车只提交候选，不算改名确认
       if (e.nativeEvent.isComposing) return;
       if (e.key === "Enter") settleEdit(true);
       if (e.key === "Escape") settleEdit(false);
      }}
      aria-label={t.renameNoteAria}
      className="w-64 max-w-full rounded-md border border-border bg-background px-2 py-1 text-[13px] outline-none focus:border-accent/70"
     />
    ) : (
     <button
      onClick={startEdit}
      disabled={!cur}
      // 空态（没有活动会话）标题不可点：让出这一片，按在「未命名会话」上也能拖窗——
      // disabled 的按钮收不到 mousedown，同时会挡住 `deep` 拖拽区
      className="min-w-0 max-w-full cursor-pointer truncate rounded-md px-2 py-0.5 text-left text-[13px] font-semibold transition-colors duration-100 hover:bg-hover disabled:pointer-events-none disabled:cursor-default"
      aria-label={cur ? fmt(t.chatTitleAria, title) : t.unnamedChat}
      title={cur ? t.chatTitleTitle : ""}
     >
      {title}
     </button>
    )}
    <button
     onClick={() => void exportSession()}
     disabled={!activeSessionId}
     className="flex shrink-0 cursor-pointer items-center justify-center rounded-md p-1.5 text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground disabled:pointer-events-none disabled:cursor-default disabled:opacity-40"
     aria-label={t.sessionMenuExport}
     title={t.sessionMenuExport}
    >
     <Download size={15} aria-hidden />
    </button>
   </div>
   {/* 右端图标组（v2）：右栏工作台开关（文件 / 终端；用量与上下文容量环在输入卡工具行） */}
   <div className="flex shrink-0 items-center gap-0.5">
    <button
     onClick={() => setWorkbenchOpen(!workbenchOpen)}
     className={`flex cursor-pointer items-center justify-center rounded-md p-1.5 transition-colors duration-100 ${workbenchOpen ? "bg-active text-foreground" : "text-muted hover:bg-hover hover:text-foreground"}`}
     aria-label={t.workbenchToggleAria}
     aria-pressed={workbenchOpen}
     title={t.workbenchToggleAria}
    >
     <SidebarRight size={16} aria-hidden />
    </button>
   </div>
  </header>
 );
}
