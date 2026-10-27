import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Gauge, Loader, Refresh } from "reicon-react";
import type { UsageLimit } from "@shared/types";
import { fmt } from "../../lib/locale";
import {
 formatAgo,
 formatDuration,
 latestFetchedAt,
 levelOf,
 limitReading,
 loadProviderUsage,
 providersWithoutUsage,
 useProviderUsage,
 windowNames,
} from "../../lib/providerUsage";
import { useDropdown } from "../../lib/useDropdown";
import { usePopoverAnchor } from "../../lib/usePopoverAnchor";
import { USAGE_REFRESH_MS, entryGlance, hasUsageEntry, usageEntryDisabled } from "../../lib/usageLimits";
import { useText } from "../../lib/useText";
import { useApp } from "../../stores/app";

/**
 * 供应商用量（**输入卡底部统计条**的最后一项；2026-10-14 与上下文容量环一起从顶栏右端搬进输入卡，
 * 2026-10-16 从工具行挪进统计条）：条上**只有一个图标**（配色档跟着最紧的窗口），点开是各窗口的进度条与明细。
 *
 * 这里看的是 **opencode 网站那种 5 小时 / 每周 / 每月限额**（供应商配额），不是本地 token 统计
 * （那个在 设置 › 使用统计），也不是上下文窗口占用（那个是同排的 `ContextMeter`）。
 * 数据只由 omp 拿得到：后端跑 `omp usage --json` 解析后返回（与供应商页走 `omp auth-broker` 同款），
 * 壳侧不直连配额 API、不碰凭证库，也不做任何聚合。
 *
 * - 口径（2026-10-14 用户口径）：看的是**我配置的供应商**，与当前会话在用哪个模型无关——
 *   不再按 `currentModel` 的供应商过滤/排序；
 * - 条上形态（2026-10-16 修订用户口径）：**只留图标**，读数与窗口名一律下沉——完整读数在**悬停提示**
 *   与**浮层**里（浮层列出全部窗口的读数 + 重置倒计时 + 更新时间）。最紧的窗口到 warn / danger 档时
 *   图标换色（条上不再有数字，颜色是这一项唯一的档位信号，所以图标必须始终可辨、不置灰以外的降级）；
 * - 展开态（2026-10-21 重做）：按供应商分卡片，每张卡里逐窗口列出名称 / 读数 / 重置倒计时。有比例的
 *   窗口用**两行**——名称 + 重置在第一行，进度条占满整行宽度、百分比贴右（老的单行布局把条挤在
 *   固定宽度的名称与倒计时之间，只剩一小截，百分比与倒计时之间又空出一大段）；纯余额窗口一行放完。
 *   读数口径与设置页弹窗共用 `limitReading`——有比例的显示百分比、余额型窗口显示「$X 剩余」。
 * - 一份配额都拿不到（一个供应商都没配）时**整块不渲染**；但「配了供应商、上游却拿不到用量」
 *   （如 omp 未实现探针的供应商）会**显式列出**并写明原因，补充探针失败也会给一行警示——
 *   沉默比一个置灰按钮糟得多；
 * - 刷新：启动拉一次、页面可见时每 5 分钟一次、打开浮层强制一次（失败保留旧值 + 一行错误）。
 */

/** 「配了但拿不到用量」最多列几个，其余折叠成一行（供应商多时不把浮层撑长）。 */
const MISSING_MAX = 4;

export function UsageLimits() {
 const t = useText();
 const locale = useApp((s) => s.locale);
 // 数据层统一在 lib/providerUsage.ts（模块级快照；设置页「供应商用量」弹窗同一份）
 const { data: usage, error, loading } = useProviderUsage();
 const composerMenu = useApp((s) => s.composerMenu);
 const open = composerMenu === "usage";
 const setOpen = useCallback((v: boolean) => useApp.setState({ composerMenu: v ? "usage" : null }), []);
 const ref = useDropdown(open, () => setOpen(false));
 // 浮层贴**被点的项**（不是贴条缘——贴条缘会离靠左的项很远），见 `lib/usePopoverAnchor`
 const { anchorRef, panelRef } = usePopoverAnchor<HTMLButtonElement>(open);
 // 「现在」走 state：相对时间（更新于 N 前 / N 后重置）不在 render 里读时钟，
 // 每 30 秒推进一次——浮层开着时读数自己会走，`0` 表示还没校准过（首帧不显示相对时间）。
 const [now, setNow] = useState(0);

 useEffect(() => {
  const tick = () => setNow(Date.now());
  const first = window.setTimeout(tick, 0);
  const timer = window.setInterval(tick, 30_000);
  return () => {
   window.clearTimeout(first);
   window.clearInterval(timer);
  };
 }, []);

 // 打开即拉最新（看到的就是当下的额度，而不是上次关浮层时的旧值）
 useEffect(() => {
  if (open) void loadProviderUsage(true);
 }, [open]);

 // 常驻：挂载拉一次 + 每 5 分钟一次（页面不可见时跳过，切回来再补一次）
 useEffect(() => {
  void loadProviderUsage();
  const tick = () => {
   if (document.visibilityState === "visible") void loadProviderUsage();
  };
  const timer = window.setInterval(tick, USAGE_REFRESH_MS);
  document.addEventListener("visibilitychange", tick);
  return () => {
   window.clearInterval(timer);
   document.removeEventListener("visibilitychange", tick);
  };
 }, []);

 // 没有任何可显示内容时不占位（配额是可选面：一个供应商都没配、也没出过错就没有入口）；
 // 但「配了供应商、上游却没给用量」与查询失败都要渲染——沉默比一个置灰按钮糟得多
 if (!hasUsageEntry(usage, error)) return null;

 // 全都按上游顺序直出：不按当前模型重排、不按当前模型过滤（那是 2026-10-14 修掉的老口径）
 const { level } = entryGlance(usage);
 const reports = usage?.reports ?? [];
 const missing = providersWithoutUsage(usage);
 const failures = usage?.extraFailures ?? [];
 const resetIn = (at: number | null): string =>
  now && at ? fmt(t.usageLimitsResets, formatDuration(at - now, locale)) : "";
 const fetched = latestFetchedAt(usage);
 const updated = now && fetched ? fmt(t.usageLimitsUpdatedAgo, formatAgo(now - fetched, locale)) : "";
 /** 一眼摘要（悬停提示 / 读屏）：家名 + 窗口 + 读数，全部供应商的窗口都列上。 */
 const summary = reports
  .flatMap((r) => {
   const names = windowNames(t, r.limits);
   return r.limits.map((l, i) => `${r.provider} ${names[i]} ${limitReading(t, l).text}`);
  })
  .join("、");
 // 置灰口径：一次都没拿到数据且最近一次查询失败（某一家没探针不影响别家，不置灰）
 const disabledReason = usageEntryDisabled(usage, error);
 const unavailable = disabledReason !== null;
 const aria = summary ? fmt(t.usageLimitsAriaAll, summary) : t.usageLimitsTitle;
 const title = unavailable ? fmt(t.usageLimitsFailedTitle, error ?? "") : aria;
 // 图标配色：最紧的窗口到哪一档（<80% 中性、≥80% warn、用尽 danger）
 const iconTone = level === "danger" ? "text-danger" : level === "warn" ? "text-warn" : "";
 return (
  <div ref={ref}>
   <button
    ref={anchorRef}
    onClick={() => setOpen(!open)}
    disabled={unavailable}
    className={`flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 whitespace-nowrap transition-colors duration-100 ${
     unavailable ? "cursor-default opacity-40" : "cursor-pointer hover:bg-hover"
    }`}
    aria-label={unavailable ? title : aria}
    aria-expanded={open}
    title={title}
   >
    {/* 2026-10-16 修订口径：条上**只有图标**（配色档由最紧的窗口定，warn / danger 换色）——
        读数与窗口名不再铺在条上，只在悬停提示与浮层里 */}
    <Gauge size={13} aria-hidden className={`shrink-0 ${iconTone || "text-muted"}`} />
   </button>
   {open && (
    <div
     ref={panelRef}
     className="absolute right-0 bottom-full z-10 mb-1 w-96 max-w-full overflow-hidden rounded-lg border border-border bg-elevated shadow-pop"
    >
     {/* 头部：标题 + 更新时间 + 刷新。标题是 13px 正文色，更新时间降一档走到 faint——
         老版把两者挤成同一行 11px muted，扫读时分不出主次 */}
     <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
      <span className="shrink-0 text-[13px] font-medium">{t.usageLimitsTitle}</span>
      {updated && (
       <>
        <span aria-hidden className="text-[11px] text-faint/60">
         ·
        </span>
        <span className="min-w-0 truncate text-[11px] text-faint" title={updated}>
         {updated}
        </span>
       </>
      )}
      <button
       onClick={() => void loadProviderUsage(true)}
       disabled={loading}
       className="-mr-1 ml-auto flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground disabled:opacity-50"
       aria-label={t.refresh}
       title={t.refresh}
      >
       {loading ? <Loader size={12} className="animate-spin" aria-hidden /> : <Refresh size={12} aria-hidden />}
      </button>
     </div>
     <div className="max-h-[min(60vh,26rem)] overflow-y-auto overscroll-contain px-2 pb-2">
      {error && (
       <p
        role="alert"
        className="mx-0.5 mb-2 rounded-md border border-danger/20 bg-danger/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-danger"
       >
        {error}
       </p>
      )}
      {loading && !usage && <p className="px-1 py-3 text-[12px] text-muted">{t.usageLimitsLoading}</p>}
      <div className="flex flex-col gap-1.5">
       {reports.map((r, ri) => {
        // 窗口名整组一起算（同一份报告里重名时补区分），与设置页卡片同口径
        const names = windowNames(t, r.limits);
        // 同一 provider 多账号时补账号标识（单账号不占位；与设置页弹窗口径一致）
        const multi = reports.filter((x) => x.provider === r.provider).length > 1;
        return (
         <section
          key={`${r.provider}#${ri}`}
          data-provider={r.provider}
          className="rounded-md border border-border-soft bg-background px-2.5 py-2"
         >
          <div className="flex items-baseline gap-1.5 pb-1">
           <span className="min-w-0 truncate text-[12px] font-medium" title={r.provider}>
            {r.planType ?? r.provider}
           </span>
           {r.planType && (
            <span className="min-w-0 truncate font-mono text-[11px] text-faint" title={r.provider}>
             {r.provider}
            </span>
           )}
           {multi && r.accountLabel && (
            <span
             className="ml-auto min-w-0 truncate font-mono text-[10.5px] text-faint"
             title={r.accountLabel}
            >
             {r.accountLabel}
            </span>
           )}
          </div>
          {r.limits.length === 0 ? (
           <p className="py-1 text-[11px] text-faint">{t.usageLimitsNoData}</p>
          ) : (
           r.limits.map((l, i) => (
            <LimitLine key={l.id} limit={l} name={names[i]} reset={resetIn(l.resetsAt)} />
           ))
          )}
         </section>
        );
       })}
      </div>
      {/* 配了供应商、但 omp 拿不到它的用量（没实现探针）：显式列出来 + 讲清原因，
          否则用户只会看到「我配的那个供应商不见了」。最多列 4 个，其余折叠成一行。 */}
      {missing.length > 0 && (
       <div data-block="missing" className="mt-1.5 rounded-md border border-border-soft px-2.5 py-2">
        <div className="flex items-baseline gap-2">
         <span className="shrink-0 text-[11px] text-muted">{t.usageLimitsNoData}</span>
         <span className="min-w-0 truncate font-mono text-[11px] text-faint" title={missing.join("、")}>
          {missing.slice(0, MISSING_MAX).join("、")}
         </span>
        </div>
        {missing.length > MISSING_MAX && (
         <p className="pt-0.5 text-[10.5px] text-faint">
          {fmt(t.usageLimitsNoDataMore, missing.length - MISSING_MAX)}
         </p>
        )}
        <p className="pt-1 text-[10.5px] leading-relaxed text-faint">{t.usageLimitsNoDataHint}</p>
       </div>
      )}
      {/* 补充探针失败（能查但这次没查到）：与「没有查询路径」分开说，别让用户以为供应商丢了 */}
      {failures.length > 0 && (
       <div data-block="failures" className="mt-1.5 rounded-md border border-warn/25 bg-warn/5 px-2.5 py-2">
        <div className="flex items-center gap-1.5 pb-1 text-[11px] font-medium text-warn">
         <AlertTriangle size={11} aria-hidden className="shrink-0" />
         {t.usageLimitsQueryFailed}
        </div>
        {failures.map((f) => (
         <div key={f.provider} className="flex items-baseline gap-2 py-0.5">
          <span className="shrink-0 font-mono text-[11px] text-warn">{f.provider}</span>
          <span className="min-w-0 truncate text-[10.5px] text-faint" title={f.message}>
           {f.message}
          </span>
         </div>
        ))}
       </div>
      )}
      {usage && usage.accountsWithoutUsage.length > 0 && (
       <p className="px-1 pt-1.5 text-[10.5px] text-faint">
        {fmt(t.usageLimitsAccountsWithout, usage.accountsWithoutUsage.length)}
       </p>
      )}
     </div>
    </div>
   )}
  </div>
 );
}

/**
 * 一个窗口：有比例的两行（名称 + 重置 / 进度条 + 百分比），纯余额一行。
 *
 * 数值口径与设置页弹窗同源（`limitReading`）：百分比窗口画条 + 百分比，
 * 余额型窗口只给金额（「$X 剩余」），计数型给数量原文——percent 缺省 0 不是读数。
 * 百分比在 warn / danger 时跟着换色（数字本身仍在，颜色不作唯一信号）。
 */
function LimitLine({ limit, name, reset }: { limit: UsageLimit; name: string; reset: string }) {
 const t = useText();
 const reading = limitReading(t, limit);
 const valueTone =
  reading.level === "danger" ? "text-danger" : reading.level === "warn" ? "text-warn" : "text-foreground";
 if (!reading.bar) {
  return (
   <div data-window={limit.windowId} data-bar="false" className="flex items-baseline gap-2 py-1">
    <span className="min-w-0 truncate text-[12px] text-muted" title={name}>
     {name}
    </span>
    {reset && <span className="shrink-0 whitespace-nowrap text-[10.5px] text-faint">{reset}</span>}
    <span
     className={`ml-auto shrink-0 font-mono text-[12px] tabular-nums ${valueTone}`}
     title={reading.title}
    >
     {reading.text}
    </span>
   </div>
  );
 }
 return (
  <div data-window={limit.windowId} data-bar="true" className="py-1">
   <div className="flex items-baseline gap-2">
    <span className="min-w-0 truncate text-[12px] text-muted" title={name}>
     {name}
    </span>
    {reset && <span className="ml-auto shrink-0 whitespace-nowrap text-[10.5px] text-faint">{reset}</span>}
   </div>
   <div className="mt-1 flex items-center gap-2">
    <LimitBar limit={limit} className="min-w-0 flex-1" />
    <span
     className={`w-11 shrink-0 text-right font-mono text-[12px] tabular-nums ${valueTone}`}
     title={reading.title}
    >
     {reading.text}
    </span>
   </div>
  </div>
 );
}

/**
 * 一根配额进度条：底槽 + 实心段（纯 CSS，不引图表库）。
 * 配色走语义色并**只在超阈值时才换色**：<80% `accent`、≥80% `warn`、用尽 `danger`
 * ——颜色之外还有百分比数字，颜色不作唯一信号。
 */
function LimitBar({ limit, className }: { limit: UsageLimit; className?: string }) {
 const level = levelOf(limit);
 const fill = level === "danger" ? "bg-danger" : level === "warn" ? "bg-warn" : "bg-accent";
 // 超限（>100%）时条仍然铺满，不溢出容器
 const width = Math.min(100, Math.max(0, limit.usedFraction * 100));
 return (
  <span
   className={`block h-1.5 shrink-0 overflow-hidden rounded-full bg-foreground/10 ${className ?? ""}`}
   aria-hidden
  >
   <span
    className={`block h-full rounded-full transition-[width] duration-200 ${fill}`}
    style={{ width: `${width}%` }}
   />
  </span>
 );
}
