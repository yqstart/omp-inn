import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Loader, X } from "reicon-react";
import { api } from "@shared/api";
import type { FallbackChainsInfo, ModelInfo } from "@shared/types";
import { fmt, type Text } from "../../lib/locale";
import { splitSelector, withLevel } from "../../lib/modelSelector";
import { roleLabel } from "../../lib/roleNames";
import { thinkingLevelsOf, THINKING_ORDER } from "../../lib/thinking";
import { useText } from "../../lib/useText";
import { EnumSelect, LEVEL_TRIGGER_CLASS } from "./EnumSelect";
import { ModelPickerDialog } from "./ModelPickList";

/** 键的形态（只影响徽章与新建时的候选来源，不影响读写）：`*` 结尾 = 供应商通配、含 `/` = 模型 selector、其余 = 角色名。 */
type ChainKind = "role" | "model" | "provider";

function chainKind(key: string): ChainKind {
 if (key.endsWith("/*")) return "provider";
 return key.includes("/") ? "model" : "role";
}

/** `provider/*` 这类通配条目：omp 规定它**总是**继承失败轮次的档位，所以不给档位后缀。 */
function isWildcard(sel: string): boolean {
 return sel.endsWith("/*");
}

/**
 * 设置 ›「模型」的**失败转移**区块：omp `retry.fallbackChains` 的读写 + 两个配套开关。
 *
 * 口径（上游 description，omp 18.2.1 实测）：
 * - 键三种形态，匹配规则全在 omp 里（壳侧只读写，不复制那套规则）：角色名 / 模型 selector /
 *   供应商通配（`provider/*` 保留失败模型的 id 只换供应商）；
 * - 值是有序备用 selector，**顺序就是 omp 的尝试顺序**；条目可带 `:档位` 后缀，不带则继承
 *   失败轮次的档位，通配条目总是继承；档位在目标行上用 `EnumSelect` 浮层下拉选（与模型角色行
 *   同一形态）——**不做行内展开**：展开会把下面的行整体推走（点开 / 关上都跳）；
 * - `retry.modelFallback = false` 时链完全不生效——所以开关与链放在同一个区块里（拆开会让
 *   「链配好了却不生效」变成一个看不见的坑）；
 * - 写的是 omp **全局配置**（与模型角色同一层）。
 *
 * 编辑是**草稿 + 显式保存**（不是每点一下写一次 omp）：链是多步编辑（增删 / 排序 / 换档），
 * 逐步写会留下中间态（删了 A 还没加 B），也会打出很多次 omp 子进程。
 */
export function FallbackChainsSection({
 info,
 models,
 catalog,
 roles,
 myModels,
 onToggleMyModel,
 busy,
 loadError,
 onSaved,
 onRefresh,
}: {
 info: FallbackChainsInfo | null;
 models: ModelInfo[];
 catalog: ModelInfo[];
 /** 角色候选（内置 + 自定义，与角色区块同一份）。 */
 roles: string[];
 /** 我的模型（selector，按挑选顺序）：选单的行内星标与置顶分组用。 */
 myModels: string[];
 onToggleMyModel: (selector: string) => void;
 busy: boolean;
 /** 读取失败（保留旧数据时显示过期提示，空快照时显示重试）。 */
 loadError: string | null;
 onSaved: (info: FallbackChainsInfo) => void;
 onRefresh: () => void;
}) {
 const t = useText();
 const [err, setErr] = useState<string | null>(null);
 const [writing, setWriting] = useState(false);
 /** 正在编辑的链：null = 都收起，`""` = 新建，其余 = 该键。 */
 const [editing, setEditing] = useState<string | null>(null);
 /** 待确认删除的键（行内二次确认，不弹浮层）。 */
 const [confirmKey, setConfirmKey] = useState<string | null>(null);

 const chains = useMemo(() => Object.entries(info?.chains ?? {}), [info]);
 const usedKeys = useMemo(() => new Set(chains.map(([k]) => k)), [chains]);
 const enabled = info?.modelFallback ?? true;
 const policy = info?.revertPolicy ?? "cooldown-expiry";

 /** 写一次 omp 配置并把回读真值交回上层；失败保留草稿（不清编辑态）。 */
 const write = async (fn: () => Promise<FallbackChainsInfo>, failMsg: string, finishEditing = true) => {
  setErr(null);
  setWriting(true);
  try {
   onSaved(await fn());
   if (finishEditing) {
    setEditing(null);
    setConfirmKey(null);
   }
  } catch (e) {
   setErr(e instanceof Error ? e.message : failMsg);
  } finally {
   setWriting(false);
  }
 };

 return (
  <section aria-label={t.fallbackSection} className="mt-6 shrink-0">
   <div className="flex flex-wrap items-center gap-2">
    <h3 className="text-xs font-medium text-muted">{t.fallbackSection}</h3>
   </div>

   {
    err && (
     <p role="alert" className="mt-2 rounded border border-danger/40 bg-danger/5 px-2 py-1.5 text-[13px] text-danger">
      {err}
     </p>
    )
   }
   {
    loadError && info !== null && (
     <p role="alert" className="mt-2 rounded border border-warn/40 bg-warn/5 px-2 py-1.5 text-[13px] text-warn">
      {t.ompSettingsStale}：{loadError}
     </p>
    )
   }

   {
    info === null ? (
     loadError ? (
      <div className="flex flex-col items-start gap-2 py-2">
       <p role="alert" className="text-[13px] text-danger">{loadError}</p>
       <button
        onClick={onRefresh}
        disabled={busy || writing}
        className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[13px] transition-colors duration-100 hover:bg-hover disabled:opacity-50"
       >
        {t.retry}
       </button>
      </div>
     ) : (
      <div className="py-2 text-[13px] text-muted">{t.archivedLoading}</div>
     )
    ) : (
     <>
      {/* 总开关 + 回归策略：链配得再好，总开关关了也不生效，所以两者同屏 */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
       <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={writing}
        onClick={() =>
         void write(
          () => api.setRetryOptions(!enabled, policy),
          t.fallbackOptionsWriteFailed,
          false,
         )
        }
        title={t.fallbackRevertHint}
        className={`shrink-0 cursor-pointer rounded-md border px-2.5 py-1 text-[13px] transition-colors duration-100 disabled:opacity-50 ${enabled
         ? "border-accent/50 bg-active text-foreground"
         : "border-border text-muted hover:bg-hover hover:text-foreground"
         }`}
       >
        {t.fallbackEnabled}
       </button>
       {enabled && (
        <div
         role="radiogroup"
         aria-label={t.fallbackRevertLabel}
         title={t.fallbackRevertHint}
         className="flex min-w-0 flex-wrap items-center gap-1 rounded-md bg-surface p-1"
        >
         {(
          [
           ["cooldown-expiry", t.fallbackRevertCooldown],
           ["never", t.fallbackRevertNever],
          ] as const
         ).map(([value, label]) => {
          const selected = policy === value;
          return (
           <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={writing}
            onClick={() =>
             void write(
              () => api.setRetryOptions(enabled, value),
              t.fallbackOptionsWriteFailed,
              false,
             )
            }
            className={`cursor-pointer rounded-sm px-2 py-0.5 text-[12px] transition-colors duration-100 disabled:opacity-50 ${selected ? "bg-active text-foreground" : "text-muted hover:bg-hover hover:text-foreground"
             }`}
           >
            {label}
           </button>
          );
         })}
        </div>
       )}
      </div>
      {/* 关闭态必须看得见：链配好了却不生效是这块最容易踩的坑，不藏在悬浮提示里 */}
      {!enabled && <p className="mt-1.5 text-[13px] text-warn">{t.fallbackDisabledHint}</p>}

      {/* 链列表 */}
      <div className="mt-1 divide-y divide-border-soft">
       {chains.length === 0 && editing !== "" ? (
        <p className="py-2 text-[13px] text-muted">{t.fallbackEmpty}</p>
       ) : (
        chains.map(([key, targets]) => (
         <div key={key} className="py-2.5">
          <div className="flex flex-wrap items-center gap-2">
           <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-xs text-muted">
            {kindLabel(chainKind(key), t)}
           </span>
           <span className="min-w-0 flex-1 truncate font-mono text-xs">{key}</span>
           {confirmKey === key ? (
            <>
             <span className="shrink-0 text-[13px] text-muted">{t.fallbackConfirmDelete}</span>
             <button
              onClick={() => void write(() => api.setFallbackChain(key, null), t.fallbackWriteFailed)}
              disabled={writing}
              className="shrink-0 cursor-pointer rounded-md border border-danger/40 px-2.5 py-1 text-[13px] text-danger transition-colors duration-100 hover:bg-danger/10 disabled:opacity-50"
             >
              {t.fallbackDelete}
             </button>
             <button
              onClick={() => setConfirmKey(null)}
              disabled={writing}
              className="shrink-0 cursor-pointer rounded-md border border-border px-2.5 py-1 text-[13px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground disabled:opacity-50"
             >
              {t.fallbackCancel}
             </button>
            </>
           ) : (
            <>
             <button
              onClick={() => setEditing(editing === key ? null : key)}
              disabled={writing || (editing !== null && editing !== key)}
              aria-expanded={editing === key}
              aria-label={fmt(t.fallbackEditAria, key)}
              className="shrink-0 cursor-pointer rounded-md border border-border px-2.5 py-1 text-[13px] transition-colors duration-100 hover:bg-hover disabled:opacity-50"
             >
              {t.fallbackEdit}
             </button>
             <button
              onClick={() => setConfirmKey(key)}
              disabled={writing || editing !== null}
              aria-label={fmt(t.fallbackDeleteAria, key)}
              className="shrink-0 cursor-pointer rounded-md border border-border px-2.5 py-1 text-[13px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground disabled:opacity-50"
             >
              {t.fallbackDelete}
             </button>
            </>
           )}
          </div>
          {/* 转移目标：按 omp 的尝试顺序排 */}
          <div className="mt-1 flex flex-wrap items-center gap-1 pl-1">
           {targets.map((sel, i) => (
            <span key={`${sel}-${i}`} className="flex min-w-0 max-w-full items-center gap-1">
             {i > 0 && (
              <span aria-hidden className="text-[11px] text-faint">
               →
              </span>
             )}
             <span className="min-w-0 rounded-sm bg-background px-2 py-1 font-mono text-[11px] break-all text-muted">
              {sel}
             </span>
            </span>
           ))}
          </div>
          {editing === key && (
           <ChainEditor
            isNew={false}
            initialKey={key}
            initialTargets={targets}
            models={models}
            catalog={catalog}
            roles={roles}
            myModels={myModels}
            onToggleMyModel={onToggleMyModel}
            usedKeys={usedKeys}
            writing={writing}
            onSave={(k, list) => void write(() => api.setFallbackChain(k, list), t.fallbackWriteFailed)}
            onCancel={() => setEditing(null)}
           />
          )}
         </div>
        ))
       )}
      </div>

      {editing === "" ? (
       <ChainEditor
        isNew
        initialKey=""
        initialTargets={[]}
        models={models}
        roles={roles}
        catalog={catalog}
        myModels={myModels}
        onToggleMyModel={onToggleMyModel}
        usedKeys={usedKeys}
        writing={writing}
        onSave={(k, list) => void write(() => api.setFallbackChain(k, list), t.fallbackWriteFailed)}
        onCancel={() => setEditing(null)}
       />
      ) : (
       <button
        onClick={() => setEditing("")}
        disabled={writing || editing !== null}
        className="mt-2 cursor-pointer rounded-md border border-border px-2.5 py-1 text-[13px] transition-colors duration-100 hover:bg-hover disabled:opacity-50"
       >
        {t.fallbackAddChain}
       </button>
      )}
     </>
    )}
  </section>
 );
}

/** 类型徽章文案（链键的三种形态）。 */
function kindLabel(kind: ChainKind, t: Text): string {
 if (kind === "provider") return t.fallbackKindProvider;
 if (kind === "model") return t.fallbackKindModel;
 return t.fallbackKindRole;
}

/**
 * 一条链的编辑区（新建与编辑共用，行内展开）。
 * 新建时先挑「生效对象」（角色 / 模型 / 供应商通配），再往下加转移目标；
 * 编辑时对象固定（要换对象就删掉重建——换键本质是删一条加一条，不做隐式迁移）。
 */
function ChainEditor({
 isNew,
 initialKey,
 initialTargets,
 models,
 catalog,
 roles,
 myModels,
 onToggleMyModel,
 usedKeys,
 writing,
 onSave,
 onCancel,
}: {
 isNew: boolean;
 initialKey: string;
 initialTargets: string[];
 models: ModelInfo[];
 catalog: ModelInfo[];
 roles: string[];
 /** 我的模型（selector，按挑选顺序）：选单的行内星标与置顶分组用。 */
 myModels: string[];
 onToggleMyModel: (selector: string) => void;
 usedKeys: Set<string>;
 writing: boolean;
 onSave: (key: string, targets: string[]) => void;
 onCancel: () => void;
}) {
 const t = useText();
 const [kind, setKind] = useState<ChainKind>(chainKind(initialKey));
 const [key, setKey] = useState(initialKey);
 const [list, setList] = useState<string[]>(initialTargets);
 const [adding, setAdding] = useState(false);
 /** 新建链的「模型对象」挑选弹窗（模型太多，芯片排铺不下——与角色行同款弹窗）。 */
 const [keyPickerOpen, setKeyPickerOpen] = useState(false);

 const providers = useMemo(
  () => [...new Set(models.map((m) => m.provider))].sort((a, b) => a.localeCompare(b)),
  [models],
 );
 const canSave = key.trim() !== "" && list.length > 0 && (!isNew || !usedKeys.has(key));

 const move = (i: number, dir: -1 | 1) => {
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  setList(next);
 };

 /** 该条目的可选档位：目录里有这个模型就按它声明的档，查不到退回全集（宽容，不挡用户）。 */
 const levelsFor = (sel: string): string[] => {
  const m = catalog.find((x) => x.selector === splitSelector(sel).base);
  return m ? thinkingLevelsOf(m.thinking) : [...THINKING_ORDER];
 };

 return (
  <div className="mt-2 rounded-md bg-surface p-2">
   <fieldset disabled={writing} className="min-w-0">
    {/* 生效对象：新建时可选类型；编辑时固定显示（换对象 = 删掉重建） */}
    <div className="flex flex-wrap items-center gap-2">
     <span className="shrink-0 text-[13px] text-muted">{t.fallbackKindLabel}</span>
     {isNew ? (
      <div
       role="radiogroup"
       aria-label={t.fallbackKindLabel}
       className="flex min-w-0 flex-wrap items-center gap-1 rounded-md bg-surface p-1"
      >
       {(
        [
         ["role", t.fallbackKindRole],
         ["model", t.fallbackKindModel],
         ["provider", t.fallbackKindProvider],
        ] as const
       ).map(([k, label]) => (
        <button
         key={k}
         type="button"
         role="radio"
         aria-checked={kind === k}
         onClick={() => {
          setKind(k);
          setKey("");
         }}
         className={`cursor-pointer rounded-sm px-2 py-0.5 text-[12px] transition-colors duration-100 ${kind === k ? "bg-active text-foreground" : "text-muted hover:bg-hover hover:text-foreground"
          }`}
        >
         {label}
        </button>
       ))}
      </div>
     ) : (
      <span className="min-w-0 break-all font-mono text-xs">{key}</span>
     )}
    </div>

    {/* 候选：按类型给（已在用的键标出来并禁用——一个键只能有一条链） */}
    {isNew && (
     <div className="mt-1.5">
      {kind === "role" && (
       <div className="flex flex-wrap gap-1">
        {roles.length === 0 && <span className="text-[13px] text-muted">{t.fallbackKeyEmpty}</span>}
        {roles.map((r) => {
         const used = usedKeys.has(r);
         return (
          <button
           key={r}
           type="button"
           disabled={used}
           onClick={() => setKey(r)}
           title={used ? t.fallbackKeyInUse : r}
           aria-pressed={key === r}
           className={`cursor-pointer rounded-md border px-2 py-0.5 text-[13px] transition-colors duration-100 disabled:cursor-default disabled:opacity-40 ${key === r ? "border-accent/50 bg-active text-foreground" : "border-border text-muted hover:bg-hover hover:text-foreground"
            }`}
          >
           {roleLabel(r, t)}
          </button>
         );
        })}
       </div>
      )}
      {kind === "provider" && (
       <div className="flex flex-wrap gap-1">
        {providers.length === 0 && <span className="text-[13px] text-muted">{t.fallbackKeyEmpty}</span>}
        {providers.map((p) => {
         const value = `${p}/*`;
         const used = usedKeys.has(value);
         return (
          <button
           key={p}
           type="button"
           disabled={used}
           onClick={() => setKey(value)}
           title={used ? t.fallbackKeyInUse : value}
           aria-pressed={key === value}
           className={`cursor-pointer rounded-md border px-2 py-0.5 font-mono text-xs transition-colors duration-100 disabled:cursor-default disabled:opacity-40 ${key === value ? "border-accent/50 bg-active text-foreground" : "border-border text-muted hover:bg-hover hover:text-foreground"
            }`}
          >
           {value}
          </button>
         );
        })}
       </div>
      )}
      {kind === "model" && (
       <button
        type="button"
        onClick={() => setKeyPickerOpen(true)}
        aria-haspopup="dialog"
        aria-label={t.pickModelTitle}
        className="cursor-pointer rounded-md border border-border px-2.5 py-1 text-[13px] transition-colors duration-100 hover:bg-hover"
       >
        {t.pickModelTitle}
       </button>
      )}
      {key && <p className="mt-2 break-all font-mono text-xs text-muted">{key}</p>}
      {key && usedKeys.has(key) && <p role="alert" className="mt-1 text-xs text-warn">{t.fallbackKeyInUse}</p>}
     </div>
    )}

    {/* 转移目标：有序列表（上移 / 下移改的就是 omp 的尝试顺序） */}
    <div className="mt-3 flex flex-wrap items-center gap-2">
     <span className="text-[13px] text-muted">{t.fallbackTargetsLabel}</span>
     <span className="text-[11px] text-faint">{t.fallbackTargetsHint}</span>
    </div>
    <div className="mt-1">
     {list.map((sel, i) => (
      <div key={`${sel}-${i}`} className="flex flex-wrap items-center gap-1.5 py-1">
       <span aria-hidden className="w-4 shrink-0 text-right font-mono text-[11px] text-faint">
        {i + 1}
       </span>
       <span className="min-w-0 flex-1 basis-4/5 break-all font-mono text-xs @min-[600px]/panel:basis-0">{sel}</span>
       {/* 通配条目总是继承档位（omp 的规则），不给后缀选择 */}
       {isWildcard(sel) ? (
        <span className="shrink-0 rounded border border-border-soft px-1.5 py-0.5 text-[11px] text-faint">
         {t.fallbackInheritLevel}
        </span>
       ) : (
        /* 档位 = 浮层下拉（`EnumSelect`）：与模型角色行的档位同一形态。空值档 = 「不写后缀」，
           交给 omp 继承失败轮次的档位，所以 `value` 用空串、`display` 显示「继承档位」 */
        <EnumSelect
         label={fmt(t.fallbackTargetLevelAria, sel)}
         value={splitSelector(sel).level ?? ""}
         display={splitSelector(sel).level ?? t.fallbackInheritLevel}
         choices={[
          { value: "", label: t.fallbackInheritLevel },
          ...levelsFor(sel).map((lv) => ({ value: lv, label: lv })),
         ]}
         triggerTitle={t.fallbackTargetLevelHint}
         triggerClassName={LEVEL_TRIGGER_CLASS}
         onPick={(lv) => setList(list.map((s, j) => (j === i ? withLevel(s, lv === "" ? null : lv) : s)))}
        />
       )}
       <button
        type="button"
        onClick={() => move(i, -1)}
        disabled={i === 0}
        aria-label={t.fallbackMoveUp}
        title={t.fallbackMoveUp}
        className="shrink-0 cursor-pointer rounded p-0.5 text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground disabled:opacity-30"
       >
        <ArrowUp size={12} aria-hidden />
       </button>
       <button
        type="button"
        onClick={() => move(i, 1)}
        disabled={i === list.length - 1}
        aria-label={t.fallbackMoveDown}
        title={t.fallbackMoveDown}
        className="shrink-0 cursor-pointer rounded p-0.5 text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground disabled:opacity-30"
       >
        <ArrowDown size={12} aria-hidden />
       </button>
       <button
        type="button"
        onClick={() => setList(list.filter((_, j) => j !== i))}
        aria-label={t.fallbackRemoveTarget}
        title={t.fallbackRemoveTarget}
        className="shrink-0 cursor-pointer rounded p-0.5 text-muted transition-colors duration-100 hover:bg-hover hover:text-danger"
       >
        <X size={12} aria-hidden />
       </button>
      </div>
     ))}
     {list.length === 0 && <p className="py-1 text-[13px] text-warn">{t.fallbackNeedTarget}</p>}
    </div>

    {/* 添加目标：开模型选择弹窗（选中即追加，档位随后在行上改） */}
    <button
     type="button"
     onClick={() => setAdding(true)}
     className="mt-1.5 cursor-pointer rounded-md border border-border px-2.5 py-1 text-[13px] transition-colors duration-100 hover:bg-hover"
    >
     {t.fallbackAddTarget}
    </button>

    <div className="mt-2 flex items-center gap-2 border-t border-border-soft pt-2">
     <button
      type="button"
      onClick={() => onSave(key, list)}
      disabled={!canSave || writing}
      className="cursor-pointer rounded-md border border-accent/50 bg-active px-2.5 py-1 text-[13px] transition-colors duration-100 hover:bg-hover disabled:opacity-50"
     >
      {isNew ? t.fallbackCreate : t.fallbackSave}
     </button>
     <button
      type="button"
      onClick={onCancel}
      disabled={writing}
      className="cursor-pointer rounded-md border border-border px-2.5 py-1 text-[13px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground disabled:opacity-50"
     >
      {t.fallbackCancel}
     </button>
     {writing && <Loader size={12} className="animate-spin text-muted" aria-hidden />}
    </div>
   </fieldset>

   {/* 弹窗挂在 fieldset 外：fieldset disabled（写入中）会连弹窗里的按钮一起禁掉 */}
   {keyPickerOpen && (
    <ModelPickerDialog
     title={t.pickModelTitle}
     models={models.filter((m) => !usedKeys.has(m.selector))}
     selected={key}
     onPick={(m) => {
      setKey(m.selector);
      setKeyPickerOpen(false);
     }}
     onClose={() => setKeyPickerOpen(false)}
     myModels={myModels}
     onToggleStar={onToggleMyModel}
    />
   )}
   {adding && (
    <ModelPickerDialog
     title={t.fallbackAddTarget}
     models={models}
     onPick={(m) => {
      setList([...list, m.selector]);
      setAdding(false);
     }}
     onClose={() => setAdding(false)}
     myModels={myModels}
     onToggleStar={onToggleMyModel}
    />
   )}
  </div>
 );
}
