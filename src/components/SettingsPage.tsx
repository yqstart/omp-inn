import { Archive, ArrowLeft, BookOpen, ChartBar, HardDrive, Key, Lock, Notebook, Plug, Puzzle, Sliders, Mobile } from "reicon-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useText } from "../lib/useText";
import { useApp } from "../stores/app";
import type { Text } from "../lib/locale";
import { clearSettingsSearchCache } from "../lib/settingsSearch";
import { SETTINGS_TAB_LABEL_KEYS, type SettingsFocusRequest, type SettingsTab } from "../lib/settingsTabs";
import { useSettingsSearchSources } from "../lib/useSettingsSearchSources";
import { ArchivedSessions } from "./ArchivedSessions";
import { ConstraintsPanel } from "./settings/ConstraintsPanel";
import { RemotePanel } from "./settings/RemotePanel";
import { SystemPermissionsPanel } from "./settings/SystemPermissionsPanel";
import { StoragePanel } from "./settings/StoragePanel";
import { GeneralSettingsPanel } from "./settings/GeneralSettingsPanel";
import { MemoryPanel } from "./settings/MemoryPanel";
import { PluginsPanel } from "./settings/PluginsPanel";
import { SkillsPanel } from "./settings/SkillsPanel";
import { ModelsPanel } from "./settings/ModelsPanel";
import { UsagePanel } from "./settings/UsagePanel";
import { SettingsSearch } from "./settings/SettingsSearch";

const TAB_ICONS = {
 general: Sliders,
 constraints: BookOpen,
 system: Lock,
 remote: Mobile,
 models: Key,
 plugins: Plug,
 skills: Puzzle,
 memories: Notebook,
 usage: ChartBar,
 archived: Archive,
 storage: HardDrive,
} satisfies Record<SettingsTab, unknown>;

/**
 * 导航四组（v3 设置重构的信息架构）：**通用 / 模型 / 扩展 / 数据**——
 * 上两组读写 omp 的配置与目录（常用设置 = `config.yml` 的唯一设置面；omp 约束 = 全局
 * AGENTS.md / RULES.md / rules/*.md 的唯一编辑面；模型 = omp 模型相关的唯一管理面），
 * 扩展组管插件与技能，数据组管 omp 项目记忆与本应用自己的会话数据
 * （使用统计 / 已归档对话）。
 */
const TAB_GROUPS: { label: keyof Text; tabs: SettingsTab[] }[] = [
 { label: "settingsGroupGeneral", tabs: ["general", "constraints", "system", "remote"] },
 { label: "settingsGroupModel", tabs: ["models"] },
 { label: "settingsGroupExt", tabs: ["plugins", "skills"] },
 { label: "settingsGroupData", tabs: ["memories", "usage", "archived", "storage"] },
];

/**
 * 设置视图（v3 设置重构）：覆盖主区的独立视图，不再是「标签页 + 卡片列表」的形态——
 *
 * - **顶部条**：`← 返回聊天` + 当前条目名（**没有搜索钮**，2026-10-19 用户口径）——
 *   打开设置 = 左栏底部「设置」/ ⌘,，关闭 = 顶部「返回聊天」/ ⌘W / 左栏「设置」再点一次
 *   （`closeSettingsTab`）；
 * - **左导航**：四组十条目（组标题 + 条目；通用组含「系统授权」「远程控制」），窄窗（44px 容器档）折叠为图标栏；
 * - **顶部搜索**：入口只剩 ⌘F（跨条目过滤——常用设置四档打分 / omp 约束 / 模型 / 插件 /
 *   技能 / 记忆 / 归档会话），命中高亮，结果点击跳到对应条目——常用设置项与约束文件带键名
 *   定位（`focusRequest`）；
 * - 内容区是唯一的滚动容器：各面板直接铺在页面上（区块标题 + 行式排布，不做嵌套卡片）。
 */
export function SettingsPage({ visible = true }: { visible?: boolean }) {
 const t = useText();
 const set = useApp((s) => s.set);
 const searchOpen = useApp((s) => s.settingsSearchOpen);
 const [tab, setTab] = useState<SettingsTab>("general");
 const [searchQuery, setSearchQuery] = useState("");
 const [focusRequest, setFocusRequest] = useState<SettingsFocusRequest | null>(null);
 const pageRef = useRef<HTMLDivElement>(null);
 const panelRef = useRef<HTMLDivElement>(null);
 const lastFocusRef = useRef<HTMLElement | null>(null);
 /** 定位请求的自增序号（同一键连点两次也要重新定位闪烁）。 */
 const focusSeq = useRef(0);
 /** 搜索数据源：首次展开时并行懒加载；搜索关掉再开不重拉（模块级缓存，见 lib/settingsSearch）。 */
 const { sources, settled, allFailed } = useSettingsSearchSources(searchOpen);

 // 关闭设置视图即卸载：搜索缓存整体作废（下次进入设置重新取——搜索定位的清单不该跨次陈旧）
 useEffect(() => () => clearSettingsSearchCache(), []);

 // 切条目 / 开搜索都回到顶部（沿用旧口径：设置页有两个滚动上下文，重置只认内容区）
 useEffect(() => {
  panelRef.current?.scrollTo({ top: 0 });
 }, [tab, searchOpen]);

 useEffect(() => {
  const page = pageRef.current;
  if (!page) return;
  const active = document.activeElement;
  if (!visible) {
   if (active instanceof HTMLElement && page.contains(active)) active.blur();
   return;
  }
  if (page.contains(active) || active?.closest('[role="dialog"][aria-modal="true"]')) return;
  const previous = lastFocusRef.current;
  const target =
   previous?.isConnected && !previous.matches(":disabled")
    ? previous
    : page.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]') ??
    page.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  target?.focus({ preventScroll: true });
 }, [visible]);

 /** 搜索结果导航：切条目（可选带定位请求）、收搜索、回顶部。 */
 const navigateTo = useCallback(
  (next: SettingsTab, focusKey?: string) => {
   setTab(next);
   if (focusKey) {
    focusSeq.current += 1;
    setFocusRequest({ key: focusKey, seq: focusSeq.current });
   }
   set({ settingsSearchOpen: false });
   panelRef.current?.scrollTo({ top: 0 });
  },
  [set],
 );

 /** 定位请求消费完成的回调（引用要稳定：通用页 / 约束页的定位 effect 依赖它）。 */
 const clearFocusRequest = useCallback(() => setFocusRequest(null), []);

 const closeSearch = () => set({ settingsSearchOpen: false });

 const title = searchOpen ? t.settingsSearch : t[SETTINGS_TAB_LABEL_KEYS[tab]];

 return (
  <div
   ref={pageRef}
   inert={!visible}
   aria-hidden={!visible}
   onFocusCapture={(event) => {
    if (event.target instanceof HTMLElement) lastFocusRef.current = event.target;
   }}
   className={
    visible
     ? "@container/settings flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden"
     : "hidden"
   }
  >
   {/* 顶部条：返回 + 当前条目名（搜索展开时标题切为「搜索设置」；搜索入口只剩 ⌘F） */}
   <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border-soft pl-1.5 pr-3 sm:pl-2.5 sm:pr-5">
    <button
     onClick={() => useApp.getState().closeSettingsTab()}
     aria-label={t.backToChat}
     title={t.backToChat}
     className="flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
    >
     <ArrowLeft size={15} aria-hidden className="shrink-0" />
     <span className="hidden @min-[560px]/settings:inline">{t.backToChat}</span>
    </button>
    <h1 className="min-w-0 flex-1 truncate px-1.5 text-sm font-medium">{title}</h1>
   </header>

   <div className="flex min-h-0 min-w-0 flex-1">
    {/* 左导航：四组十条目；窄窗（44px 容器档）折叠为图标栏（组标题收进 sr-only） */}
    <nav
     aria-label={t.title}
     className="flex w-11 shrink-0 flex-col border-r border-border-soft px-1.5 py-2 @min-[640px]/settings:w-[var(--w-settings-nav)] @min-[640px]/settings:px-2"
     onKeyDown={(event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
      const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
      const index = tabs.indexOf(event.target as HTMLButtonElement);
      if (index < 0) return;
      const next =
       event.key === "Home"
        ? 0
        : event.key === "End"
         ? tabs.length - 1
         : event.key === "ArrowDown"
          ? (index + 1) % tabs.length
          : event.key === "ArrowUp"
           ? (index - 1 + tabs.length) % tabs.length
           : null;
      if (next === null) return;
      event.preventDefault();
      tabs[next].focus();
      tabs[next].click();
     }}
    >
     <div className="flex flex-col gap-4">
      {TAB_GROUPS.map(({ label: groupKey, tabs }) => (
       <div key={groupKey} role="tablist" aria-orientation="vertical" aria-label={t[groupKey]} className="flex flex-col gap-0.5">
        {/* 组标题：窄导航（44px）放不下文字，收进 sr-only（分组语义仍由 aria 保留） */}
        <p className="sr-only text-[11px] font-medium text-faint @min-[640px]/settings:not-sr-only @min-[640px]/settings:px-2 @min-[640px]/settings:pb-1">
         {t[groupKey]}
        </p>
        {tabs.map((key) => {
         const Icon = TAB_ICONS[key];
         const label = t[SETTINGS_TAB_LABEL_KEYS[key]];
         return (
          <button
           key={key}
           id={`settings-tab-${key}`}
           role="tab"
           tabIndex={tab === key ? 0 : -1}
           aria-selected={tab === key}
           aria-controls="settings-panel"
           title={label}
           onClick={() => {
            setTab(key);
            set({ settingsSearchOpen: false });
           }}
           className={`flex min-h-9 cursor-pointer items-center justify-center gap-2.5 rounded-md text-left text-[13px] transition-colors duration-100 @min-[640px]/settings:min-h-8 @min-[640px]/settings:justify-start @min-[640px]/settings:px-2.5 ${tab === key
            ? "bg-active font-semibold text-accent"
            : "text-muted hover:bg-hover hover:text-foreground"
            }`}
          >
           <Icon size={15} className="shrink-0" aria-hidden />
           <span className="sr-only @min-[640px]/settings:not-sr-only">{label}</span>
          </button>
         );
        })}
       </div>
      ))}
     </div>
    </nav>

    {/* 内容区是唯一的滚动容器：顶部条与导航固定，滚动只发生在这一列 */}
    <div
     ref={panelRef}
     id="settings-panel"
     role="tabpanel"
     tabIndex={0}
     aria-labelledby={searchOpen ? undefined : `settings-tab-${tab}`}
     aria-label={searchOpen ? t.settingsSearch : undefined}
     className="@container/panel min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
    >
     {/* 页面留白只此一处：左右 `px-3/6`、顶部 `pt-6`、底部 `pb-12`——各面板（`.settings-panel`）
         不许再给首块加上外边距（`index.css` 那条规则兜底），否则各条目首屏间距又会各写各的。 */}
     <div className="mx-auto w-full max-w-4xl px-3 pb-12 pt-6 sm:px-6">
      {/* 面板与搜索并列挂载（搜索只是遮住面板）：切搜索不触发面板卸载重挂 ——
          通用页的目录（`omp config list`，秒级）不该因开了次搜索又拉一遍。 */}
      <div className={searchOpen ? "hidden" : undefined}>
       {tab === "archived" ? (
        <ArchivedSessions />
       ) : tab === "constraints" ? (
        <ConstraintsPanel focusRequest={focusRequest} onFocusDone={clearFocusRequest} />
       ) : tab === "system" ? (
        <SystemPermissionsPanel />
       ) : tab === "remote" ? (
        <RemotePanel />
       ) : tab === "models" ? (
        <ModelsPanel />
       ) : tab === "plugins" ? (
        <PluginsPanel />
       ) : tab === "skills" ? (
        <SkillsPanel />
       ) : tab === "memories" ? (
        <MemoryPanel />
       ) : tab === "usage" ? (
        <UsagePanel />
       ) : tab === "storage" ? (
        <StoragePanel />
       ) : (
        <GeneralSettingsPanel focusRequest={focusRequest} onFocusDone={clearFocusRequest} />
       )}
      </div>
      {searchOpen && (
       <SettingsSearch
        query={searchQuery}
        onQueryChange={setSearchQuery}
        onClose={closeSearch}
        onNavigate={navigateTo}
        sources={sources}
        settled={settled}
        allFailed={allFailed}
       />
      )}
     </div>
    </div>
   </div>
  </div>
 );
}
