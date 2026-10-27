import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader, Plus, Stethoscope, Trash2 } from "reicon-react";
import { api } from "@shared/api";
import type { MarketPluginItem, PluginDoctorFinding, PluginItem, PluginsView } from "@shared/types";
import { useApp } from "../../stores/app";
import { fmt } from "../../lib/locale";
import { useText } from "../../lib/useText";
import { scopeChoices, scopeValue } from "../../lib/panelScope";
import { doctorSummary, toggleFeature } from "../../lib/plugins";
import { ConfirmDialog } from "../ConfirmDialog";
import { DialogShell } from "./DialogShell";
import { EnumSelect } from "./EnumSelect";
import { Switch } from "./Switch";

/** 待确认的卸载（一次只确认一件事）。 */
type PendingUninstall = { id: string; scope: string | null };

/** 安装面板的草稿（源 + 范围 + 目标项目）。 */
type InstallDraft = { source: string; scope: "user" | "project"; projectPath: string | null };

/**
 * 设置 ›「插件」：omp 插件（`omp plugin`）的唯一管理面。
 *
 * 口径（上游实测）：
 * - **可见范围 = cwd**：项目 `package.json` 里装的插件与项目级市场安装都由 omp 按目录发现，
 *   所以页首有「全局 / 某个项目」的范围选择；全局 = 钉 agentDir（只看用户级）。
 * - **特性开关按「整个集合」写**（`--set`）：上游 `enabledFeatures: null` 表示沿用每个特性
 *   自己的 `default`，逐项 `--enable` 会从 null 出发丢掉默认开启的那些（实测）。界面算当前
 *   生效集合、整组写，写完就地按回读值更新（写过之后就是显式列表，标「已自定义」）。
 * - **不提供「预览」**：上游 `--dry-run` 对市场条目会照装（官方文档写明不适用），
 *   所以安装是一次信任确认 + 结果提示。
 * - 启停 / 卸载都**不猜 scope**：市场插件双份安装时把该行的 scope 原样回传（上游要求）。
 */
export function PluginsPanel() {
 const { projects } = useApp();
 const t = useText();
 /** 可见范围：null = 全局（用户级）。 */
 const [scopePath, setScopePath] = useState<string | null>(null);
 const [data, setData] = useState<PluginsView | null>(null);
 const [loadError, setLoadError] = useState<string | null>(null);
 const [error, setError] = useState<string | null>(null);
 const [notice, setNotice] = useState<string | null>(null);
 const [busy, setBusy] = useState(false);
 const [refreshing, setRefreshing] = useState(false);
 const [reloadKey, setReloadKey] = useState(0);
 const [doctor, setDoctor] = useState<PluginDoctorFinding[] | null>(null);
 const [doctorBusy, setDoctorBusy] = useState(false);
 const [pending, setPending] = useState<PendingUninstall | null>(null);
 const [draft, setDraft] = useState<InstallDraft | null>(null);
 const [installBusy, setInstallBusy] = useState(false);
 const [installError, setInstallError] = useState<string | null>(null);
 const busyRef = useRef(false);
 const loadVersion = useRef(0);

 /** 写控件的统一互斥：写操作进行中、或清单正在重新读取（范围切换 / 刷新）时锁住——
  *  读取在途时放行写，会出现「读的旧结果覆盖写后的新清单」这类竞态，直接不让两者重叠。 */
 const lock = busy || refreshing;

 const options = useMemo(() => scopeChoices(t.pluginsScopeGlobal, projects), [t.pluginsScopeGlobal, projects]);
 const projectOptions = useMemo(() => options.filter((o) => o.path !== null), [options]);
 /** 有效范围：选项里没有这个路径（项目被移除 / 改名）就按全局处理，别拿旧路径去问后端。 */
 const activeScope = options.some((o) => o.path === scopePath) ? scopePath : null;

 // 拉清单（范围 / 刷新计数变化都走这里）；迟到的结果不能覆盖新的
 useEffect(() => {
  const version = ++loadVersion.current;
  api
   .listPlugins(activeScope)
   .then((v) => {
    if (version !== loadVersion.current) return;
    setData(v);
    setLoadError(null);
   })
   .catch((e: unknown) => {
    if (version !== loadVersion.current) return;
    setData(null);
    setLoadError(e instanceof Error && e.message ? e.message : "");
   })
   .finally(() => {
    if (version === loadVersion.current) setRefreshing(false);
   });
 }, [activeScope, reloadKey]);

 /** 写操作的统一壳：串行（`busyRef` 挡重入）、结果替换整份清单、失败落错误条。 */
 const run = async (job: () => Promise<PluginsView>, done?: string) => {
  if (busyRef.current) return;
  busyRef.current = true;
  const version = ++loadVersion.current;
  setBusy(true);
  setError(null);
  setNotice(null);
  try {
   const fresh = await job();
   if (version === loadVersion.current) {
    setData(fresh);
    setLoadError(null);
    if (done) setNotice(done);
   }
  } catch (e) {
   setError(e instanceof Error ? e.message : t.opFailed);
  } finally {
   busyRef.current = false;
   setBusy(false);
  }
 };

 const toggleNpm = (item: PluginItem) =>
  void run(
   () => api.setPluginEnabled(item.name, !item.enabled, null, activeScope),
   fmt(item.enabled ? t.pluginsToggleOff : t.pluginsToggleOn, item.name),
  );

 const toggleMarket = (item: MarketPluginItem) =>
  void run(
   () => api.setPluginEnabled(item.id, !item.enabled, item.scope, activeScope),
   fmt(item.enabled ? t.pluginsToggleOff : t.pluginsToggleOn, item.id),
  );

 /** 特性开关：算「整组」→ 写 → 就地按回读值更新这一行（不回读整份清单，省一次进程）。 */
 const toggleFeatureOf = async (item: PluginItem, feature: string, on: boolean) => {
  if (busyRef.current) return;
  busyRef.current = true;
  const version = ++loadVersion.current;
  setBusy(true);
  setError(null);
  setNotice(null);
  try {
   const res = await api.setPluginFeatures(item.name, toggleFeature(item, feature, on));
   const set = new Set(res.enabledFeatures);
   if (version !== loadVersion.current) return;
   setData((prev) =>
    prev
     ? {
      ...prev,
      npm: prev.npm.map((p) =>
       p.name === item.name
        ? {
         ...p,
         // `--set` 写的就是显式列表（清单里已有的话不用改），生效值即列表命中
         featuresCustomized: true,
         features: p.features.map((f) => ({ ...f, enabled: set.has(f.name) })),
        }
        : p,
      ),
     }
     : prev,
   );
  } catch (e) {
   setError(e instanceof Error ? e.message : t.opFailed);
  } finally {
   busyRef.current = false;
   setBusy(false);
  }
 };

 const doUninstall = async () => {
  const job = pending;
  setPending(null);
  if (!job) return;
  await run(
   () => api.uninstallPlugin(job.id, job.scope, activeScope),
   fmt(t.pluginsUninstalledDone, job.id),
  );
 };

 const openInstall = () => {
  setInstallError(null);
  setDraft({
   source: "",
   scope: "user",
   // 范围停在某个项目时，默认就装到那个项目（用户已经在那个上下文里）
   projectPath: activeScope ?? projectOptions[0]?.path ?? null,
  });
 };

 const doInstall = async () => {
  if (!draft || installBusy) return;
  const source = draft.source.trim();
  if (source === "") return;
  const target = draft.scope === "project" ? draft.projectPath : null;
  setInstallBusy(true);
  setInstallError(null);
  setBusy(true);
  busyRef.current = true;
  const version = ++loadVersion.current;
  try {
   const fresh = await api.installPlugin(source, draft.scope === "project" ? "project" : null, target);
   if (version === loadVersion.current) {
    if (target === activeScope) {
     setData(fresh);
     setLoadError(null);
    } else {
     // 装到另一个范围了：跟着切过去看结果（选择器与列表必须说的是同一件事），由 effect 重拉
     setRefreshing(true);
     setScopePath(target);
    }
    setNotice(fmt(t.pluginsInstallDone, source));
   }
   setDraft(null);
  } catch (e) {
   setInstallError(e instanceof Error ? e.message : t.pluginsInstallFail);
  } finally {
   busyRef.current = false;
   setBusy(false);
   setInstallBusy(false);
  }
 };

 const doDoctor = async (fix: boolean) => {
  if (doctorBusy) return;
  setDoctorBusy(true);
  setError(null);
  try {
   const findings = await api.pluginDoctor(fix);
   setDoctor(findings);
   if (fix) {
    // `--fix` 会动插件目录（可能修好 / 停用某些插件）：把清单拉回来，别让界面停在旧状态
    setRefreshing(true);
    setReloadKey((k) => k + 1);
   }
  } catch (e) {
   setDoctor(null);
   setError(e instanceof Error ? e.message : t.pluginsDoctorFailed);
  } finally {
   setDoctorBusy(false);
  }
 };

 const summary = doctor ? doctorSummary(doctor) : null;
 /** 读取失败文案：后端 / 异常消息为空时用本地化兜底（切语言后重渲染即跟着换）。 */
 const loadErrorText = loadError === null ? null : loadError || t.pluginsLoadFailed;
 const npm = data?.npm ?? [];
 const market = data?.marketplace ?? [];
 const total = npm.length + market.length;

 /** 一行可点的特性开关（`aria-pressed` 表达状态，颜色不作唯一信号）。 */
 const renderFeature = (item: PluginItem, f: PluginItem["features"][number]) => (
  <button
   key={f.name}
   onClick={() => void toggleFeatureOf(item, f.name, !f.enabled)}
   disabled={lock}
   aria-pressed={f.enabled}
   aria-label={fmt(t.pluginsFeatureAria, f.name, f.enabled ? t.pluginsFeatureOn : t.pluginsFeatureOff)}
   title={f.description || f.name}
   className={`flex cursor-pointer items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[11px] transition-colors duration-100 disabled:opacity-40 ${f.enabled ? "border-accent/40 bg-accent/10 text-accent" : "border-border text-faint hover:bg-hover"
    }`}
  >
   {f.enabled && <Check size={10} aria-hidden />}
   {f.name}
  </button>
 );

 return (
  <section aria-label={t.tabPlugins} className="settings-panel shrink-0">
   {/* 页头整行已按用户口径退场（2026-10-19）：说明 / 计数 / 刷新钮都不再上界面，
        只剩两个功能入口（体检 / 安装插件——安装没有第二个入口），重读时机 = 重挂 + 页内动作。
        2026-10-19 用户口径：可见范围（项目 package.json 依赖与项目级市场安装由 omp 按目录发现；
        全局 = 只看用户级）与功能入口**合并成一行**——下拉在左、入口靠右，页首不再占两行。
        入口按钮与下拉同高（32px）：同一行里 28px 的按钮看着比下拉矮一档。 */}
   <div className="mt-3 flex flex-wrap items-center gap-2">
    <EnumSelect
     label={t.pluginsScope}
     value={scopeValue(options, activeScope)}
     choices={options.map((o) => ({ value: o.value, label: o.label }))}
     busy={refreshing}
     disabled={lock}
     onPick={(value) => {
      setRefreshing(true);
      setScopePath(options.find((o) => o.value === value)?.path ?? null);
     }}
    />
    <div className="ml-auto flex shrink-0 items-center gap-0.5">
     <button
      onClick={() => void doDoctor(false)}
      disabled={doctorBusy || lock}
      className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground disabled:opacity-40"
      aria-label={t.pluginsDoctor}
      title={t.pluginsDoctor}
     >
      {doctorBusy ? <Loader size={12} className="animate-spin" aria-hidden /> : <Stethoscope size={12} aria-hidden />}
     </button>
     <button
      onClick={openInstall}
      disabled={lock}
      className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 text-[12px] font-medium transition-colors duration-100 hover:bg-hover disabled:opacity-40"
      aria-label={t.pluginsInstall}
     >
      <Plus size={12} aria-hidden />
      {t.pluginsInstall}
     </button>
    </div>
   </div>

   {error && (
    <p role="alert" className="mt-2 rounded border border-danger/40 bg-danger/5 px-3 py-2 text-[13px] text-danger">
     {error}
    </p>
   )}
   {notice && (
    <p role="status" className="mt-2 rounded border border-border-soft bg-background px-3 py-2 text-[13px] text-muted">
     {notice}
     <span className="ml-1 text-faint">{t.pluginsRestartHint}</span>
    </p>
   )}

   {doctor && summary && (
    <section aria-label={t.pluginsDoctorResult} className="mt-6 shrink-0">
     <div className="flex flex-wrap items-center gap-2">
      <h3 className="text-xs font-medium text-muted">{t.pluginsDoctorResult}</h3>
      <span className="font-mono text-[11px] text-ok">{fmt(t.pluginsDoctorOk, summary.ok)}</span>
      {summary.warning > 0 && <span className="font-mono text-[11px] text-warn">{fmt(t.pluginsDoctorWarning, summary.warning)}</span>}
      {summary.error > 0 && <span className="font-mono text-[11px] text-danger">{fmt(t.pluginsDoctorError, summary.error)}</span>}
      {summary.fixed > 0 && <span className="font-mono text-[11px] text-muted">{fmt(t.pluginsDoctorFixed, summary.fixed)}</span>}
      <div className="ml-auto flex shrink-0 items-center gap-1">
       {summary.error > 0 && (
        <button
         onClick={() => void doDoctor(true)}
         disabled={doctorBusy || lock}
         className="cursor-pointer rounded-md border border-border px-2 py-0.5 text-[12px] transition-colors duration-100 hover:bg-hover disabled:opacity-50"
        >
         {t.pluginsDoctorFix}
        </button>
       )}
       <button
        onClick={() => setDoctor(null)}
        disabled={doctorBusy}
        className="cursor-pointer rounded-md px-2 py-0.5 text-[12px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
       >
        {t.close}
       </button>
      </div>
     </div>
     <ul className="mt-1.5 divide-y divide-border-soft">
      {doctor.map((f, i) => (
       <li key={`${f.name}-${i}`} className="flex flex-wrap items-baseline gap-x-2 py-2 text-[12px]">
        <span
         className={`shrink-0 font-mono ${f.status === "ok" ? "text-ok" : f.status === "error" ? "text-danger" : "text-warn"}`}
        >
         {f.status}
        </span>
        <span className="shrink-0 font-mono text-muted">{f.name}</span>
        <span className="min-w-0 break-all text-faint">{f.message}</span>
        {f.fixed && <span className="shrink-0 text-ok">{t.pluginsDoctorFixedTag}</span>}
       </li>
      ))}
     </ul>
    </section>
   )}

   {data === null ? (
    loadErrorText !== null ? (
     <div className="mt-3 flex flex-col items-start gap-2">
      <p role="alert" className="text-[13px] text-danger">
       {loadErrorText}
      </p>
      <button
       onClick={() => setReloadKey((k) => k + 1)}
       disabled={busy}
       className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[13px] transition-colors duration-100 hover:bg-hover disabled:opacity-50"
      >
       {t.retry}
      </button>
     </div>
    ) : (
     <p role="status" className="mt-3 text-[13px] text-muted">
      {t.pluginsLoading}
     </p>
    )
   ) : total === 0 ? (
    <p className="mt-4 rounded-md bg-surface px-4 py-8 text-center text-[13px] leading-relaxed text-muted">
     {t.pluginsEmpty}
     <br />
     <span className="text-faint">{t.pluginsEmptyHint}</span>
    </p>
   ) : (
    <>
     {npm.length > 0 && (
      <section aria-label={fmt(t.pluginsNpmSection, npm.length)} className="mt-6 shrink-0">
       <h3 className="text-xs font-medium text-muted">{fmt(t.pluginsNpmSection, npm.length)}</h3>
       <div className="mt-1.5 divide-y divide-border-soft">
        {npm.map((item) => (
         <div key={item.name} className="flex min-h-11 flex-wrap items-center gap-2 py-2.5">
          <div className="min-w-0 basis-full @min-[600px]/panel:flex-1 @min-[600px]/panel:basis-0">
           <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-sm font-medium">{item.name}</span>
            {item.version && <span className="shrink-0 font-mono text-[11px] text-faint">v{item.version}</span>}
            {!item.enabled && (
             <span className="shrink-0 rounded-sm bg-warn/10 px-1.5 py-0.5 text-[11px] text-warn">{t.pluginsDisabledTag}</span>
            )}
            {item.featuresCustomized && item.features.length > 0 && (
             <span className="shrink-0 rounded-sm bg-background px-1.5 py-0.5 text-[11px] text-faint" title={t.pluginsFeaturesCustomTitle}>
              {t.pluginsFeaturesCustom}
             </span>
            )}
           </div>
           {item.description && <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{item.description}</p>}
           <div className="mt-0.5 break-all font-mono text-[11px] text-faint">{item.path}</div>
           {item.features.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
             <span className="shrink-0 text-[11px] text-faint">{t.pluginsFeatures}:</span>
             {item.features.map((f) => renderFeature(item, f))}
            </div>
           )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
           <Switch
            on={item.enabled}
            disabled={lock}
            label={fmt(t.pluginsToggleAria, item.name, item.enabled ? t.pluginsDisable : t.pluginsEnable)}
            onToggle={() => toggleNpm(item)}
           />
           <button
            onClick={() => setPending({ id: item.name, scope: null })}
            disabled={lock}
            aria-label={fmt(t.pluginsUninstallAria, item.name)}
            className="flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-muted transition-colors duration-100 hover:bg-hover hover:text-danger disabled:opacity-40"
           >
            <Trash2 size={11} aria-hidden />
            {t.pluginsUninstall}
           </button>
          </div>
         </div>
        ))}
       </div>
      </section>
     )}

     {market.length > 0 && (
      <section aria-label={fmt(t.pluginsMarketSection, market.length)} className="mt-6 shrink-0">
       <h3 className="text-xs font-medium text-muted">{fmt(t.pluginsMarketSection, market.length)}</h3>
       <div className="mt-1.5 divide-y divide-border-soft">
        {market.map((item) => (
         <div key={item.id} className="flex min-h-11 flex-wrap items-center gap-2 py-2.5">
          <div className="min-w-0 basis-full @min-[600px]/panel:flex-1 @min-[600px]/panel:basis-0">
           <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate font-mono text-[13px]">{item.id}</span>
            {item.version && <span className="shrink-0 font-mono text-[11px] text-faint">v{item.version}</span>}
            <span className="shrink-0 rounded-sm bg-background px-1.5 py-0.5 text-[11px] text-muted">
             {item.scope === "project" ? t.pluginsScopeProject : t.pluginsScopeUser}
            </span>
            {!item.enabled && (
             <span className="shrink-0 rounded-sm bg-warn/10 px-1.5 py-0.5 text-[11px] text-warn">{t.pluginsDisabledTag}</span>
            )}
            {item.shadowedBy && (
             <span className="shrink-0 rounded-sm bg-warn/10 px-1.5 py-0.5 text-[11px] text-warn">
              {t.pluginsShadowed}
             </span>
            )}
           </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
           <Switch
            on={item.enabled}
            disabled={lock}
            label={fmt(t.pluginsToggleAria, item.id, item.enabled ? t.pluginsDisable : t.pluginsEnable)}
            onToggle={() => toggleMarket(item)}
           />
           <button
            onClick={() => setPending({ id: item.id, scope: item.scope })}
            disabled={lock}
            aria-label={fmt(t.pluginsUninstallAria, item.id)}
            className="flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-muted transition-colors duration-100 hover:bg-hover hover:text-danger disabled:opacity-40"
           >
            <Trash2 size={11} aria-hidden />
            {t.pluginsUninstall}
           </button>
          </div>
         </div>
        ))}
       </div>
      </section>
     )}
    </>
   )}

   <ConfirmDialog
    open={pending !== null}
    title={pending ? fmt(t.pluginsUninstallConfirm, pending.id) : ""}
    detail={t.pluginsUninstallDetail}
    confirmLabel={t.pluginsUninstall}
    danger
    onCancel={() => setPending(null)}
    onConfirm={() => void doUninstall()}
   />

   {draft && (
    <DialogShell title={t.pluginsInstall} onClose={() => setDraft(null)} width="max-w-2xl">
     <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-[13px]">
       <span className="font-medium">{t.pluginsInstallSource}</span>
       <input
        value={draft.source}
        autoFocus
        onChange={(e) => setDraft({ ...draft, source: e.target.value })}
        onKeyDown={(e) => {
         if (e.key === "Enter") void doInstall();
        }}
        placeholder={t.pluginsInstallPlaceholder}
        className="min-h-9 rounded-md border border-border bg-background px-3 py-2 font-mono text-[13px] outline-none focus:border-accent"
       />
      </label>
      <p className="text-[12px] leading-relaxed text-faint">{t.pluginsInstallExample}</p>

      <div className="flex flex-wrap items-center gap-2 text-[13px]">
       <span className="font-medium">{t.pluginsInstallScope}</span>
       {(["user", "project"] as const).map((s) => (
        <button
         key={s}
         onClick={() => setDraft({ ...draft, scope: s })}
         aria-pressed={draft.scope === s}
         disabled={installBusy}
         className={`cursor-pointer rounded-md border px-2.5 py-1 text-[13px] transition-colors duration-100 disabled:opacity-50 ${draft.scope === s ? "border-accent bg-accent/10 text-accent" : "border-border text-muted hover:bg-hover"
          }`}
        >
         {s === "user" ? t.pluginsInstallScopeUser : t.pluginsInstallScopeProject}
        </button>
       ))}
       {draft.scope === "project" &&
        (projectOptions.length === 0 ? (
         <span className="text-[12px] text-warn">{t.pluginsInstallNoProject}</span>
        ) : (
         <EnumSelect
          label={t.pluginsInstallProject}
          value={
           scopeValue(projectOptions, draft.projectPath) ||
           (projectOptions[0] ? projectOptions[0].value : "")
          }
          choices={projectOptions.map((o) => ({ value: o.value, label: o.label }))}
          disabled={installBusy}
          onPick={(value) =>
           setDraft({ ...draft, projectPath: projectOptions.find((o) => o.value === value)?.path ?? null })
          }
         />
        ))}
      </div>

      <p className="rounded border border-warn/40 bg-warn/5 px-3 py-2 text-[12px] leading-relaxed text-warn">
       {t.pluginsInstallTrust}
      </p>
      <p className="text-[12px] leading-relaxed text-faint">{t.pluginsInstallMarketHint}</p>
      {installError && (
       <p role="alert" className="rounded border border-danger/40 bg-danger/5 px-3 py-2 text-[13px] text-danger">
        {installError}
       </p>
      )}
      {installBusy && <p className="text-[12px] leading-relaxed text-faint">{t.pluginsInstallBusyHint}</p>}
      <div className="flex items-center justify-end gap-2">
       <button
        onClick={() => setDraft(null)}
        disabled={installBusy}
        className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[13px] transition-colors duration-100 hover:bg-hover disabled:opacity-50"
       >
        {t.cancel}
       </button>
       <button
        onClick={() => void doInstall()}
        disabled={installBusy || draft.source.trim() === "" || (draft.scope === "project" && projectOptions.length === 0)}
        className="flex cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] text-primary-foreground transition-colors duration-100 hover:opacity-90 disabled:opacity-50"
       >
        {installBusy ? <Loader size={12} className="animate-spin" aria-hidden /> : null}
        {installBusy ? t.pluginsInstalling : t.pluginsInstall}
       </button>
      </div>
     </div>
    </DialogShell>
   )}
  </section>
 );
}
