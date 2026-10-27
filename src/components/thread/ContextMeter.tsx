import { useCallback, useEffect, useState } from "react";
import { api } from "@shared/api";
import type { ContextBreakdown, ContextPartId } from "@shared/types";
import { contextPercent, fmtPercent, fmtTokens } from "../../lib/ctxUsage";
import { fmt, type Text } from "../../lib/locale";
import { useDropdown } from "../../lib/useDropdown";
import { usePopoverAnchor } from "../../lib/usePopoverAnchor";
import { useText } from "../../lib/useText";
import { useApp } from "../../stores/app";

/**
 * 上下文容量（**输入卡底部统计条**的第三项，2026-10-14 从顶栏右端搬进输入卡、2026-10-16 从工具行
 * 挪进统计条）：容量环 + 点开的分项面板。
 *
 * 数据来自后端 `get_context_breakdown`（读一次会话文件 + 运行时的 `get_state` 真值），
 * 这里只做格式化与按比例画柱——**不自算 token**，分项与总量都由后端给。
 * 「已用 / 窗口 / 消息」是 omp 真值，非消息各档是按字符量估算后对齐到真值的（后端口径），
 * 面板底部明写了这一点：宁可说清是估算，也不让估算看起来像读数。
 *
 * 触发按钮只画环与百分比，数据取自 `omp-state` 真值（关着也是活的，不用先点开）；
 * 面板内容按需拉取，切会话不会串数据（缓存按会话 id 归属）；面板朝**上**展开
 * （输入卡在窗口底部，只往消息流那侧开）。
 */

/** 分项透明度档：按行序递减，与栈式进度条一一对应（单强调色约束，不引第二色）。 */
const TIERS = [
 "bg-accent",
 "bg-accent/80",
 "bg-accent/65",
 "bg-accent/50",
 "bg-accent/40",
 "bg-accent/30",
];

/** 压缩入口的阈值同款：占用 ≥80% 时容量环转 warn 色（颜色之外还有百分比数字，不作唯一信号）。 */
const WARN_PCT = 80;

function partLabel(t: Text, id: ContextPartId): string {
 switch (id) {
  case "messages":
   return t.ctxPartMessages;
  case "systemPrompt":
   return t.ctxPartSystemPrompt;
  case "skills":
   return t.ctxPartSkills;
  case "tools":
   return t.ctxPartTools;
  case "mcpTools":
   return t.ctxPartMcpTools;
  case "systemContext":
   return t.ctxPartSystemContext;
 }
}

/** 容量环：conic-gradient 画进度 + 径向遮罩掏空中心（纯 CSS，与全项目图表同规矩，不引库）。 */
function Ring({ pct, warn }: { pct: number; warn: boolean }) {
 return (
  <span
   aria-hidden
   className={`block h-3.5 w-3.5 shrink-0 rounded-full transition-colors duration-100 ${warn ? "text-warn" : "text-accent"}`}
   style={{
    background: `conic-gradient(currentColor ${Math.min(100, Math.max(0, pct)) * 3.6}deg, var(--color-border) 0deg)`,
    mask: "radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))",
    WebkitMask: "radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))",
   }}
  />
 );
}

export function ContextMeter() {
 const t = useText();
 const locale = useApp((s) => s.locale);
 const activeSessionId = useApp((s) => s.activeSessionId);
 const live = useApp((s) => s.currentRuntime?.contextUsage);
 const open = useApp((s) => s.composerMenu === "context");
 const setOpen = useCallback(
  (v: boolean) => useApp.setState({ composerMenu: v ? "context" : null }),
  [],
 );
 const ref = useDropdown(open, () => setOpen(false));
 // 浮层贴**被点的项**（不是贴条缘——贴条缘会离靠左的项很远），见 `lib/usePopoverAnchor`
 const { anchorRef, panelRef } = usePopoverAnchor<HTMLButtonElement>(open);
 // 分项按会话归属缓存：切走再回来不闪空、切到别的会话绝不串数据；
 // 每次点开都重拉一次（旧数据先显示着，拉回来再替换，不闪白）。
 // 失败也记一条 `data: null`，否则「读不到」会被当成「还在读」。
 const [loaded, setLoaded] = useState<{ sid: string; data: ContextBreakdown | null } | null>(null);
 const seen = loaded?.sid === activeSessionId;
 const data = seen ? loaded.data : null;
 const loading = open && !!activeSessionId && !seen;

 useEffect(() => {
  if (!open || !activeSessionId) return;
  let alive = true;
  const sid = activeSessionId;
  void api
   .getContextBreakdown(sid)
   .then((d) => {
    if (alive) setLoaded({ sid, data: d });
   })
   .catch(() => {
    // 拿不到就退回只用 omp-state 真值画总量条，不弹错
    if (alive) setLoaded({ sid, data: null });
   });
  return () => {
   alive = false;
  };
 }, [open, activeSessionId]);

 const numLocale = locale === "zh-CN" ? "zh-CN" : "en-US";
 const used = data?.usedTokens ?? live?.tokens ?? null;
 const window_ = data?.contextWindow ?? live?.contextWindow ?? null;
 const pct = contextPercent({
  tokens: used,
  contextWindow: window_,
  percent: data?.percent ?? live?.percent ?? null,
 });
 if (pct == null) return null; // 没有 omp 真值就整块不渲染（与状态条同规矩）
 const warn = pct >= WARN_PCT;
 const parts = data?.parts ?? [];
 const hit = data?.cache.hitRate ?? null;

 return (
  <div ref={ref}>
   <button
    ref={anchorRef}
    onClick={() => useApp.setState({ composerMenu: open ? null : "context" })}
    className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 whitespace-nowrap transition-colors duration-100 hover:bg-hover"
    aria-label={fmt(t.ctxTriggerAria, fmtPercent(pct))}
    aria-expanded={open}
    title={t.ctxTriggerTitle}
   >
    <Ring pct={pct} warn={warn} />
    <span className={`font-mono tabular-nums ${warn ? "text-warn" : "text-muted"}`}>
     {fmtPercent(pct)}
    </span>
   </button>
   {open && (
    <div
     ref={panelRef}
     className="absolute right-0 bottom-full z-10 mb-1 w-80 max-w-full rounded-lg border border-border bg-elevated p-3 shadow-pop"
     aria-label={t.ctxTitle}
    >
     <div className="flex items-baseline justify-between gap-2">
      <span className="text-[13px] font-semibold">{t.ctxTitle}</span>
      <span className="font-mono text-[11px] text-muted tabular-nums">
       {used != null && window_
        ? `${fmtTokens(used, numLocale)}/${fmtTokens(window_, numLocale)}${fmt(t.ctxPercentOf, fmtPercent(pct))}`
        : fmtPercent(pct)}
      </span>
     </div>
     {/* 总量条：分段按窗口占比堆叠，段序与下方分项行一一对应；
         拿不到窗口或分项时退回单段（只用 omp-state 的百分比真值） */}
     <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-accent/15">
      {window_ && parts.length > 0 ? (
       parts.map((p, i) => (
        <span
         key={p.id}
         className={TIERS[Math.min(i, TIERS.length - 1)]}
         style={{ width: `${Math.min(100, (p.tokens / window_) * 100)}%` }}
        />
       ))
      ) : (
       <span className="bg-accent" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      )}
     </div>
     {loading && !data && <div className="pt-2 text-[13px] text-muted">{t.ctxLoading}</div>}
     {!loading && parts.length === 0 && (
      <p className="pt-2 text-[11px] text-faint">{t.ctxNoParts}</p>
     )}
     {parts.length > 0 && (
      <div className="mt-2 flex flex-col gap-1">
       {parts.map((p, i) => (
        <div key={p.id} className="flex items-center gap-2 text-[13px]">
         <span
          aria-hidden
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${TIERS[Math.min(i, TIERS.length - 1)]}`}
         />
         <span className="text-muted">{partLabel(t, p.id)}</span>
         <span className="ml-auto font-mono text-[11px] text-faint tabular-nums">
          {window_ ? fmtPercent((p.tokens / window_) * 100) : ""}
         </span>
         <span className="w-14 text-right font-mono text-[11px] text-muted tabular-nums">
          {fmtTokens(p.tokens, numLocale)}
         </span>
        </div>
       ))}
      </div>
     )}
     {hit != null && (
      <div className="mt-2 flex items-center gap-2 border-t border-border-soft pt-2">
       <span className="text-[13px] text-muted">{t.ctxCacheHit}</span>
       <span
        className="ml-auto font-mono text-[11px] text-foreground tabular-nums"
        title={fmt(
         t.ctxCacheReadTitle,
         fmtTokens(data?.cache.cacheRead ?? 0, numLocale),
         fmtTokens(data?.cache.input ?? 0, numLocale),
         fmtTokens(data?.cache.cacheWrite ?? 0, numLocale),
        )}
       >
        {(hit * 100).toFixed(1)}%
       </span>
      </div>
     )}
    </div>
   )}
  </div>
 );
}
