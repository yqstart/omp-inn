import { useState } from "react";
import type { ProviderView } from "@shared/types";
import { fmt } from "../../lib/locale";
import { useText } from "../../lib/useText";

/** 选择器里「自定义」项的哨兵值（不是 auth-broker 的供应商 id）。 */
export const PICK_CUSTOM = "\u0000custom";

/**
 * 「添加供应商」的第一步：选提供商（搜索过滤 + 固定首项「自定义」）。
 *
 * 列表 = 当前 `omp auth-broker list` 的全量供应商（73 家量级）：**已配置的排前面**（用户多半是
 * 来管自己已有的那几家），搜索对 **id 与名称**做大小写不敏感的子串匹配，右侧计数显示当前命中数。
 * 「自定义」不参与过滤、恒定置顶：它的语义是「不走 omp 的供应商目录，自己写 models.yml」，
 * 搜索时也应该总够得着。
 */
export function ProviderPicker({
 providers,
 onPick,
}: {
 providers: ProviderView[];
 onPick: (id: string) => void;
}) {
 const t = useText();
 const [q, setQ] = useState("");
 const query = q.trim().toLowerCase();
 const ordered = [...providers.filter((p) => p.configured), ...providers.filter((p) => !p.configured)];
 const list = query ? ordered.filter((p) => `${p.id} ${p.name}`.toLowerCase().includes(query)) : ordered;

 return (
  <>
   <input
    value={q}
    onChange={(e) => setQ(e.target.value)}
    placeholder={t.providersAddSearch}
    aria-label={t.providersAddSearch}
    className="w-full rounded-md border border-border bg-background px-3 py-2.5 text-[13px]"
   />
   <div className="mt-3 flex items-center text-[11px] text-faint">
    <span>{fmt(t.providersAddCount, String(list.length))}</span>
   </div>
   <div className="mt-2 max-h-80 space-y-1 overflow-y-auto">
    <button
     onClick={() => onPick(PICK_CUSTOM)}
     className="flex min-h-11 w-full cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-background px-3 py-3 text-left text-[13px] transition-colors duration-100 hover:bg-hover"
    >
     <span className="min-w-0 truncate font-medium">{t.customKindCustom}</span>
     <span className="ml-auto min-w-0 text-[11px] text-faint">{t.providersAddCustomHint}</span>
    </button>
    {list.map((p) => (
     <button
      key={p.id}
      onClick={() => onPick(p.id)}
      className="flex min-h-11 w-full cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-3 py-2 text-left text-[13px] transition-colors duration-100 hover:bg-hover"
     >
      <span className="min-w-0 truncate">{p.name}</span>
      <span className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
       {p.configured && <span className="text-[11px] text-ok">{t.providerConfigured}</span>}
       <span className="min-w-0 break-all font-mono text-[11px] text-faint">{p.id}</span>
      </span>
     </button>
    ))}
    {list.length === 0 && <p className="p-2 text-[13px] text-muted">{t.noModelMatch}</p>}
   </div>
  </>
 );
}
