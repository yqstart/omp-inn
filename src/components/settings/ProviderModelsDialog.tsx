import { useState } from "react";
import type { ModelInfo } from "@shared/types";
import { fmt } from "../../lib/locale";
import { addManyMyModels, removeManyMyModels, toggleMyModel } from "../../lib/myModels";
import { useText } from "../../lib/useText";
import { DialogShell } from "./DialogShell";
import { StarToggle } from "./StarToggle";

/**
 * 某个登录型供应商在 omp 模型目录里的全部模型（星标 = 加入 / 移出「我的模型」）——两处共用：
 * 「挑选模型」弹窗（登录型供应商），与添加 / 重新登录成功后弹窗里的就地挑选。
 *
 * **自定义端点不走这里**（2026-10-17 拆分）：那种「挑选」管的是 `models.yml` 里有哪些模型，
 * 见 `CustomProviderModelsDialog.tsx`。
 *
 * 数据多（网关 / 订阅计划动辄几十个模型）：顶部搜索按 id 与名称过滤；「全选 / 清空」作用于
 * **当前过滤结果**（先搜到一撮再全选，符合直觉；无过滤时就是全部）；计数 = 已挑 / 全部。
 *
 * 布列 = 一列：搜索框与计数行 `shrink-0` 钉在顶部，**只有模型清单滚**（`flex-1 min-h-0
 * overflow-y-auto`）——弹窗外壳（`DialogShell`）在这条路上关掉整体滚动（2026-10-19 用户口径：
 * 几十个模型滚下去，过滤输入框跟着滚出视野就没法接着筛了）。就地内嵌的场合（登录成功后那段）
 * 父级不是 flex 列容器，`flex-1` 自然失效，清单随内容铺开、滚动回到外层——同一份代码两处都对。
 */
export function ProviderModelsList({
 providerId,
 catalog,
 myModels,
 onChange,
}: {
 providerId: string;
 catalog: ModelInfo[];
 myModels: string[];
 onChange: (next: string[]) => void;
}) {
 const t = useText();
 const [q, setQ] = useState("");
 const models = catalog.filter((m) => m.provider === providerId);
 const query = q.trim().toLowerCase();
 const shown = query ? models.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(query)) : models;
 const shownSelectors = shown.map((m) => m.selector);
 const selected = new Set(myModels);
 const shownPicked = shown.filter((m) => selected.has(m.selector)).length;
 const picked = models.filter((m) => selected.has(m.selector)).length;

 return (
  <div className="flex min-h-0 flex-1 flex-col">
   <input
    value={q}
    onChange={(e) => setQ(e.target.value)}
    placeholder={t.providersPickSearch}
    aria-label={t.providersPickSearch}
    className="w-full shrink-0 rounded-md border border-border bg-background px-3 py-2.5 text-[13px]"
   />
   <div className="mt-3 flex shrink-0 flex-wrap items-center gap-2">
    <span className="text-[11px] text-faint">{fmt(t.providersPickCount, String(picked), String(models.length))}</span>
    {query && <span className="text-[11px] text-faint">{fmt(t.providersPickMatches, String(shown.length))}</span>}
    <button
     onClick={() => onChange(addManyMyModels(myModels, shownSelectors))}
     disabled={shownPicked === shownSelectors.length}
     className="ml-auto cursor-pointer rounded border border-border px-2 py-0.5 text-[12px] transition-colors duration-100 hover:bg-hover disabled:opacity-40"
    >
     {query ? t.providersPickFilteredAll : t.providersPickAll}
    </button>
    <button
     onClick={() => onChange(removeManyMyModels(myModels, shownSelectors))}
     disabled={shownPicked === 0}
     className="cursor-pointer rounded border border-border px-2 py-0.5 text-[12px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground disabled:opacity-40"
    >
     {query ? t.providersPickFilteredNone : t.providersPickNone}
    </button>
   </div>
   {models.length === 0 ? (
    <p className="mt-3 shrink-0 text-[13px] text-muted">{t.providersPickEmpty}</p>
   ) : shown.length === 0 ? (
    <p className="mt-3 shrink-0 text-[13px] text-muted">{t.noModelMatch}</p>
   ) : (
    <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
     {shown.map((m) => (
      <div
       key={m.selector}
       className="flex flex-wrap items-center gap-2 border-t border-border-soft py-3 text-[13px] first:border-t-0"
      >
       <StarToggle on={selected.has(m.selector)} name={m.name} onClick={() => onChange(toggleMyModel(myModels, m.selector))} />
       <span className="min-w-0 flex-1 truncate">{m.name}</span>
       <span className="min-w-0 basis-full pl-9 font-mono text-[11px] break-all text-faint sm:ml-auto sm:max-w-[50%] sm:basis-auto sm:pl-0">{m.selector}</span>
      </div>
     ))}
    </div>
   )}
  </div>
 );
}

/** 「挑选模型」弹窗（行上按钮打开）：把上面那份列表装进 fixed 弹窗。 */
export function ProviderModelsDialog({
 provider,
 catalog,
 myModels,
 onChange,
 onClose,
}: {
 provider: { id: string; name: string };
 catalog: ModelInfo[];
 myModels: string[];
 onChange: (next: string[]) => void;
 onClose: () => void;
}) {
 const t = useText();
 return (
  <DialogShell title={fmt(t.providersPickTitle, provider.name)} onClose={onClose} width="max-w-2xl" bodyScroll={false}>
   <ProviderModelsList providerId={provider.id} catalog={catalog} myModels={myModels} onChange={onChange} />
  </DialogShell>
 );
}
