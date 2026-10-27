import { useEffect, useState } from "react";
import { Loader, Refresh } from "reicon-react";
import type { ProviderUsageDisabled, UsageLimit } from "@shared/types";
import { fmt, type Locale } from "../../lib/locale";
import { useText } from "../../lib/useText";
import { useApp } from "../../stores/app";
import { DialogShell } from "../settings/DialogShell";
import {
 disabledCredentialsToWarn,
 formatAgo,
 formatDuration,
 groupReports,
 latestFetchedAt,
 levelOf,
 limitReading,
 loadProviderUsage,
 providersWithoutUsage,
 useProviderUsage,
 windowNames,
 type ProviderGroup,
} from "../../lib/providerUsage";

/**
 * 「供应商用量」弹窗（标签栏右上角 `Gauge` 键的落点）：各供应商侧的滚动窗口（5 小时 / 每周 / 每月…）。
 *
 * 数据只由 omp 拿得到（后端跑 `omp usage --json` 解析后返回，见 `provider_usage.rs`）：
 * 本应用不直连供应商接口、不碰凭证库，**只读**。这里与「使用统计」（本地 jsonl 的
 * token 聚合）是两份不同的东西：那边统计「花了多少」，这边看「还剩多少额度」。
 *
 * - 打开拉一次（60s 内复用模块缓存，反复开合不重拉）+ 面板上的手动刷新；
 * - 失败保留上一份数据（旧值 + 一行错误），不闪空；
 * - 「配了但上游拿不到用量」的供应商显式列出并写明原因——静默少一块比一行说明糟糕得多；
 * - 「已停用的凭据」只提示**非用户主动**的停用（刷新失败 / 上游失效）；登出 / 删除 / 被替换
 *   造成的墓碑不提示（那是用户自己的动作，见 `disabledCredentialsToWarn`）；
 * - 相对时间（更新于 N 前 / N 后重置）每 30 秒推进一次，不随渲染乱跳。
 */
export function ProviderUsageDialog() {
 const t = useText();
 const locale = useApp((s) => s.locale);
 const { data, error, loading } = useProviderUsage();
 /** 「现在」走 state：相对时间不在 render 里读时钟（与 V6 用量浮层同口径）；0 = 还没校准。 */
 const [now, setNow] = useState(0);

 // 打开拉一次（节流内直接复用缓存）；失败由快照里的 error 呈现
 useEffect(() => {
  void loadProviderUsage();
 }, []);

 useEffect(() => {
  const tick = () => setNow(Date.now());
  const first = window.setTimeout(tick, 0);
  const timer = window.setInterval(tick, 30_000);
  return () => {
   window.clearTimeout(first);
   window.clearInterval(timer);
  };
 }, []);

 const groups = groupReports(data?.reports ?? []);
 const missing = providersWithoutUsage(data);
 const disabled = disabledCredentialsToWarn(data);
 const fetched = latestFetchedAt(data);
 const updated = fetched && now ? fmt(t.pusageUpdatedAgo, formatAgo(now - fetched, locale)) : "";

 return (
  <DialogShell
   title={t.pusageTitle}
   width="max-w-2xl"
   onClose={() => useApp.getState().set({ providerUsageOpen: false })}
  >
   <div className="flex flex-wrap items-center gap-2">
    {updated && <span className="font-mono text-[11px] text-faint">{updated}</span>}
    <button
     onClick={() => void loadProviderUsage(true)}
     disabled={loading}
     className="ml-auto flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md bg-background px-3 py-1.5 text-[13px] transition-colors duration-100 hover:bg-hover disabled:opacity-50"
     aria-label={t.refresh}
    >
     {loading ? <Loader size={12} className="animate-spin" aria-hidden /> : <Refresh size={12} aria-hidden />}
     {t.refresh}
    </button>
   </div>
   <p className="mt-2 text-[13px] leading-relaxed text-faint">{t.pusageHint}</p>
   {error && (
    <p role="alert" className="mt-1.5 whitespace-pre-line text-[13px] text-danger">
     {error}
    </p>
   )}

   {!data && !error && <p className="mt-3 text-[13px] text-muted">{t.pusageLoading}</p>}

   {data && groups.length === 0 && (
    <p className="mt-4 rounded-lg bg-background px-4 py-8 text-center text-[13px] leading-relaxed text-muted">
     {t.pusageEmpty}
    </p>
   )}

   {groups.length > 0 && (
    <div className="mt-4 flex flex-col gap-3">
     {groups.map((g) => (
      <ProviderCard key={g.provider} group={g} now={now} locale={locale} />
     ))}
    </div>
   )}

   {missing.length > 0 && (
    <div className="mt-3 rounded-lg bg-background p-3.5">
     <p className="text-[12px] text-muted">{t.pusageNoDataTitle}</p>
     <ul className="mt-1.5 flex flex-col gap-1">
      {missing.map((p) => (
       <li key={p} className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-[12px]">{p}</span>
        <span className="text-[11px] text-faint">{t.pusageNoDataHint}</span>
       </li>
      ))}
     </ul>
    </div>
   )}

   {data && data.extraFailures.length > 0 && (
    <div className="mt-3 rounded-lg border border-warn/30 bg-warn/5 p-3.5">
     <p className="text-[12px] font-medium text-warn">{t.pusageFailedTitle}</p>
     <ul className="mt-1.5 flex flex-col gap-1">
      {data.extraFailures.map((f) => (
       <li key={f.provider} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
        <span className="font-mono">{f.provider}</span>
        <span className="min-w-0 truncate text-faint" title={f.message}>
         {f.message}
        </span>
       </li>
      ))}
     </ul>
    </div>
   )}

   {disabled.length > 0 && <DisabledBlock items={disabled} />}

   {data && data.accountsWithoutUsage.length > 0 && (
    <p className="mt-2 text-[11px] text-faint">{fmt(t.pusageAccountsWithout, data.accountsWithoutUsage.length)}</p>
   )}

   <p className="mt-3 text-[13px] leading-relaxed text-faint">{t.pusageFoot}</p>
  </DialogShell>
 );
}

/** 一个供应商的卡片：header（套餐名 / provider id / 账号数）+ 每账号一组窗口行。 */
function ProviderCard({ group, now, locale }: { group: ProviderGroup; now: number; locale: Locale }) {
 const t = useText();
 const first = group.reports[0];
 const multi = group.reports.length > 1;
 return (
  <div className="rounded-lg bg-background p-3.5">
   <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
    <span className="text-[13px] font-medium">{first.planType ?? first.provider}</span>
    {first.planType && <span className="font-mono text-[11px] text-faint">{first.provider}</span>}
    {multi && <span className="ml-auto text-[11px] text-faint">{fmt(t.pusageAccounts, group.reports.length)}</span>}
   </div>
   {group.reports.map((r, i) => {
    const names = windowNames(t, r.limits);
    return (
     <div key={`${r.provider}#${i}`} className="mt-2">
      {multi && <div className="mb-0.5 text-[11px] text-muted">{r.accountLabel ?? fmt(t.pusageAccountN, i + 1)}</div>}
      {r.limits.length === 0 ? (
       <p className="py-1 text-[12px] text-faint">{t.pusageNoData}</p>
      ) : (
       r.limits.map((l, j) => <LimitRow key={l.id} limit={l} name={names[j]} now={now} locale={locale} />)
      )}
     </div>
    );
   })}
  </div>
 );
}

/**
 * 一个窗口一行：窗口名 + 进度条 + 数值 + 重置倒计时。
 *
 * 数值口径在 `lib/providerUsage.ts` 的 `limitReading`（与输入卡浮层共用同一份）：有比例的
 * 窗口显示百分比（金额细节进悬停提示 `$0.31 / $14.00`）、纯余额窗口显示「$X 剩余」、
 * 计数型窗口显示数量原文——percent 字段缺省是 0，拿它当读数等于编造「0.0%」。
 */
function LimitRow({
 limit,
 name,
 now,
 locale,
}: {
 limit: UsageLimit;
 name: string;
 now: number;
 locale: Locale;
}) {
 const t = useText();
 const { bar, text: main, title, state } = limitReading(t, limit);
 const resets =
  limit.resetsAt !== null && now ? fmt(t.pusageResetsIn, formatDuration(limit.resetsAt - now, locale)) : "";
 return (
  <div className="py-1.5">
   <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
    <span className="w-28 shrink-0 text-[12px] text-muted">{name}</span>
    {bar && <LimitBar limit={limit} className="min-w-24 flex-1" />}
    <span className="ml-auto shrink-0 text-right font-mono text-[12px] tabular-nums" title={title}>
     {main}
    </span>
    <span className="shrink-0 whitespace-nowrap text-right text-[11px] text-faint">{resets}</span>
    <span className="sr-only">{state}</span>
   </div>
   {limit.notes.length > 0 && (
    <p className="mt-0.5 pl-[7.5rem] text-[11px] text-faint">{limit.notes.join(" · ")}</p>
   )}
  </div>
 );
}

/**
 * 一根用量进度条：底槽 + 实心段（纯 CSS，不引图表库）。
 * 配色走语义色并**只在超阈值时才换色**：<80% `accent`、≥80% `warn`、用尽 `danger`。
 */
function LimitBar({ limit, className }: { limit: UsageLimit; className?: string }) {
 const level = levelOf(limit);
 const fill = level === "danger" ? "bg-danger" : level === "warn" ? "bg-warn" : "bg-accent";
 // 超限（>100%）时条仍然铺满，不溢出容器
 const width = Math.min(100, Math.max(0, limit.usedFraction * 100));
 return (
  <span className={`h-1.5 shrink-0 overflow-hidden rounded-sm bg-accent/15 ${className ?? ""}`} aria-hidden>
   <span className={`block h-full rounded-sm transition-[width] duration-150 ${fill}`} style={{ width: `${width}%` }} />
  </span>
 );
}

/**
 * 被自动停用的凭据（刷新失败 / 上游失效）：红字提示需重新登录，否则用户只会看到「额度没了」。
 * 用户主动动作的墓碑（登出 / 删除 / 被替换）不经这里——调用方 `disabledCredentialsToWarn` 已滤掉。
 */
function DisabledBlock({ items }: { items: ProviderUsageDisabled[] }) {
 const t = useText();
 return (
  <div className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-3.5">
   <p className="text-[12px] font-medium text-danger">{t.pusageDisabledTitle}</p>
   <ul className="mt-1.5 flex flex-col gap-1">
    {items.map((d, i) => (
     <li key={`${d.provider}#${i}`} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
      <span className="font-mono">{d.provider}</span>
      {(d.email ?? d.accountId) && <span>{d.email ?? d.accountId}</span>}
      {d.cause && <span className="min-w-0 truncate text-faint" title={d.cause}>{d.cause}</span>}
      <span className="text-faint">{t.pusageDisabledHint}</span>
     </li>
    ))}
   </ul>
  </div>
 );
}
