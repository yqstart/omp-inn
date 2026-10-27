import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useApp, SIDEBAR_MAX, SIDEBAR_MIN } from "../stores/app";
import { applyTheme } from "../lib/theme";
import { useText } from "../lib/useText";
import { api } from "@shared/api";
import { IPC } from "@shared/ipc";
import type { ModelCatalog } from "@shared/types";
import { ChatSidebar } from "../components/sidebar/ChatSidebar";
import { ReferencePicker } from "../components/ReferencePicker";
import { CommitTaskPanel } from "../components/git/CommitTaskPanel";
import { PullConflictDialog } from "../components/git/PullConflictDialog";
import { HealthBanner } from "../components/HealthBanner";
import { SettingsPage } from "../components/SettingsPage";
import { ChatView } from "../components/thread/ChatView";
import { WorkbenchPanel } from "../components/workbench/WorkbenchPanel";
import { UpdateDialog } from "../components/update/UpdateDialog";
import { OmpUpdateDialog } from "../components/update/OmpUpdateDialog";
import { OmpInstallDialog } from "../components/update/OmpInstallDialog";
import { ProviderUsageDialog } from "../components/usage/ProviderUsageDialog";
import { hasWorkspaceRefs } from "../lib/workspaceFiles";
import { newChatInDefaultCheckout, refreshSidebar } from "../lib/checkouts";
import { openSessionWithHistory } from "../lib/sessionOpen";
import { loadLastSession, saveLastSession } from "../lib/lastSession";
import { refreshWorkspaceGitState, startWorkspaceGitPolling } from "../lib/commitTasks";
import { autoCheckOnBoot } from "../lib/appUpdate";
import { autoCheckOmpUpdate } from "../lib/ompUpdate";
import { loadApprovalState } from "../lib/sessionApproval";
import { ensureOmpDefaultThinking } from "../lib/thinkingDefault";
import { syncTitlePromptLanguage } from "../lib/titlePrompt";
import { hasOpenDialog, useDialogFocus } from "../lib/useDropdown";
import { isMacKeyboard } from "../lib/platform";

/** 皮肤落 class（浅色 token 是 `:root` 默认、深色挂在 `.dark`，见 src/index.css）。
 *  显式选深/浅时不听系统——系统偏好变了也不该动用户手动选的档。 */
function useTheme() {
 const theme = useApp((s) => s.theme);
 useEffect(() => {
  applyTheme(theme);
  if (theme !== "system") return;
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => applyTheme(theme);
  mq.addEventListener("change", apply);
  return () => mq.removeEventListener("change", apply);
 }, [theme]);
}

/** 界面语言：`system` 档跟随系统语言（与皮肤同模式）——WebView 的系统 UI 语言变了就重新解析一次。
 *  实际语言与 `<html lang>` 的落点在 `stores/app.ts` 的 `setLocaleMode`。 */
function useLocale() {
 const localeMode = useApp((s) => s.localeMode);
 const setLocaleMode = useApp((s) => s.setLocaleMode);
 useEffect(() => {
  if (localeMode !== "system") return;
  const apply = () => setLocaleMode("system");
  window.addEventListener("languagechange", apply);
  return () => window.removeEventListener("languagechange", apply);
 }, [localeMode, setLocaleMode]);
}

/**
 * 会话标题语言（V18）：界面语言落定（含启动）后，把语言同步给 omp 的自动标题 prompt
 * （`<agentDir>/TITLE_SYSTEM.md`，见 `lib/titlePrompt.ts`）——omp 只在**会话启动**时读它，
 * 所以切语言对**新开的会话**生效，已开的会话保持原语言（上游口径，壳侧不代偿）。
 * 等健康检查把 agentDir 解析出来再写：非默认 profile / `PI_CONFIG_DIR` 下两者路径不同。
 */
function useTitlePromptSync() {
 const locale = useApp((s) => s.locale);
 const agentDir = useApp((s) => s.health?.omp.agentDir);
 useEffect(() => {
  if (!agentDir) return;
  void syncTitlePromptLanguage(locale);
 }, [agentDir, locale]);
}

/**
 * 上次选中的会话（2026-10-19 用户口径）：关闭 app 时正在看的那个对话，下次打开接着看。
 *
 * - **记录**：选中会话变化、或它在 `store.sessions` 里的行变化（改名 / 归属迁移）时写
 *   localStorage（`lib/lastSession.ts`；内容没变不写）。记的是**上一次运行的快照**，
 *   只当 hint 用，真值以 `open_session` 为准。
 * - **恢复**：冷启动（本次运行还没有选中会话）读记录，交给唯一的打开实现——hint 用记录里
 *   的字段（恢复期间标题 / 项目 / cwd 立刻是对的），`trustView` 让 open 的真值整行收敛
 *   （记录里的标题可能已被外部改过）。左栏另读同一份记录，把它所在的工作区 / 项目展开
 *   （其余分组在 app 打开时是收着的，见 `ChatSidebar`）。
 * - **打不开**（会话被删 / omp 不可用）：回到空态，不把死会话选在那儿；记录留着，
 *   下次环境好了照样能恢复。
 */
function useLastSessionRestore() {
 const activeSessionId = useApp((s) => s.activeSessionId);
 const sessions = useApp((s) => s.sessions);

 useEffect(() => {
  if (!activeSessionId) return;
  const row = sessions.find((s) => s.id === activeSessionId);
  saveLastSession({
   id: activeSessionId,
   projectId: row?.projectId ?? null,
   title: row?.title ?? "",
   cwd: row?.cwd ?? "",
  });
 }, [activeSessionId, sessions]);

 useEffect(() => {
  const last = loadLastSession();
  if (!last || useApp.getState().activeSessionId) return;
  void openSessionWithHistory(
   last.id,
   { id: last.id, projectId: last.projectId, title: last.title, cwd: last.cwd },
   { trustView: true },
  ).then((res) => {
   if (!res.ok && useApp.getState().activeSessionId === res.id) {
    useApp.getState().set({ activeSessionId: null });
   }
  });
 }, []);
}

/**
 * 工作区 git 快照的刷新时机——启动 / 工作区清单变化 / 窗口转可见或重新获得焦点 /
 * **可见时 30s 兜底轮询**。`refreshWorkspaceGitState` 同时让 `get_git_info` 的挂载实例
 * （输入卡顶行 / 右栏「变更」）一起重读，行徽章与 git 提示不会各走各的。
 * 任务结束后的单点刷新在 `lib/commitTasks.ts` 里；点按钮时的**后端预检**才是最终裁决。
 */
function useWorkspaceGitRefresh() {
 const checkouts = useApp((s) => s.checkouts);

 useEffect(() => {
  void refreshWorkspaceGitState(checkouts.map((w) => w.path));
 }, [checkouts]);

 useEffect(() => {
  // 转可见与重新获得焦点（点回本应用）都刷一轮：徽章是「现在有没有东西要处理」的提示
  const onVisible = () => {
   if (!document.hidden) void refreshWorkspaceGitState();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
  return () => {
   document.removeEventListener("visibilitychange", onVisible);
   window.removeEventListener("focus", onVisible);
  };
 }, []);

 // 兜底轮询：会话里的 git 活动（agent 或手敲）不改变任何前端状态，等不到「转就绪」那个时机
 useEffect(() => startWorkspaceGitPolling(), []);
}

/**
 * 外部项目改名同步（2026-10-27 用户口径）。
 *
 * 项目名来自覆盖层路径的末段目录名，外部（Finder / 终端 / 其他应用）改名后旧路径失效，
 * 只靠左栏挂载那一次冷启动永远看不到新名字。后端按目录身份链找回路径（`reconcile_projects`），
 * 这里负责把「什么时候对账」定下来：
 *
 * - 窗口重新获得焦点 / 从后台转回可见：立即重拉项目 + 目录行 + 工作区清单（外部改动没有事件）；
 * - 可见时每 10s 兜底对账一次：只 stat 路径，失联才扫描身份链；发现路径变化再重拉。
 *   这样在应用内终端改名、或后台脚本改名也能在 10s 内反映出来；
 * - 重拉做 1.5s 去抖，避免 alt-tab 连击放大 `git worktree list` 的开销；对账发现变化时
 *   强制重拉（不能被刚发生过的 focus 刷新吞掉，否则这次变化要等到下一次改名才会显示）。
 */
function useExternalProjectSync() {
 useEffect(() => {
  let inFlight = false;
  let pending = false;
  let last = 0;
  const pull = (force = false) => {
   if (document.hidden) return;
   if (inFlight) {
    if (force) pending = true;
    return;
   }
   const now = Date.now();
   if (!force && now - last < 1500) return;
   last = now;
   inFlight = true;
   void refreshSidebar()
    .catch(() => undefined)
    .finally(() => {
     inFlight = false;
     if (pending) {
      pending = false;
      pull(true);
     }
    });
  };
  const onVisible = () => pull();
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
  const timer = window.setInterval(() => {
   if (document.hidden) return;
   void api
    .reconcileProjects()
    .then((changed) => {
     if (changed) pull(true);
    })
    .catch(() => undefined);
  }, 10_000);
  return () => {
   document.removeEventListener("visibilitychange", onVisible);
   window.removeEventListener("focus", onVisible);
   window.clearInterval(timer);
  };
 }, []);
}

/**
 * 全局快捷键（v2；非 mac 平台用 Ctrl）：⌘, 打开设置 / ⌘T 新建聊天 / ⌘W 关设置 /
 * ⌘F 会话内查找（设置视图内 = 聚焦设置搜索）/ ⌘⇧G 右栏工作台 /
 * ⌘[ ⌘] 会话导航 / ⌘⇧P 引用工作区文件。
 */
function useHotkeys() {
 useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
   if (e.defaultPrevented || e.isComposing || e.altKey) return;
   const mod = isMacKeyboard() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
   if (!mod) return;
   const key = e.key.toLowerCase();
   const s = useApp.getState();
   // ⌘F / ⌘[ / ⌘]（会话内动作）、⌘⇧P（引用浮层）与 ⌘,（打开设置）即使焦点在输入框里也要生效——
   // 聊天常态就是在 Composer 里打字，被 typing 守卫吞掉等于入口断掉；
   // 其余组合键（⌘T / ⌘W）输入中只阻断不执行。
   const chatKey = key === "f" || key === "[" || key === "]" || key === "k" || (key === "g" && e.shiftKey);
   const refPick = key === "p" && e.shiftKey;
   const openSettings = key === ",";
   const owned = chatKey || refPick || openSettings || key === "t" || key === "w";
   if (!owned) return;
   const el = document.activeElement;
   const typing = el instanceof HTMLElement && !!el.closest("input, textarea, select, [contenteditable='true']");
   // 识别到本应用组合键就先截获，避免浏览器默认行为；模态或输入中只阻断不执行。
   e.preventDefault();
   e.stopPropagation();
   if (e.repeat || hasOpenDialog() || (typing && !refPick && !chatKey && !openSettings)) return;
   if (openSettings) {
    // ⌘, 打开设置（Codex 口径；已打开则只切过去——与系统惯例一致，不做 toggle）
    if (!s.settingsTabActive) s.openSettingsTab();
    return;
   }
   if (key === "w") {
    // ⌘W 只关设置视图（v1 收敛口径；输入中由上面的 typing 守卫挡住）
    if (s.settingsTabActive) s.closeSettingsTab();
    return;
   }
   if (key === "t") {
    // 新建会话（v2）：目标 = 当前会话所在目录，没有当前会话时用第一个可用项目主目录；
    // 失败进左栏内联错误条（与左栏同名入口共用一处），不再「点了没反应」
    void newChatInDefaultCheckout().then((r) => useApp.getState().setNewChatError(r.ok ? null : r.message));
    return;
   }
   if (refPick) {
    // 引用工作区文件（V22；注入 Composer 草稿）：设置视图激活 / 没有会话时不触发。
    // 项目没进工作区（或工作区没有其他成员）时引用范围为空——与 `+` / `/` 面板、`@` 入口同口径，不打开。
    if (s.settingsTabActive || !s.activeSessionId) return;
    const cwd = s.sessions.find((x) => x.id === s.activeSessionId)?.cwd ?? "";
    if (!cwd || !hasWorkspaceRefs(cwd, s.workspaceGroups, s.checkouts, s.projects)) return;
    s.set({ refPickerTarget: { sessionId: s.activeSessionId } });
    return;
   }
   // 设置视图内（v3）：⌘F = 展开并聚焦设置搜索；⌘[ / ⌘] 等会话内动作不抢这几个键
   if (s.settingsTabActive) {
    if (key === "f") s.set({ settingsSearchOpen: true });
    return;
   }
   if (key === "f") {
    // 会话内查找：没有会话时无处可查，不打开横条
    if (s.activeSessionId) s.setFindOpen(true);
   } else if (key === "g" && e.shiftKey) {
    // 右栏工作台开关（⌘⇧G）：面板始终停靠为第三栏，切换只影响这一栏在不在
    s.setWorkbenchOpen(!s.workbenchOpen);
   } else {
    // 会话导航栈：空栈 / 到头由 `navStep` 返回 null（此时什么都不做）
    const id = s.navStep(key === "[" ? -1 : 1);
    if (id) void openSessionWithHistory(id);
   }
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
 }, []);
}

/** 左侧栏外壳：桌面端可左右拖拽调宽（292–480px，持久化）；窄窗（<768px）收起为抽屉。 */
function SidebarShell({
 width,
 onResize,
 children,
}: {
 width: number;
 onResize: (w: number) => void;
 children: React.ReactNode;
}) {
 const dragging = useRef(false);
 const t = useText();
 const { sidebarOpen, set } = useApp();
 const shellRef = useRef<HTMLDivElement>(null);
 // hover 才加宽热区：平时 3px 隐身细条，悬停/拖拽时 6px 好抓
 const [hot, setHot] = useState(false);
 // 拖拽中的视觉态用 state 表达（render 里不许读 ref），ref 只在事件/effect 里做快速判断
 const [draggingUi, setDraggingUi] = useState(false);
 const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);

 useEffect(() => {
  const move = (e: PointerEvent) => {
   if (!dragging.current) return;
   const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(e.clientX)));
   onResize(clamped);
  };
  const up = () => {
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
 }, [onResize]);

 useEffect(() => {
  const query = window.matchMedia("(max-width: 767px)");
  const onChange = () => {
   setNarrow(query.matches);
   if (!query.matches) set({ sidebarOpen: false });
  };
  onChange();
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
 }, [set]);

 useDialogFocus(shellRef, narrow && sidebarOpen, () => set({ sidebarOpen: false }));
 const closeDrawer = () => set({ sidebarOpen: false });

 return (
  <>
   {/* 同一份侧栏子树：桌面用宽度容器，窄窗定位态态态组件重现挂载。 */}
   <div
    ref={shellRef}
    role={narrow && sidebarOpen ? "dialog" : undefined}
    aria-modal={narrow && sidebarOpen ? true : undefined}
    aria-label={narrow && sidebarOpen ? t.workspaceTitle : undefined}
    tabIndex={narrow && sidebarOpen ? -1 : undefined}
    className={narrow
     ? sidebarOpen
      ? "fixed inset-0 z-20 md:hidden"
      : "hidden"
     : "relative hidden shrink-0 md:block"}
    style={narrow ? undefined : { width }}
   >
    {narrow && sidebarOpen && (
     <div className="absolute inset-0 bg-black/40" onClick={closeDrawer} aria-hidden />
    )}
    <div className={narrow
     ? "absolute top-0 left-0 h-full w-[min(292px,calc(100vw-24px))] overflow-hidden rounded-r-lg bg-sidebar shadow-dialog"
     : "h-full w-full"}>
     {children}
    </div>
    {!narrow && (
     <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t.resizeSidebar}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onKeyDown={(e) => {
       if (e.key === "ArrowLeft") onResize(width - 8);
       if (e.key === "ArrowRight") onResize(width + 8);
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
      className={`absolute top-0 right-0 z-10 h-full cursor-col-resize touch-none transition-colors focus-visible:outline-none ${hot || draggingUi ? "w-1.5 bg-accent/45" : "w-[3px] bg-transparent"
       }`}
     />
    )}
   </div>
  </>
 );
}
export function App() {
 const { settingsTabOpen, settingsTabActive, set, sidebarWidth, setSidebarWidth, updateDialogOpen, ompUpdateDialogOpen, ompInstallDialogOpen, sidebarOpen, providerUsageOpen, refPickerTarget } = useApp();
 const t = useText();
 useTheme();
 useLocale();
 useHotkeys();
 useWorkspaceGitRefresh();
 useExternalProjectSync();
 useTitlePromptSync();
 useLastSessionRestore();

 useEffect(() => {
  // 启动静默检查应用更新：检查中转轮、结论落 chip（已最新绿点 / 有新版本 accent / 失败 warn）；
  // 有新版本才弹窗（本轮已「稍后」过则只留 chip 状态），不打断
  void autoCheckOnBoot();
 }, []);

 useEffect(() => {
  // 启动就水合执行模式真值（覆盖层的本会话覆盖 + omp 全局默认档）：输入卡上的档位显示读它。
  // 读不到就停在「未知」——**不许拿某一档兜底**（兜底 = 显示与 omp 实际生效的不一致）。
  void loadApprovalState();
 }, []);

 useEffect(() => {
  // 启动就读 omp 的默认思考档（`defaultThinkingLevel`）：思考档选择器的默认显示与兜底档读它
  // （见 `lib/thinkingDefault.ts`）。读不到退回最高档兜底，打开思考档菜单时自然重试。
  void ensureOmpDefaultThinking();
 }, []);

 useEffect(() => {
  // 启动就把模型目录拉进 store（后台、静默、失败无所谓）：设置页模型页签用它。
  // 后端把拉取收敛成单飞 + 缓存（`omp models --json` 实测 2–10s），这里不阻塞任何界面。
  api
   .getModels()
   .then((models) => set({ models }))
   .catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
 }, []);

 useEffect(() => {
  // 目录快照刷新完成（冷启动真拉 / 过期后台刷新 / 手动刷新）：后端广播整份快照，
  // 这里直接换掉 store——设置页（模型 / 供应商）据此原地更新，不必自己轮询重拉。
  let active = true;
  const un = listen<ModelCatalog>(IPC.modelsRefreshed, (e) => {
   if (active) set({ models: e.payload });
  });
  return () => {
   active = false;
   void un.then((dispose) => dispose()).catch(() => undefined);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
 }, []);

 useEffect(() => {
  api
   .getHealth()
   .then((health) => {
    set({ health });
    // omp 在就顺手静默查一次它的新版本（单飞 + 5 分钟冷却在 lib 里；失败只落状态不打扰）
    if (health.omp.ompPath) void autoCheckOmpUpdate();
   })
   .catch(() =>
    set({
     health: {
      omp: { ompPath: null, ompVersion: null, agentDir: "", errors: [t.healthCheckFailed] },
      modelsError: t.healthCheckFailed,
      ok: false,
     },
    }),
   );
  // 项目与工作区由侧栏统一拉取；App 只负责健康与模型，避免重复请求覆盖侧栏错误态。
  // eslint-disable-next-line react-hooks/exhaustive-deps
 }, []);

 return (
  <div className="flex h-screen overflow-hidden bg-sidebar text-sm text-foreground">
   <SidebarShell
    width={sidebarWidth}
    onResize={(w) => {
     if (w !== sidebarWidth) setSidebarWidth(w);
    }}
   >
    {/* 左栏 = 聊天侧栏（v1 起唯一形态；工作区标题行 + 搜索 + 按工作区分段 + 拖拽排序） */}
    <ChatSidebar />
   </SidebarShell>
   <main inert={sidebarOpen ? true : undefined} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background md:my-2 md:mr-2 md:rounded-xl md:border md:border-border">
    <HealthBanner />
    {/* 聊天主区**常驻挂载、只切显隐**：切去设置视图只是 CSS 隐藏——
        卸载会断事件订阅（切走期间到达的帧就丢了），切回来还要重建滚动位置。
        设置视图激活时这个兄弟列也要一起收起：它自带 flex-1，留着会跟设置视图平分
        main 的高度（顶部凭空多出半屏空白）。 */}
    <div className={settingsTabActive ? "hidden" : "flex min-h-0 min-w-0 flex-1"}>
     <ChatView visible={!settingsTabActive} />
     {/* 右栏工作台（V42 三栏：文件 / 终端）：**常驻挂载**——收起或切设置视图只改显隐，
         终端进程与 xterm 回看缓冲不因为收起右栏而丢；打开即停靠为第三栏（不遮盖会话） */}
     <WorkbenchPanel />
    </div>
    {settingsTabOpen && <SettingsPage visible={settingsTabActive} />}
   </main>
   <CommitTaskPanel />
   {/* 拉取冲突清单（挂着就显示：`pullConflictCwd` 为 null 时组件自己返回 null） */}
   <PullConflictDialog />
   {updateDialogOpen && <UpdateDialog />}
   {ompUpdateDialogOpen && <OmpUpdateDialog />}
 {ompInstallDialogOpen && <OmpInstallDialog />}
   {providerUsageOpen && <ProviderUsageDialog />}
   {refPickerTarget && <ReferencePicker />}
  </div>
 );
}
