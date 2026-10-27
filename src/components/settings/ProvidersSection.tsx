import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowUpRightSquare, Check, Copy, Key, Loader, Plus, Trash2 } from "reicon-react";
import { api } from "@shared/api";
import { IPC } from "@shared/ipc";
import type { ModelCatalog, ModelInfo, ModelsConfigFile, ProviderLoginStatus, ProviderView } from "@shared/types";
import { useApp } from "../../stores/app";
import { fmt } from "../../lib/locale";
import { toggleMyModel } from "../../lib/myModels";
import {
 emptyProviderForm,
 isDuplicateProviderId,
 parseModelsConfig,
 providerFormComplete,
 providerFormOf,
 removeProvider,
 upsertProvider,
 type CustomProviderForm,
 type CustomProviderView,
} from "../../lib/customModels";
import { useText } from "../../lib/useText";
import { ConfirmDialog } from "../ConfirmDialog";
import { CustomProviderEditForm } from "./CustomProviderEditForm";
import { CustomProviderModelsDialog } from "./CustomProviderModelsDialog";
import { DialogShell } from "./DialogShell";
import { ProviderModelsDialog, ProviderModelsList } from "./ProviderModelsDialog";
import { PICK_CUSTOM, ProviderPicker } from "./ProviderPicker";

/**
 * 设置 › 模型 ›「供应商」区块（V12c：登录型供应商与自定义模型合并为一个添加面板）。
 *
 * 一个「添加供应商」按钮包住两种添加方式，先选提供商：
 * - **自定义**（选择器首项）→ 写 omp 的 `<agentDir>/models.yml`（自建端点 / 网关 / 本地推理），
 *   保真编辑 + 预校验 + 备份，见 `lib/customModels.ts` 与 `src-tauri/src/models_config.rs`；
 * - **omp 供应商目录里的某个提供商** → 走 `omp auth-broker login` 把凭证写进 omp 的凭证库
 *   （API key 直接粘进下面的输入框；OAuth 型会给出浏览器链接）。上游输出**原样透传**：
 *   提问文案与流程随供应商变化，硬编码匹配会漂。登录成功立即刷新模型目录，就地挑选模型
 *   （星标 = 加入上面的「我的模型」，只影响本应用的选择器，不写 omp 的 `enabledModels`）。
 *
 * **供应商配置与挑选模型分开（2026-10-17）**：自定义供应商的表单只配 名称 / 接口地址 /
 * 接口类型 / API Key；模型清单一律到**已配置的供应商行**上点「挑选模型」管——
 * 自定义端点走 `CustomProviderModelsDialog`（「获取可用模型」问端点要清单 → 勾选 → 逐项调参，
 * 每行行尾星标 = 加入 / 移出「我的模型」），登录型仍是在 omp 目录里加星。两种「挑选」语义不同，
 * 入口文案相同（都在行上）。
 *
 * 「已配置」= 该供应商出现在 omp 当前模型目录里（有凭证或免钥），这是壳侧能拿到的最接近
 * 「已登录」的真值，不去直读 omp 的凭证库；列表只列已配置的登录型供应商 + models.yml 里的块
 * （未配置的提供商在「添加供应商」的选择器里）。
 */
export function ProvidersSection({
 /** 供应商登出 / 删除成功后清理本机与 omp 里对它的引用（ModelsPanel 注入）。 */
 onProviderRemoved,
}: {
 onProviderRemoved?: (providerId: string) => Promise<void>;
} = {}) {
 const t = useText();
 const { models, set, myModels, setMyModels } = useApp();
 const [providers, setProviders] = useState<ProviderView[] | null>(null);
 const [file, setFile] = useState<ModelsConfigFile | null>(null);
 const [login, setLogin] = useState<ProviderLoginStatus | null>(null);
 const [err, setErr] = useState<string | null>(null);
 const [busy, setBusy] = useState(false);
 const [pendingLogout, setPendingLogout] = useState<ProviderView | null>(null);
 /** 打开「挑选模型」弹窗的供应商（null = 关闭）——`custom` 决定走哪种挑选：
  *  自定义端点（`models.yml` 的块）= 拉候选 + 写模型清单；登录型 = omp 目录里的星标挑选。 */
 const [picking, setPicking] = useState<{ id: string; name: string; custom: boolean } | null>(null);
 /** 添加面板：打开态 / 已选的登录型提供商（null = 还在选提供商）。 */
 const [addOpen, setAddOpen] = useState(false);
 const [addPick, setAddPick] = useState<string | null>(null);
 /** 自定义供应商表单（新建或编辑；`originalId` 非空 = 编辑该块）；非 null 时占据面板位。 */
 const [editing, setEditing] = useState<CustomProviderForm | null>(null);
 const [formErr, setFormErr] = useState<string | null>(null);
 /** 自定义行的删除确认目标（行内确认：设置页是可滚动容器，浮层会被裁掉）。 */
 const [pendingRemove, setPendingRemove] = useState<string | null>(null);
 const busyRef = useRef(false);
 const loadVersion = useRef(0);
 const editingFile = useRef<ModelsConfigFile | null>(null);
 const recoverLogin = useRef(true);
 const loginStart = useRef<Promise<void> | null>(null);
 const closingRef = useRef(false);
 const [startingLogin, setStartingLogin] = useState(false);
 const [closing, setClosing] = useState(false);

 /** 拉供应商清单、配置与目录；较早请求的结果不能覆盖更新后的快照。
  *  三个读取各自到达即渲染：目录（`omp models --json`，实测 2–10s；后端已收敛成单飞 + 缓存
  *  + 过期后台刷新）不该拖住供应商清单与 models.yml 的显示。 */
 const load = useCallback((force: boolean) => {
  const version = ++loadVersion.current;
  let failed = false;
  const fail = (e: unknown) => {
   failed = true;
   if (version === loadVersion.current) setErr(e instanceof Error ? e.message : t.providerLoadFailed);
  };
  return Promise.all([
   api.listProviders().then((v) => { if (version === loadVersion.current) setProviders(v); }).catch(fail),
   api.readModelsConfig().then((v) => { if (version === loadVersion.current) setFile(v); }).catch(fail),
   (force ? api.refreshModels() : api.getModels()).then((v) => { if (version === loadVersion.current) set({ models: v }); }).catch(fail),
  ]).then(() => {
   if (version === loadVersion.current && !failed) setErr(null);
  });
 }, [set, t.providerLoadFailed]);

 useEffect(() => {
  void load(!models);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载时拉一次
 }, []);

 // 登录进度：后端推的是**全量快照**（不是增量），这里直接覆盖即可
 useEffect(() => {
  let active = true;
  const un = listen<ProviderLoginStatus>(IPC.providerLogin, (e) => {
   if (!active) return;
   if (recoverLogin.current) {
    recoverLogin.current = false;
    if (e.payload.running && e.payload.provider) {
     setAddOpen(true);
     setAddPick(e.payload.provider);
    }
   }
   setLogin(e.payload);
   if (e.payload.done?.ok) void load(true);
  });
  // 先订阅再取快照；迟到的初始快照不能覆盖用户刚启动的新流程。
  void un.then(async () => {
   if (!active) return;
   if (!recoverLogin.current) return;
   const status = await api.getProviderLogin();
   if (!active || !recoverLogin.current) return;
   recoverLogin.current = false;
   setLogin(status);
   if (status.running && status.provider) {
    setAddOpen(true);
    setAddPick(status.provider);
   }
  }).catch((e: unknown) => {
   if (active) setErr(e instanceof Error ? e.message : t.loginFailed);
  });
  return () => {
   active = false;
   void un.then((dispose) => dispose()).catch(() => { });
  };
 }, [load, t.loginFailed]);

 // 目录快照刷新完成：已配置标记按新目录更新。后端那时缓存已新鲜，这次 `load` 是瞬时的
 // （`listProviders` 不再等 `omp models --json`）；load 本身不会触发新刷新，无循环。
 useEffect(() => {
  let active = true;
  const un = listen<ModelCatalog>(IPC.modelsRefreshed, () => {
   if (active) void load(false);
  });
  return () => {
   active = false;
   void un.then((dispose) => dispose()).catch(() => { });
  };
 }, [load]);

 /** 发起 `auth-broker login`：上游先打印取 key 的说明 / 授权链接，用户在面板里回答提问。 */
 const startLogin = (id: string) => {
  if (loginStart.current || closingRef.current) return;
  recoverLogin.current = false;
  setErr(null);
  setFormErr(null);
  setStartingLogin(true);
  setLogin({ provider: id, running: true, url: null, lines: [], done: null });
  const request = api.startProviderLogin(id).catch((e: unknown) => {
   setLogin({ provider: id, running: false, url: null, lines: [], done: { ok: false, cancelled: false, message: e instanceof Error ? e.message : t.loginFailed } });
  }).finally(() => {
   loginStart.current = null;
   setStartingLogin(false);
  });
  loginStart.current = request;
 };

 /** 添加面板：选完提供商立即开始流程（自定义 → 表单；其余 → 凭据卡）。 */
 const pickProvider = (id: string) => {
  if (busyRef.current || closingRef.current) return;
  recoverLogin.current = false;
  setFormErr(null);
  setPendingRemove(null);
  if (id === PICK_CUSTOM) {
   if (!file) return;
   editingFile.current = file;
   setEditing(emptyProviderForm());
   return;
  }
  setAddPick(id);
  void startLogin(id);
 };

 /** 打开添加面板（未选提供商）。 */
 const openAdd = () => {
  if (busyRef.current || closingRef.current) return;
  recoverLogin.current = false;
  setFormErr(null);
  setPendingRemove(null);
  setPicking(null);
  setAddPick(null);
  setEditing(null);
  setAddOpen(true);
 };

 /** 关闭面板；`cancelLogin` 时顺手终止还在跑的登录子进程（关闭 = 放弃这次添加）。 */
 const closeAdd = async (cancelLogin: boolean) => {
  if (busyRef.current || closingRef.current) return;
  closingRef.current = true;
  setClosing(true);
  recoverLogin.current = false;
  if (cancelLogin && addPick) {
   // 关闭可能发生在首次快照之前：等启动命令落定后再取消，避免遗留后台登录。
   await loginStart.current;
   try {
    const current = await api.getProviderLogin();
    if (current.running && current.provider === addPick) await api.cancelProviderLogin();
   } catch (e) {
    setFormErr(e instanceof Error ? e.message : t.opFailed);
    closingRef.current = false;
    setClosing(false);
    return;
   }
  }
  setAddOpen(false);
  setAddPick(null);
  setEditing(null);
  editingFile.current = null;
  setFormErr(null);
  closingRef.current = false;
  setClosing(false);
 };

 /** 行上的「登录」：重新走一遍该供应商的凭据流程（更新 key / 重新授权）。 */
 const relogin = (id: string) => {
  if (busyRef.current || closingRef.current) return;
  setFormErr(null);
  setPendingRemove(null);
  setPicking(null);
  setEditing(null);
  setAddOpen(true);
  setAddPick(id);
  void startLogin(id);
 };

 const beginEdit = (id: string) => {
  if (!file || busyRef.current || closingRef.current) return;
  const form = providerFormOf(file.text, id);
  if (!form) return;
  editingFile.current = file;
  recoverLogin.current = false;
  setFormErr(null);
  setPendingRemove(null);
  setPicking(null);
  setAddPick(null);
  setAddOpen(true);
  setEditing(form);
 };

 /** 保存自定义供应商：表单 → 保真编辑 → 后端预校验 + 落盘（失败时原文件不动）。 */
 const saveCustom = async () => {
  const source = editingFile.current;
  if (!editing || !source || busyRef.current) return;
  if (!providerFormComplete(editing)) {
   setFormErr(t.customFormIncomplete);
   return;
  }
  // 改名撞已有 id（编辑保留原名不算）——挡在写盘前
  if (isDuplicateProviderId(editing, parseModelsConfig(source.text).providers.map((p) => p.id))) {
   setFormErr(t.customFormDupId);
   return;
  }
  const edited = upsertProvider(source.text, editing);
  if (!edited.ok) {
   setFormErr(edited.error);
   return;
  }
  /** 保存后的键名（改名场景 = 新键）：写入成功后就地开该供应商的挑模型弹窗。 */
  const editedId = editing.id.trim();
  busyRef.current = true;
  loadVersion.current += 1;
  setBusy(true);
  setFormErr(null);
  try {
   const next = await api.writeModelsConfig(edited.text, source.hash);
   setFile(next);
   setEditing(null);
   editingFile.current = null;
   setAddOpen(false);
   setAddPick(null);
   // 写入已通过 omp 预校验——目录里立刻能看到（有凭证或免钥时）
   await load(true);
   // 与登录成功后的就地挑选对齐：保存完直接开该新供应商的挑模型弹窗（此时还没有模型，
   // 弹窗里点「获取可用模型」即可列出该端点提供的清单）
   setPicking({ id: editedId, name: editedId, custom: true });
  } catch (e) {
   setFormErr(e instanceof Error ? e.message : t.opFailed);
  } finally {
   busyRef.current = false;
   setBusy(false);
  }
 };

 /** 供应商移除后的模型引用清理：失败返回提示文本——删除 / 登出本身已经成功，
  *  不能把它反过来报成失败；清理错误单独显示并保留。 */
 const purgeProviderRefs = async (id: string, message: string): Promise<string | null> => {
  if (!onProviderRemoved) return null;
  try {
   await onProviderRemoved(id);
   return null;
  } catch (e) {
   return fmt(message, e instanceof Error ? e.message : t.opFailed);
  }
 };

 const doRemove = async (id: string) => {
  if (!file || busyRef.current) return;
  busyRef.current = true;
  loadVersion.current += 1;
  setPendingRemove(null);
  setBusy(true);
  setErr(null);
  try {
   const edited = removeProvider(file.text, id);
   if (!edited.ok) {
    setErr(edited.error);
    return;
   }
   const next = await api.writeModelsConfig(edited.text, file.hash);
   setFile(next);
   const purgeError = await purgeProviderRefs(id, t.providerPurgeFailedAfterRemove);
   await load(true);
   if (purgeError) setErr(purgeError);
  } catch (e) {
   setErr(e instanceof Error ? e.message : t.opFailed);
  } finally {
   busyRef.current = false;
   setBusy(false);
  }
 };

 const doLogout = async () => {
  if (busyRef.current) return;
  const p = pendingLogout;
  setPendingLogout(null);
  if (!p) return;
  busyRef.current = true;
  loadVersion.current += 1;
  setBusy(true);
  setErr(null);
  try {
   await api.logoutProvider(p.id);
   const purgeError = await purgeProviderRefs(p.id, t.providerPurgeFailedAfterLogout);
   await load(true);
   if (purgeError) setErr(purgeError);
  } catch (e) {
   setErr(e instanceof Error ? e.message : t.opFailed);
  } finally {
   busyRef.current = false;
   setBusy(false);
  }
 };

 const catalog = models?.models ?? [];
 const configured = (providers ?? []).filter((p) => p.configured);
 const parsed = file ? parseModelsConfig(file.text) : { providers: [], error: null };
 const pickedProvider = addPick ? (providers?.find((p) => p.id === addPick) ?? null) : null;
 /** 只认当前提供商的登录快照：刚点完时事件还没到，旧快照（上一次登录 / 初始空态）不算数。 */
 const activeLogin = login && login.provider === addPick ? login : null;

 return (
  <>
   {err && (
    <p role="alert" className="rounded border border-danger/40 bg-danger/5 px-3 py-2 text-[13px] text-danger">
     {err}
    </p>
   )}

   <section aria-label={t.providersSection} className="mt-6 shrink-0">
    <div className="flex flex-wrap items-center gap-2">
     <h3 className="text-xs font-medium text-muted">{t.providersSection}</h3>
     <button
      onClick={openAdd}
      disabled={providers === null || !file || !!parsed.error || busy || closing}
      className="ml-auto flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 text-[12px] font-medium transition-colors duration-100 hover:bg-hover disabled:opacity-40"
     >
      <Plus size={12} aria-hidden />
      {t.providersAdd}
     </button>
    </div>

    {parsed.error && (
     <p role="alert" className="mt-2 rounded border border-danger/40 bg-danger/5 px-3 py-2 text-[13px] text-danger">
      {parsed.error.kind === "yaml" ? fmt(t.customYamlBroken, parsed.error.message) : t.customShapeBroken}
     </p>
    )}

    <div className="mt-1.5 divide-y divide-border-soft">
     {providers === null ? (
      <div className="py-2 text-[13px] text-muted">{t.archivedLoading}</div>
     ) : (
      <>
       {providers.length === 0 && (
        <div className="py-2 text-[13px] text-muted">{t.providerEmpty}</div>
       )}
       {providers.length > 0 && configured.length === 0 && parsed.providers.length === 0 && (
        <div className="py-2 text-[13px] text-muted">{t.providersEmptyAll}</div>
       )}
       {configured.map((p) => (
        <div key={p.id} className="flex min-h-11 flex-wrap items-center gap-2 py-2.5">
         <div className="min-w-0 basis-full @min-[600px]/panel:flex-1 @min-[600px]/panel:basis-0">
          <div className="truncate text-sm">{p.name}</div>
          <div className="mt-0.5 break-all font-mono text-[11px] text-faint">{p.id}</div>
         </div>
         <span className="shrink-0 text-[13px] text-ok">{t.providerConfigured}</span>
         <button
          onClick={() => setPicking({ id: p.id, name: p.name, custom: false })}
          disabled={busy || closing}
          className="shrink-0 cursor-pointer rounded-md border border-border px-2.5 py-1 text-[13px] transition-colors duration-100 hover:bg-hover"
         >
          {t.providersPick}
         </button>
         <button
          onClick={() => relogin(p.id)}
          disabled={busy || closing}
          className="shrink-0 cursor-pointer rounded-md border border-border px-2.5 py-1 text-[13px] transition-colors duration-100 hover:bg-hover"
          aria-label={fmt(t.providerLogin + " {0}", p.id)}
         >
          {t.providerLogin}
         </button>
         <button
          onClick={() => setPendingLogout(p)}
          disabled={busy || closing}
          className="shrink-0 cursor-pointer rounded-md border border-border px-2.5 py-1 text-[13px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
          aria-label={fmt(t.providerLogout + " {0}", p.id)}
         >
          {t.providerLogout}
         </button>
        </div>
       ))}
       {parsed.providers.map((v) => (
        <CustomRow
         key={v.id}
         view={v}
         activeCount={catalog.filter((m) => m.provider === v.id).length}
         busy={busy || closing}
         pending={pendingRemove === v.id}
         editing={editing?.originalId === v.id}
         onEdit={() => beginEdit(v.id)}
         onPick={() => setPicking({ id: v.id, name: v.id, custom: true })}
         onAskRemove={() => {
          setPendingRemove(v.id);
          setEditing(null);
         }}
         onCancelRemove={() => setPendingRemove(null)}
         onRemove={() => void doRemove(v.id)}
        />
       ))}
      </>
     )}
    </div>

    {file && (
     <p className="mt-3 font-mono text-[11px] break-all text-faint" title={file.path}>
      {file.path}
      {!file.exists && ` · ${t.customFileMissing}`}
     </p>
    )}
   </section>

   {/* 挑选模型：两套语义各走各的弹窗——
       自定义端点 = 拉端点候选 + 写 `models.yml` 的模型清单；登录型 = omp 目录里的星标挑选 */}
   {picking && file && (
    picking.custom ? (
     <CustomProviderModelsDialog
      key={picking.id}
      provider={picking}
      file={file}
      myModels={myModels}
      onToggleStar={(selector) => setMyModels(toggleMyModel(myModels, selector))}
      onClose={() => setPicking(null)}
      onSaved={(next) => {
       setFile(next);
       setPicking(null);
       void load(true);
      }}
     />
    ) : (
     <ProviderModelsDialog
      provider={picking}
      catalog={catalog}
      myModels={myModels}
      onChange={setMyModels}
      onClose={() => setPicking(null)}
     />
    )
   )}

   {/* 添加供应商：一个弹窗换内容——选提供商 →（「自定义」表单 ｜ 提供商凭据流程） */}
   {(addOpen || !!editing) && (
    <DialogShell
     title={
      editing
       ? editing.originalId
        ? fmt(t.customFormEdit, editing.id)
        : t.customFormNew
       : addPick === null
        ? t.providersAddPick
        : fmt(t.providersAddTitle, pickedProvider?.name ?? addPick)
     }
     onClose={() => void closeAdd(true)}
     width={editing ? "max-w-2xl" : "max-w-xl"}
    >
     {!editing && formErr && <p role="alert" className="mb-3 text-xs text-danger">{formErr}</p>}
     {editing ? (
      <CustomProviderEditForm
       form={editing}
       busy={busy}
       error={formErr}
       existingIds={parsed.providers.map((p) => p.id)}
       onChange={(next) => { setEditing(next); setFormErr(null); }}
       onCancel={() => {
        if (editing.originalId) {
         void closeAdd(false);
        } else {
         setEditing(null);
         editingFile.current = null;
         setFormErr(null);
        }
       }}
       onSave={() => void saveCustom()}
      />
     ) : addPick === null ? (
      <ProviderPicker providers={providers ?? []} onPick={pickProvider} />
     ) : (
      <LoginFlow
       key={addPick}
       providerId={addPick}
       providerName={pickedProvider?.name ?? null}
       status={activeLogin}
       starting={startingLogin}
       closing={closing}
       catalog={catalog}
       myModels={myModels}
       onModelsChange={setMyModels}
       onClose={() => void closeAdd(true)}
       onRetry={() => startLogin(addPick)}
      />
     )}
    </DialogShell>
   )}

   <ConfirmDialog
    open={!!pendingLogout}
    danger
    title={pendingLogout ? fmt(t.logoutConfirmTitle, pendingLogout.name) : ""}
    detail={t.logoutConfirmDetail}
    confirmLabel={t.providerLogout}
    onCancel={() => setPendingLogout(null)}
    onConfirm={() => void doLogout()}
   />
  </>
 );
}

/** 一行自定义供应商（models.yml）：自己声明了 `baseUrl` 的块给挑选 / 编辑 / 删除；
 *  只覆盖内置供应商的块（没有 `baseUrl`）只读——界面表达不了那些覆盖语义。 */
function CustomRow({
 view,
 activeCount,
 busy,
 pending,
 editing,
 onEdit,
 onPick,
 onAskRemove,
 onCancelRemove,
 onRemove,
}: {
 view: CustomProviderView;
 activeCount: number;
 busy: boolean;
 pending: boolean;
 editing: boolean;
 onEdit: () => void;
 onPick: () => void;
 onAskRemove: () => void;
 onCancelRemove: () => void;
 onRemove: () => void;
}) {
 const t = useText();
 const kindLabel = view.kind === "custom" ? t.customKindCustom : t.customKindOverride;
 return (
  <div className="flex min-h-11 flex-wrap items-center gap-2 py-2.5">
   <div className="min-w-0 basis-full @min-[600px]/panel:flex-1 @min-[600px]/panel:basis-0">
    <div className="flex flex-wrap items-center gap-1.5">
     <span className="truncate font-mono text-sm">{view.id}</span>
     <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted">{kindLabel}</span>
     {view.kind === "custom" && (
      <span className={`shrink-0 text-[11px] ${activeCount > 0 ? "text-ok" : "text-faint"}`}>
       {activeCount > 0 ? fmt(t.customActive, String(activeCount)) : t.customInactive}
      </span>
     )}
    </div>
    <div className="truncate font-mono text-xs text-muted" title={view.baseUrl ?? undefined}>
     {view.baseUrl ?? "—"}
     {view.kind === "custom" && ` · ${fmt(t.customModelCount, String(view.modelCount))}`}
     {view.extraKeys.length > 0 && ` · ${fmt(t.customExtraKeys, view.extraKeys.join(" / "))}`}
    </div>
   </div>

   {view.kind === "override" ? (
    <span className="shrink-0 max-w-40 text-right text-[11px] text-faint">{t.customOverrideHint}</span>
   ) : pending ? (
    <>
     <span className="min-w-0 basis-full text-[13px] break-all text-warn">{fmt(t.customRemoveConfirm, view.id)}</span>
     <button
      onClick={onRemove}
      disabled={busy}
      className="shrink-0 cursor-pointer rounded-md border border-danger/50 px-2.5 py-1 text-[13px] text-danger transition-colors duration-100 hover:bg-danger/10 disabled:opacity-50"
     >
      {t.customRemove}
     </button>
     <button
      onClick={onCancelRemove}
      className="shrink-0 cursor-pointer rounded-md border border-border px-2.5 py-1 text-[13px] text-muted transition-colors duration-100 hover:bg-hover"
     >
      {t.cancel}
     </button>
    </>
   ) : (
    <>
     <button
      onClick={onPick}
      disabled={busy || editing}
      className="shrink-0 cursor-pointer rounded-md border border-border px-2.5 py-1 text-[13px] transition-colors duration-100 hover:bg-hover disabled:opacity-50"
     >
      {t.providersPick}
     </button>
     <button
      onClick={onEdit}
      disabled={busy || editing}
      className="shrink-0 cursor-pointer rounded-md border border-border px-2.5 py-1 text-[13px] transition-colors duration-100 hover:bg-hover disabled:opacity-50"
     >
      {t.customEdit}
     </button>
     <button
      onClick={onAskRemove}
      disabled={busy || editing}
      aria-label={fmt(t.customRemoveAria, view.id)}
      className="flex shrink-0 cursor-pointer items-center rounded-md border border-border p-1.5 text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground disabled:opacity-50"
     >
      <Trash2 size={12} aria-hidden />
     </button>
    </>
   )}
  </div>
 );
}

/**
 * 凭据流程卡（添加 / 重新登录某个登录型供应商）：上游输出窗口 + URL（打开 / 复制）+ 输入行。
 * API key 直接粘进输入框提交；OAuth 型按上游给的链接去浏览器授权。成功后就地给出该供应商的
 * 模型列表——星标即加入「我的模型」（挑选入口的第二处，第一处是行内的「挑选模型」）。
 */
function LoginFlow({
 providerId,
 providerName,
 status,
 starting,
 closing,
 catalog,
 myModels,
 onModelsChange,
 onClose,
 onRetry,
}: {
 providerId: string;
 providerName: string | null;
 /** 事件还没到时为 null（刚点完，正等第一次快照）——按「进行中」显示。 */
 status: ProviderLoginStatus | null;
 starting: boolean;
 closing: boolean;
 catalog: ModelInfo[];
 myModels: string[];
 onModelsChange: (next: string[]) => void;
 onClose: () => void;
 onRetry: () => void;
}) {
 const t = useText();
 const [text, setText] = useState("");
 const [copied, setCopied] = useState(false);
 const [sending, setSending] = useState(false);
 const sendingRef = useRef(false);
 const [actionError, setActionError] = useState<string | null>(null);
 const copyTimer = useRef<number | undefined>(undefined);
 useEffect(() => () => window.clearTimeout(copyTimer.current), []);
 const running = status?.running ?? true;
 const done = status?.done ?? null;
 const ok = !!done?.ok;

 const copyUrl = async () => {
  if (!status?.url) return;
  try {
   setActionError(null);
   await navigator.clipboard.writeText(status.url);
   setCopied(true);
   window.clearTimeout(copyTimer.current);
   copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
  } catch {
   setActionError(t.copyFailed);
  }
 };

 const send = async () => {
  if (!running || starting || closing || sendingRef.current) return;
  sendingRef.current = true;
  setSending(true);
  setActionError(null);
  try {
   // 本地免钥端点允许空行；不要吞掉上游合法的「回车继续」。
   await api.providerLoginInput(text.trim());
   setText("");
  } catch (e) {
   setActionError(e instanceof Error ? e.message : t.opFailed);
  } finally {
   sendingRef.current = false;
   setSending(false);
  }
 };

 const title = closing ? t.loginCancelling : starting ? t.loginStarting : ok
  ? fmt(t.providersAddAdded, providerName ?? providerId)
  : running
   ? t.loginWaiting
   : done?.cancelled
    ? t.loginCancelled
    : t.loginFailed;

 return (
  <div className="rounded-md bg-background p-3 sm:p-4">
   <div className="flex flex-wrap items-center gap-2 text-sm">
    {running ? (
     <Loader size={14} className="shrink-0 animate-spin text-accent" aria-hidden />
    ) : ok ? (
     <Check size={14} className="shrink-0 text-ok" aria-hidden />
    ) : (
     <Key size={14} className="shrink-0 text-warn" aria-hidden />
    )}
    <span className={running || ok ? "" : "text-warn"}>{title}</span>
    <span className="ml-auto min-w-0 break-all font-mono text-xs text-muted">{providerId}</span>
    <button
     onClick={onClose}
     disabled={closing}
     className="shrink-0 cursor-pointer rounded border border-border px-2 py-0.5 text-[12px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
    >
     {running ? t.cancel : ok ? t.providersAddDone : t.close}
    </button>
    {!running && !ok && !starting && <button disabled={closing} onClick={() => { setText(""); setActionError(null); onRetry(); }} className="cursor-pointer rounded border border-border px-2 py-0.5 text-[12px] hover:bg-hover disabled:opacity-50">{t.retry}</button>}
   </div>

   {status?.done?.message && (
    <p role="alert" className="mt-2 font-mono text-xs break-words text-danger">{status.done.message}</p>
   )}
   {actionError && <p role="alert" className="mt-2 text-xs break-words text-danger">{actionError}</p>}

   {status?.url && (
    <div className="mt-3 flex flex-wrap items-start gap-2">
     <code className="min-w-0 basis-full font-mono text-xs break-all text-muted">{status.url}</code>
     <button
      onClick={() => { setActionError(null); void openUrl(status.url!).catch((e: unknown) => setActionError(e instanceof Error ? e.message : t.opFailed)); }}
      className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 text-[13px] transition-colors duration-100 hover:bg-hover"
      aria-label={t.loginOpenBrowser}
     >
      <ArrowUpRightSquare size={11} aria-hidden />
      {t.loginOpenBrowser}
     </button>
     <button
      onClick={() => void copyUrl()}
      className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 text-[13px] transition-colors duration-100 hover:bg-hover"
      aria-label={t.loginCopyUrl}
     >
      {copied ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
      {copied ? t.copied : t.loginCopyUrl}
     </button>
    </div>
   )}

   {status && status.lines.length > 0 && (
    <div className="mt-2">
     <div className="text-[13px] text-faint">{t.loginOutput}</div>
     <pre className="mt-2 max-h-36 overflow-y-auto rounded-md bg-surface p-3 font-mono text-xs whitespace-pre-wrap break-all text-muted">
      {status.lines.join("\n")}
     </pre>
    </div>
   )}

   {running && (
    <>
     <p className="mt-2 text-[12px] text-faint">{t.providersAddHint}</p>
     <form
      className="mt-1 flex items-center gap-2"
      onSubmit={(e) => {
       e.preventDefault();
       void send();
      }}
     >
      <input
       value={text}
       type="password"
       disabled={starting || closing || sending}
       onChange={(e) => setText(e.target.value)}
       placeholder={t.loginInputHint}
       aria-label={t.loginSend}
       className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
      />
      <button
       type="submit"
       disabled={starting || closing || sending}
       className="shrink-0 cursor-pointer rounded-md border border-border px-2.5 py-1 text-[13px] transition-colors duration-100 hover:bg-hover"
      >
       {t.loginSend}
      </button>
     </form>
    </>
   )}

   {ok && (
    <div className="mt-2 rounded-md border border-border bg-background p-2">
     <ProviderModelsList providerId={providerId} catalog={catalog} myModels={myModels} onChange={onModelsChange} />
    </div>
   )}
  </div>
 );
}
