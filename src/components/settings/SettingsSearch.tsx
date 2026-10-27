import { Search, X } from "reicon-react";
import { useEffect, useMemo, useRef } from "react";
import { isMacKeyboard } from "../../lib/platform";
import { searchSettings, type SettingsSearchSources } from "../../lib/settingsSearch";
import { SETTINGS_TAB_LABEL_KEYS, type SettingsTab } from "../../lib/settingsTabs";
import { useApp } from "../../stores/app";
import { useText } from "../../lib/useText";
import { Highlight } from "./Highlight";

/**
 * 设置视图 › 顶部搜索（v3）：跨条目过滤已加载的数据（常用设置四档打分 / omp 约束 /
 * 模型 / 插件 / 技能 / 记忆 / 归档会话），命中文本高亮，点结果跳到对应条目——常用设置项
 * 还带键名定位（`onNavigate` 的第二参数，通用页收到后滚动到那一行并闪烁；约束文件收到后
 * 选中对应文件）。
 *
 * 交互：挂载即聚焦输入框；Esc 先清空、再按一次关闭；关闭走 `onClose`（复位 store 状态）。
 * 数据源状态由 `SettingsPage` 用 `useSettingsSearchSources` 持有（搜索关掉重开不重拉）。
 */
export function SettingsSearch({
 query,
 onQueryChange,
 onClose,
 onNavigate,
 sources,
 settled,
 allFailed,
}: {
 query: string;
 onQueryChange: (next: string) => void;
 onClose: () => void;
 onNavigate: (tab: SettingsTab, focusKey?: string) => void;
 sources: SettingsSearchSources;
 settled: boolean;
 /** 全部数据源读取失败（omp 未就绪一类）：显示读取失败，不糊成「没有匹配」。 */
 allFailed: boolean;
}) {
 const t = useText();
 const locale = useApp((s) => s.locale);
 const inputRef = useRef<HTMLInputElement>(null);

 useEffect(() => {
  inputRef.current?.focus();
 }, []);

 // 搜索已展开时再按 ⌘F：把焦点拉回输入框（store 里 settingsSearchOpen 已是 true，
 // 全局热键那一侧不会产生状态变化，聚焦得由这里补上）。
 useEffect(() => {
  const onKey = (event: KeyboardEvent) => {
   if (event.isComposing || event.altKey) return;
   const mod = isMacKeyboard() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
   if (mod && event.key.toLowerCase() === "f") inputRef.current?.focus();
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
 }, []);

 const q = query.trim();
 const groups = useMemo(() => searchSettings(sources, q, t, locale), [sources, q, t, locale]);
 const total = groups.reduce((sum, group) => sum + group.hits.length, 0);

 return (
  <div className="settings-panel flex flex-col gap-4">
   {/* 输入行：单行、常驻在内容区顶部（⌘F 是打开它的唯一入口——顶部条已无搜索钮） */}
   <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 transition-colors duration-100 focus-within:border-accent">
    <Search size={14} aria-hidden className="shrink-0 text-muted" />
    <input
     ref={inputRef}
     id="settings-search-input"
     value={query}
     onChange={(event) => onQueryChange(event.target.value)}
     onKeyDown={(event) => {
      if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (query) onQueryChange("");
      else onClose();
     }}
     placeholder={t.settingsSearchHint}
     aria-label={t.settingsSearch}
     className="h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
    />
    <button
     onClick={onClose}
     aria-label={t.settingsSearchClose}
     title={t.settingsSearchClose}
     className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
    >
     <X size={13} aria-hidden />
    </button>
   </div>

   {q === "" ? (
    <p className="text-xs text-muted">{t.settingsSearchIdle}</p>
   ) : allFailed ? (
    <p role="alert" className="text-[13px] leading-5 text-danger">{t.settingsSearchFailed}</p>
   ) : total === 0 ? (
    <div className="flex flex-col items-start gap-2">
     <p className="text-[13px] text-muted">{settled ? t.ompSettingsNoMatch : t.settingsSearchPending}</p>
     {settled && (
      <button
       onClick={() => onQueryChange("")}
       className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[13px] transition-colors duration-100 hover:bg-hover"
      >
       {t.clearSearch}
      </button>
     )}
    </div>
   ) : (
    <div className="flex flex-col gap-5">
     {groups.map((group) => {
      const label = t[SETTINGS_TAB_LABEL_KEYS[group.tab]];
      return (
       <section key={group.tab} aria-label={label}>
        <h3 className="text-xs font-medium text-muted">{label}</h3>
        <div className="mt-1 flex flex-col">
         {group.hits.map((hit) => (
          <button
           key={hit.id}
           onClick={() => onNavigate(hit.tab, hit.focusKey ?? undefined)}
           className="flex w-full cursor-pointer flex-col justify-center gap-0.5 rounded-md py-1.5 text-left transition-colors duration-100 hover:bg-hover"
          >
           <span className="truncate text-[13px] leading-5">
            <Highlight text={hit.title} query={q} />
           </span>
           {hit.sub && (
            <span className="truncate text-[11px] leading-4 text-faint">
             <Highlight text={hit.sub} query={q} />
            </span>
           )}
          </button>
         ))}
        </div>
       </section>
      );
     })}
     {!settled && <p className="px-1 text-xs text-faint">{t.settingsSearchPending}</p>}
    </div>
   )}
  </div>
 );
}
