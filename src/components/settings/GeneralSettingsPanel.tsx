import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader, Undo } from "reicon-react";
import { api } from "@shared/api";
import type { OmpCatalogItem, OmpSetting, OmpSettingsCatalog } from "@shared/types";
import { useApp } from "../../stores/app";
import { useText } from "../../lib/useText";
import { OMP_SETTING_NAMES } from "../../lib/ompSettingNames";
import { fmt } from "../../lib/locale";
import { useVisibleRefresh } from "../../lib/useVisibleRefresh";
import type { SettingsFocusRequest } from "../../lib/settingsTabs";
import { EnumSelect } from "./EnumSelect";
import { Switch } from "./Switch";
import {
 SECTION_LABEL_KEYS,
 SETTING_KIND_KEYS,
 choiceOptions,
 groupCatalog,
 jsonDraftFrom,
 jsonPreview,
 parseJsonDraft,
 type JsonDraftError,
 parseNumberDraft,
} from "../../lib/allSettings";
import { SETTINGS_LIST_SET, SETTING_NOTES, SETTING_SECTION_OVERRIDES } from "../../lib/settingsList";

/**
 * 设置 ›「常用设置」：omp 全局配置（`config.yml`）的**唯一设置面**——分组与六种类型的
 * 编辑器（开关 / 枚举 / 数字 / 文本 / 数组 / 记录）。数据来自后端 `get_omp_settings_catalog`
 * （`omp config list` 文本 + JSON 两路合并，见 `src-tauri/src/settings.rs`），再按
 * `lib/settingsList.ts` 的展示清单（80 项：四稿按「桌面壳里有没有可观测差异」筛过）过滤——
 * **不铺上游全量**（519 项里内部 / 细调占大头，要浏览完整清单在终端里 `omp config list`）。
 * 写入走 `set_omp_setting` / `reset_omp_setting`（omp 全局配置、写完回读，与旧「常用设置」
 * 面板同一套命令）。
 *
 * v3（设置重构）：本页自己的搜索框与页头卡片已退场——搜索上移为**设置视图顶部的跨条目搜索**
 * （`SettingsSearch`，四档打分与命中高亮都在那里）；本页只消费它的**定位请求**
 * （`focusRequest`：展开分组 → 滚动到行 → 闪烁），行直接铺在页面背景上（区块标题 + 分隔线，
 * 不做嵌套卡片）。
 *
 * 界面上守住的几条：
 * - **不摆假值**：拿不到读数就显示错误条，不画一个默认态；
 * - **说明文字是上游英文**（`description`，omp 对这条设置的定义）——挂在行的 `title` 上；
 * - 写完**回读**（后端返回的就是真相）；
 * - **未设置**（上游没有显式值）与**脱敏**（令牌类键被上游隐藏）分开表达：后者不提供编辑器
 *   （值读不到，改就等于盲写覆盖），只留「恢复默认」；提示去终端里 `omp config set`
 *   （当前清单里已无脱敏键，此路径为防御性保留）；
 * - **行内标注**（`SETTING_NOTES`）：`仅 TUI 生效`（plan / goal 功能总闸）/ 值为 `-1` 时的
 *   「-1 = 默认」（temperature / compaction.thresholdPercent）；
 * - 分组默认展开（可见性优先，折叠是用户的选择）；
 * - **页头没有说明文字、计数、展开 / 收起与刷新钮**（2026-10-19 用户口径）：分组标题自己
 *   可点开合；外部改动（别的终端改了 config.yml）靠**窗口重新获得焦点 / 转回可见**时的静默回读
 *   补上，切走页签再回来本来就会重挂重读。
 * - 枚举下拉的选项 label 走 `OPTION_LABELS`（普通词翻界面语言、专有名词与档位名原样；多个键共享公共取值键）；
 *   上游没有取值表（或非 enum）的键退化成文本输入框；
 * - array / record 走 JSON 文本编辑（**本地先解析校验**，不合法根本不发请求）——当前清单没有
 *   此类键，此路径是渲染器按上游 schema 类型分派的通用能力。
 */
export function GeneralSettingsPanel({
 focusRequest,
 onFocusDone,
}: {
 /** 搜索结果的定位请求（seq 去重；消费后回调清除，见 lib/settingsTabs）。 */
 focusRequest?: SettingsFocusRequest | null;
 onFocusDone?: () => void;
}) {
 const t = useText();
 const health = useApp((s) => s.health);
 const [catalog, setCatalog] = useState<OmpSettingsCatalog | null>(null);
 /** 首次读取失败（保持 null，不显示伪设置行）。 */
 const [loadError, setLoadError] = useState<string | null>(null);
 /** 刷新失败但有旧数据（保留快照，只提示结果可能过期）。 */
 const [staleError, setStaleError] = useState<string | null>(null);
 /** 写入 / 恢复默认的失败（乐观值已回滚）。 */
 const [err, setErr] = useState<string | null>(null);
 const [refreshing, setRefreshing] = useState(false);
 /** 正在写入 / 恢复默认的键：那一行的控件在落地前不接第二次点击（同键连点会竞态）。 */
 const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set());
 /** 折叠的分组（**默认全部展开**——与常用设置同款：可见性优先，折叠是用户的选择）。 */
 const [closedSections, setClosedSections] = useState<ReadonlySet<string>>(new Set());
 /** 行内输入框的编辑草稿（数字 / 文本；提交前不写 omp）。 */
 const [drafts, setDrafts] = useState<Record<string, string>>({});
 /** 打开中的 JSON 编辑器：key → 草稿文本（只对 array / record）。 */
 const [jsonDrafts, setJsonDrafts] = useState<Record<string, string>>({});
 /** JSON 编辑器的本地校验错误：key → 文案（不发请求）。 */
 const [jsonErrors, setJsonErrors] = useState<Record<string, string>>({});
 /** 根元素（定位请求从这里 `querySelector` 找目标行）。 */
 const rootRef = useRef<HTMLElement>(null);
 /** 闪烁清除定时器 / 已消费的定位请求序号（防父子重渲染重放）。 */
 const flashTimer = useRef<number | null>(null);
 const handledSeq = useRef(0);

 /**
  * 读目录。`keepDrafts` = 后台静默回读（窗口重新获得焦点那条路）：只换读数，**不动用户手头的
  * 行内草稿**——他可能正打到一半切出去看一眼；显式刷新 / 首次挂载才连草稿一起作废（目录换了，
  * 陈旧值不再续命）。
  */
 const load = useCallback(
  (keepDrafts = false) => {
   return api
    .getOmpSettingsCatalog()
    .then((c) => {
     setCatalog(c);
     setLoadError(null);
     setStaleError(null);
     setErr(null);
     // 目录换了（刷新 / omp 升级）：打开中的编辑器与旧草稿一起作废，不给陈旧值续命
     if (!keepDrafts) {
      setJsonDrafts({});
      setJsonErrors({});
      setDrafts({});
     }
    })
    .catch((e: unknown) => {
     const message = e instanceof Error ? e.message : t.ompSettingsLoadFailed;
     setCatalog((prev) => {
      if (!prev) setLoadError(message);
      else setStaleError(message);
      return prev;
     });
    });
  },
  [t.ompSettingsLoadFailed],
 );

 useEffect(() => {
  void load();
 }, [load]);

 /** 手动刷新（按钮点击 = 事件处理函数）。 */
 const refresh = () => {
  setRefreshing(true);
  void load().finally(() => setRefreshing(false));
 };

 const jsonErrorMessage = (error: JsonDraftError) =>
  error.reason === "array"
   ? t.allSettingsJsonNeedArray
   : error.reason === "record"
    ? t.allSettingsJsonNeedRecord
    : fmt(t.allSettingsJsonInvalid, error.message ?? "");

 /** 写入 / 恢复默认的公共段：置忙 → 执行 → 回读合并（失败回滚 + 错误条）。 */
 const withBusy = async (
  key: string,
  fn: () => Promise<OmpSetting>,
  rollback?: OmpCatalogItem,
 ): Promise<boolean> => {
  setBusyKeys((prev) => new Set(prev).add(key));
  try {
   const saved = await fn();
   setCatalog((prev) =>
    prev
     ? {
      ...prev,
      items: prev.items.map((i) =>
       i.key === saved.key
        ? {
         ...i,
         value: saved.value,
         kind: saved.kind || i.kind,
         description: saved.description || i.description,
         // 回读走的是 `config get`（不脱敏）——这一行刚被本界面写过，显示的是真相
         redacted: false,
        }
        : i,
      ),
     }
     : prev,
   );
   setErr(null);
   return true;
  } catch (e) {
   if (rollback) {
    setCatalog((prev) =>
     prev ? { ...prev, items: prev.items.map((i) => (i.key === rollback.key ? rollback : i)) } : prev,
    );
   }
   setErr(e instanceof Error ? e.message : t.ompSettingsSaveFailed);
   return false;
  } finally {
   setBusyKeys((prev) => {
    const next = new Set(prev);
    next.delete(key);
    return next;
   });
  }
 };

 /** 写一个键（先乐观改，开关 / 下拉要立刻有反馈；失败由 `withBusy` 复原）。 */
 const save = (key: string, value: unknown): Promise<boolean> => {
  const prev = catalog?.items.find((i) => i.key === key);
  if (!prev) return Promise.resolve(false);
  setCatalog((p) =>
   p ? { ...p, items: p.items.map((i) => (i.key === key ? { ...i, value } : i)) } : p,
  );
  return withBusy(key, () => api.setOmpSetting(key, value), prev);
 };

 const reset = (key: string) => {
  void withBusy(key, () => api.resetOmpSetting(key));
 };

 const forgetDraft = (key: string) => {
  setDrafts((prev) => {
   const next = { ...prev };
   delete next[key];
   return next;
  });
 };

 /** 行内输入框提交（数字 / 文本）：与当前值一致就不打扰 omp。 */
 const commitDraft = (item: OmpCatalogItem) => {
  const raw = drafts[item.key];
  if (raw === undefined) return;
  forgetDraft(item.key);
  if (item.kind === "number") {
   const n = parseNumberDraft(raw);
   if (n === null || item.value === n) return;
   save(item.key, n);
   return;
  }
  const current = typeof item.value === "string" ? item.value : "";
  if (raw === current || (item.value === null && raw === "")) return;
  save(item.key, raw);
 };

 const openJson = (item: OmpCatalogItem) => {
  setJsonDrafts((prev) => ({ ...prev, [item.key]: jsonDraftFrom(item) }));
  setJsonErrors((prev) => {
   const next = { ...prev };
   delete next[item.key];
   return next;
  });
 };

 const closeJson = (key: string) => {
  setJsonDrafts((prev) => {
   const next = { ...prev };
   delete next[key];
   return next;
  });
 };

 /** JSON 编辑器保存：本地先解析 + 形状校验，过了才发请求；失败留在编辑器里给原因。 */
 const saveJson = (item: OmpCatalogItem) => {
  const text = jsonDrafts[item.key];
  if (text === undefined) return;
  const parsed = parseJsonDraft(text, item.kind);
  if (!parsed.ok) {
   setJsonErrors((prev) => ({ ...prev, [item.key]: jsonErrorMessage(parsed.error) }));
   return;
  }
  void save(item.key, parsed.value).then((ok) => {
   if (ok) closeJson(item.key);
  });
 };

 /** 展示清单过滤 + 分组归位：只保留 `settingsList.ts` 的键；两项按 `SETTING_SECTION_OVERRIDES` 归位。 */
 const picked = useMemo(
  () =>
   catalog
    ? {
     sections: catalog.sections,
     items: catalog.items
      .filter((i) => SETTINGS_LIST_SET[i.key] === true)
      .map((i) => (SETTING_SECTION_OVERRIDES[i.key] ? { ...i, section: SETTING_SECTION_OVERRIDES[i.key] } : i)),
    }
    : null,
  [catalog],
 );
 const groups = useMemo(() => (picked ? groupCatalog(picked) : []), [picked]);
 const total = picked?.items.length ?? 0;

 // 搜索结果定位（v3）：展开所在分组 → 滚动到行 → 一次性闪烁，消费后通知页面清空请求。
 // `handledSeq` 防重放（父子重渲染 / picked 变化都不重复闪）；展开（setState）与定位
 // （DOM 操作）拆成两级宏任务——effect body 里不直接改 React 状态，也等 React 提交完再找行。
 // 闪烁 class 直接操作 DOM（先移除、强制 reflow 再挂上，连点同一行也能重新触发动画）。
 // 目录未就绪时不消费请求，等 `picked` 到齐后 effect 依赖变化重跑。
 useEffect(() => {
  const req = focusRequest;
  if (!req || req.seq === handledSeq.current || !picked) return;
  const item = picked.items.find((i) => i.key === req.key);
  if (!item) {
   onFocusDone?.();
   return;
  }
  handledSeq.current = req.seq;
  const needsOpen = closedSections.has(item.section);
  const section = item.section;
  let focusTimer: number | null = null;
  const openTimer = window.setTimeout(() => {
   if (needsOpen) {
    setClosedSections((prev) => {
     if (!prev.has(section)) return prev;
     const next = new Set(prev);
     next.delete(section);
     return next;
    });
   }
   focusTimer = window.setTimeout(() => {
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-setting="${req.key}"]`);
    if (el) {
     el.classList.remove("setting-flash");
     void el.offsetWidth;
     el.classList.add("setting-flash");
     el.scrollIntoView({ block: "center", behavior: "smooth" });
     if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
     flashTimer.current = window.setTimeout(() => el.classList.remove("setting-flash"), 1700);
    }
    onFocusDone?.();
   }, needsOpen ? 50 : 0);
  }, 0);
  return () => {
   window.clearTimeout(openTimer);
   if (focusTimer !== null) window.clearTimeout(focusTimer);
  };
 }, [focusRequest, picked, closedSections, onFocusDone]);

 // 卸载时清掉闪烁定时器（行元素随卸载消失，定时器没必要再跑）
 useEffect(
  () => () => {
   if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
  },
  [],
 );

 const toggleSection = (section: string) =>
  setClosedSections((prev) => {
   const next = new Set(prev);
   if (next.has(section)) next.delete(section);
   else next.add(section);
   return next;
  });

 const missingOmp = health?.ok === false;

 // 外部改动没有事件可等（别的终端 / 别的应用里改了 config.yml、跑了 omp config set）：
 // 窗口重新获得焦点、从后台转回可见时静默回读一次（`load(true)`：只换读数，**不动**
 // 用户行内打到一半的草稿）。页头的刷新钮已按用户口径退场，这就是它的替代。
 useVisibleRefresh(() => void load(true));

 return (
  <section ref={rootRef} aria-label={t.tabGeneral} className="settings-panel shrink-0">
   {missingOmp && <p className="mt-1 text-[13px] text-warn">{t.ompSettingsMissing}</p>}
   {err && (
    <p role="alert" className="mt-3 rounded border border-danger/40 bg-danger/5 px-3 py-2 text-[13px] text-danger">
     {err}
    </p>
   )}
   {catalog === null ? (
    loadError ? (
     <div className="mt-4 flex flex-col items-start gap-2">
      <p role="alert" className="rounded border border-danger/40 bg-danger/5 px-3 py-2 text-[13px] text-danger">
       {loadError}
      </p>
      <button
       onClick={refresh}
       disabled={refreshing}
       className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[13px] transition-colors duration-100 hover:bg-hover disabled:opacity-50"
      >
       {t.retry}
      </button>
     </div>
    ) : (
     <p role="status" className="mt-4 text-[13px] text-muted">{t.archivedLoading}</p>
    )
   ) : total === 0 ? (
    <p role="status" className="mt-4 text-[13px] text-muted">{t.allSettingsEmpty}</p>
   ) : (
    <>
     {staleError && (
      <p role="alert" className="mt-3 rounded border border-warn/40 bg-warn/5 px-3 py-2 text-[13px] text-warn">
       {t.ompSettingsStale}：{staleError}
      </p>
     )}
     <div className="mt-4 space-y-4">
      {groups.map(({ section, items }) => {
       const labelKey = SECTION_LABEL_KEYS[section];
       const label = section === "" ? t.allSettingsUngrouped : labelKey ? t[labelKey] : section;
       const isOpen = !closedSections.has(section);
       return (
        <div key={section || "__ungrouped"}>
         <button
          onClick={() => toggleSection(section)}
          aria-expanded={isOpen}
          className="flex min-h-8 w-full cursor-pointer items-center gap-1.5 rounded-md text-left transition-colors duration-100 hover:bg-hover"
         >
          {isOpen ? (
           <ChevronDown size={12} aria-hidden className="shrink-0 text-faint" />
          ) : (
           <ChevronRight size={12} aria-hidden className="shrink-0 text-faint" />
          )}
          <span className="text-xs font-medium text-muted">{label}</span>
          <span className="font-mono text-[11px] text-faint">{items.length}</span>
         </button>
         {isOpen && (
          <div className="divide-y divide-border-soft">
           {items.map((item) => (
            <SettingRow
             key={item.key}
             item={item}
             busy={busyKeys.has(item.key)}
             draft={drafts[item.key]}
             jsonText={jsonDrafts[item.key]}
             jsonError={jsonErrors[item.key]}
             onDraft={(v) => setDrafts((prev) => ({ ...prev, [item.key]: v }))}
             onCommit={() => commitDraft(item)}
             onSave={(key, value) => void save(key, value)}
             onReset={reset}
             onOpenJson={openJson}
             onJsonChange={(text) =>
              setJsonDrafts((prev) => ({ ...prev, [item.key]: text }))
             }
             onJsonSave={saveJson}
             onJsonClose={closeJson}
            />
           ))}
          </div>
         )}
        </div>
       );
      })}
     </div>
    </>
   )}
  </section>
 );
}

/** 一行设置：键名 + 类型 / 状态标记 + 控件（开关 / 下拉 / 数字 / 文本 / JSON）+ 恢复默认。 */
function SettingRow({
 item,
 busy,
 draft,
 jsonText,
 jsonError,
 onDraft,
 onCommit,
 onSave,
 onReset,
 onOpenJson,
 onJsonChange,
 onJsonSave,
 onJsonClose,
}: {
 item: OmpCatalogItem;
 busy: boolean;
 draft: string | undefined;
 jsonText: string | undefined;
 jsonError: string | undefined;
 onDraft: (value: string) => void;
 onCommit: () => void;
 onSave: (key: string, value: unknown) => void;
 onReset: (key: string) => void;
 onOpenJson: (item: OmpCatalogItem) => void;
 onJsonChange: (text: string) => void;
 onJsonSave: (item: OmpCatalogItem) => void;
 onJsonClose: (key: string) => void;
}) {
 const t = useText();
 const locale = useApp((s) => s.locale);
 const hint = item.description || undefined;
 const value = item.value;
 /** 行内标注（`SETTING_NOTES`）：仅 TUI 生效 / -1 = 默认。 */
 const note = SETTING_NOTES[item.key];
 const isJson = item.kind === "array" || item.kind === "record";
 const editingJson = jsonText !== undefined;
 const enumValues = choiceOptions(item, t);
 /** schema 类型名走字典；未知类型（上游将来加的）原样显示上游值。 */
 const kindKey = SETTING_KIND_KEYS[item.kind];
 const kindLabel = kindKey ? t[kindKey] : item.kind;
 /** 名称表（`ompSettingNames.ts`，519 项全覆盖）：有名字时名字当主标题、键名退到副行（与常用设置同构）。 */
 const pair = OMP_SETTING_NAMES[item.key];
 const name = pair ? pair[locale === "zh-CN" ? 0 : 1] : null;
 /** 控件的无障碍名：有翻译名用翻译名（与常用设置页同口径），没有条目时回退键名。 */
 const ariaName = name ?? item.key;

 /** 未被上游隐藏、且不是「未设置」时显示值的第二行标记；两种情况都不显示。 */
 const status = item.redacted
  ? t.allSettingsRedacted
  : value === null
   ? t.allSettingsNotSet
   : null;

 return (
  <div data-setting={item.key} className="min-h-11 py-2.5">
   <div className="flex flex-wrap items-center gap-2">
    <div className="min-w-0 basis-full @min-[480px]/panel:flex-1 @min-[480px]/panel:basis-0" title={hint}>
     <div className={name ? "text-[13px] leading-5" : "font-mono text-[12px] leading-5 break-all"}>
      {name ?? item.key}
     </div>
     <div className="mt-0.5 font-mono text-[11px] break-all text-faint">
      {name ? `${item.key} · ` : ""}
      {kindLabel}
      {status && ` · ${status}`}
      {note?.tuiOnly && ` · ${t.ompSettingsTuiOnly}`}
      {note?.minusOneIsDefault && value === -1 && ` · -1 = ${t.ompSettingsDefault}`}
      {note?.visibleWhenOff && value === false && ` · ${t.ompSettingsBrowserVisible}`}
     </div>
    </div>
    <button
     onClick={() => onReset(item.key)}
     disabled={busy}
     className="shrink-0 cursor-pointer rounded-md p-2 text-faint transition-colors duration-100 hover:bg-hover hover:text-foreground disabled:opacity-30"
     aria-label={`${t.ompSettingsReset}: ${ariaName}`}
     title={t.ompSettingsReset}
    >
     <Undo size={12} aria-hidden />
    </button>
    {item.redacted ? (
     <span className="shrink-0 text-[12px] text-faint" title={t.allSettingsRedactedHint}>
      {t.allSettingsRedacted}
     </span>
    ) : item.kind === "boolean" ? (
     <Switch
      on={value === true}
      disabled={busy}
      label={ariaName}
      onToggle={() => onSave(item.key, value !== true)}
     />
    ) : enumValues.length > 0 ? (
     <EnumSelect
      label={ariaName}
      value={typeof value === "string" ? value : undefined}
      choices={enumValues}
      busy={busy}
      onPick={(v) => onSave(item.key, v)}
     />
    ) : item.kind === "number" ? (
     <input
      type="number"
      value={draft ?? (typeof value === "number" ? String(value) : "")}
      disabled={busy}
      onChange={(e) => onDraft(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
       if (e.key === "Enter") e.currentTarget.blur();
      }}
      aria-label={ariaName}
      title={hint}
      className="w-28 shrink-0 rounded-md border border-border bg-background px-2.5 py-1.5 text-right font-mono text-[12px] transition-colors duration-100 focus:border-accent disabled:opacity-40"
     />
    ) : isJson ? (
     <div className="flex min-w-0 shrink-0 items-center gap-1.5">
      <code
       title={jsonPreview(value)}
       className="max-w-[14rem] truncate rounded-sm bg-background px-2 py-1 font-mono text-[11px] text-muted"
      >
       {jsonPreview(value) || t.allSettingsNotSet}
      </code>
      <button
       onClick={() => onOpenJson(item)}
       disabled={busy || editingJson}
       className="cursor-pointer rounded-md border border-border px-2.5 py-1.5 text-[12px] transition-colors duration-100 hover:bg-hover disabled:opacity-40"
      >
       {t.allSettingsEditJson}
      </button>
     </div>
    ) : (
     <input
      type="text"
      value={draft ?? (typeof value === "string" ? value : "")}
      disabled={busy}
      onChange={(e) => onDraft(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
       if (e.key === "Enter") e.currentTarget.blur();
      }}
      aria-label={ariaName}
      title={hint}
      placeholder={value === null ? t.allSettingsNotSet : undefined}
      className="min-w-0 shrink-0 basis-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[12px] transition-colors duration-100 focus:border-accent disabled:opacity-40 @min-[480px]/panel:basis-56"
     />
    )}
   </div>
   {editingJson && (
    <div className="mt-2">
     <textarea
      value={jsonText}
      onChange={(e) => onJsonChange(e.target.value)}
      rows={4}
      aria-label={fmt(t.allSettingsJsonAria, ariaName)}
      className="w-full rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[12px] leading-5 outline-none focus:border-accent"
     />
     <div className="mt-1.5 flex flex-wrap items-center gap-2">
      <button
       onClick={() => onJsonSave(item)}
       disabled={busy}
       className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-[12px] text-primary-foreground transition-opacity duration-100 hover:opacity-90 disabled:opacity-50"
      >
       {busy ? <Loader size={12} className="animate-spin" aria-hidden /> : t.allSettingsSave}
      </button>
      <button
       onClick={() => onJsonClose(item.key)}
       disabled={busy}
       className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[12px] transition-colors duration-100 hover:bg-hover disabled:opacity-50"
      >
       {t.cancel}
      </button>
      {jsonError && (
       <span role="alert" className="text-[12px] text-danger">
        {jsonError}
       </span>
      )}
     </div>
    </div>
   )}
  </div>
 );
}
