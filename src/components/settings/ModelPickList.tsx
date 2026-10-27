import { useRef, useState, type Ref } from "react";
import type { ModelInfo } from "@shared/types";
import { fmt } from "../../lib/locale";
import { fmtContextWindow, shortModelName } from "../../lib/modelNames";
import { splitStarredModels } from "../../lib/myModels";
import { useText } from "../../lib/useText";
import { DialogShell } from "./DialogShell";
import { StarToggle } from "./StarToggle";

/**
 * 模型选择列表（搜索框 + 星标置顶分组 + 点选）——由 `ModelPickerDialog` 装进弹窗，
 * 调用方不该直接渲染它（行内展开会把设置页撑成一条、点开时页面跳动）。
 *
 * 分组（无查询时）：**星标模型**（按「我的模型」存储顺序）置顶成组，其余按供应商分组
 * （星标项不在供应商组里重复出现）；分区口径 = `lib/myModels.ts` 的 `splitStarredModels`
 * （与聊天下拉 `ModelMenu` 共用一份）。有查询时不分组、按过滤结果平铺。每行行首的星标
 * 开关 = 加入 / 移出「我的模型」——只影响排序，不改变这里的候选范围。
 */
export function ModelPickList({
 models,
 selected,
 onPick,
 inputRef,
 myModels,
 onToggleStar,
}: {
 models: ModelInfo[];
 selected?: string;
 onPick: (m: ModelInfo) => void;
 /** 弹窗把搜索框当初始焦点用（打开即可输入）。 */
 inputRef?: Ref<HTMLInputElement>;
 /** 我的模型（selector，按挑选顺序）：无查询时置顶成组。 */
 myModels: string[];
 /** 行首星标开关：加入 / 移出「我的模型」（调用方落 localStorage）。 */
 onToggleStar: (selector: string) => void;
}) {
 const t = useText();
 const [q, setQ] = useState("");
 const query = q.trim().toLowerCase();
 const filtered = query
  ? models.filter((m) => `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(query))
  : models;
 const starredSet = new Set(myModels);
 /** 星标组（按存储顺序）+ 其余模型（星标项不重复出现）——与聊天下拉同一份分区口径。 */
 const { starred, others } = splitStarredModels(filtered, myModels);
 /** 其余模型按供应商分组。 */
 const groups = new Map<string, ModelInfo[]>();
 for (const m of others) {
  const g = groups.get(m.provider) ?? [];
  g.push(m);
  groups.set(m.provider, g);
 }

 /** 一行模型：行首星标开关 + 点选按钮（选中高亮在整行容器上）。 */
 const row = (m: ModelInfo) => (
  <div
   key={m.selector}
   className={`flex items-center rounded-md ${selected === m.selector ? "bg-active" : ""}`}
  >
   <StarToggle on={starredSet.has(m.selector)} name={m.name} onClick={() => onToggleStar(m.selector)} />
   <button
    onClick={() => onPick(m)}
    aria-pressed={selected === m.selector}
    title={m.selector}
    className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] transition-colors duration-100 hover:bg-hover"
    aria-label={fmt(t.useModelAria, m.name)}
   >
    <span className="min-w-0 flex-1">
     <span className="block truncate">{shortModelName(m)}</span>
     {/* 第二行 = 完整 selector（provider/id）：同名模型来自多家时，只有它能说清是哪一个 */}
     <span className="block truncate font-mono text-[11px] text-faint">{m.selector}</span>
    </span>
    <span className="ml-auto flex shrink-0 gap-1 font-mono text-xs text-muted">
     {m.contextWindow ? <span>{fmtContextWindow(m.contextWindow)}</span> : null}
    </span>
   </button>
  </div>
 );

 return (
  <>
   <input
    ref={inputRef}
    value={q}
    onChange={(e) => setQ(e.target.value)}
    placeholder={t.roleSearchPlaceholder}
    aria-label={t.roleSearchPlaceholder}
    className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
   />
   <div className="mt-2 max-h-[min(50dvh,24rem)] overflow-y-auto">
    {query ? (
     filtered.map(row)
    ) : (
     <>
      {starred.length > 0 && (
       <div>
        <div className="px-2 pt-3 pb-1 text-[11px] text-faint">{t.myModelsSection}</div>
        {starred.map(row)}
       </div>
      )}
      {[...groups].map(([provider, ms]) => (
       <div key={provider}>
        <div className="px-2 pt-3 pb-1 font-mono text-[11px] break-all text-faint">{provider}</div>
        {ms.map(row)}
       </div>
      ))}
     </>
    )}
    {filtered.length === 0 && <div className="p-2 text-[13px] text-muted">{t.noModelMatch}</div>}
   </div>
  </>
 );
}

/**
 * 模型选择弹窗（`DialogShell` 壳 + 上面的列表）：模型角色行、失败转移链的模型对象与转移目标
 * **三处共用**——行内展开会把下方区块整体推下去（点开 / 关上时页面跳动），弹窗不参与文档流。
 *
 * 打开即聚焦搜索框；点选即 `onPick`（调用方负责收起弹窗并落库），Esc / 遮罩 / X 关闭 = 取消。
 * 行首星标（`myModels` + `onToggleStar`）= 加入 / 移出「我的模型」，只改置顶顺序、不收窄候选。
 */
export function ModelPickerDialog({
 title,
 models,
 selected,
 onPick,
 onClose,
 myModels,
 onToggleStar,
}: {
 title: string;
 models: ModelInfo[];
 selected?: string;
 onPick: (m: ModelInfo) => void;
 onClose: () => void;
 myModels: string[];
 onToggleStar: (selector: string) => void;
}) {
 const inputRef = useRef<HTMLInputElement>(null);
 return (
  <DialogShell title={title} onClose={onClose} initialFocusRef={inputRef}>
   <ModelPickList
    models={models}
    selected={selected}
    onPick={onPick}
    inputRef={inputRef}
    myModels={myModels}
    onToggleStar={onToggleStar}
   />
  </DialogShell>
 );
}
