import { useEffect, useState } from "react";
import { api } from "@shared/api";
import type { SessionStats } from "@shared/types";
import { fmt } from "../../lib/locale";
import { approvalName } from "../../lib/sessionApproval";
import { useText } from "../../lib/useText";
import { useApp } from "../../stores/app";
import { DialogShell } from "../settings/DialogShell";

/**
 * `/status` 会话统计弹窗（对齐 codex `/status`）。
 *
 * 数据来自后端 `get_session_stats`（会话文件逐轮 usage 求和 + 运行时真值），前端只做格式化：
 * 数字一律走 `Intl.NumberFormat` 千分位，token / 成本 / 上下文占用都是 omp 原值，不自算。
 * 开关是 store 的 `statsOpen`，`activeSessionId` 变化时重取（切会话不串数据）。
 * 失败只在弹窗内联一行提示，不弹错——统计读不到不该打断会话。
 */
export function SessionStatsDialog() {
 const t = useText();
 const open = useApp((s) => s.statsOpen);
 const activeSessionId = useApp((s) => s.activeSessionId);
 const setStatsOpen = useApp((s) => s.setStatsOpen);
 const currentModel = useApp((s) => s.currentModel);
 const thinkingLevel = useApp((s) => s.currentRuntime?.thinkingLevel ?? null);
 // 生效档位 = 本会话覆盖优先，否则 omp 全局默认（都读 store 真值，见 `lib/sessionApproval.ts`）；
 // 还没读到就显示「—」，不猜——显示层与 omp 实际生效的档位必须一致。
 const approval = useApp(
  (s) => (activeSessionId ? s.sessionApprovals[activeSessionId] : undefined) ?? s.globalApproval,
 );

 // 加载态与 ContextMeter 同一模式：`loaded` 记「哪个会话的什么结果」，
 // `seen` / `loading` 全派生——effect 里只在 promise 回调里 setState（同步 setState 会触发级联渲染告警）。
 const [loaded, setLoaded] = useState<{ sid: string; stats: SessionStats | null; failed: boolean } | null>(null);
 const seen = loaded?.sid === activeSessionId;
 const stats = seen ? loaded.stats : null;
 const failed = seen ? loaded.failed : false;
 const loading = open && !!activeSessionId && !seen;

 useEffect(() => {
  if (!open || !activeSessionId) return;
  let alive = true;
  const sid = activeSessionId;
  // 每次点开都重拉一次（旧数据继续显示，拉回来再替换，不闪白）；失败也记一条结果。
  void api
   .getSessionStats(sid)
   .then((s) => {
    if (alive) setLoaded({ sid, stats: s, failed: false });
   })
   .catch(() => {
    if (alive) setLoaded({ sid, stats: null, failed: true });
   });
  return () => {
   alive = false;
  };
 }, [open, activeSessionId]);

 if (!open) return null;

 const n = (v: number) => new Intl.NumberFormat().format(v);
 const ctx = stats?.contextUsage;

 return (
  <DialogShell
   title={t.statsTitle}
   onClose={() => setStatsOpen(false)}
   width="max-w-lg"
  >
   {loading && <div className="text-[13px] text-muted">{t.statsLoading}</div>}
   {!loading && failed && <div className="text-[13px] text-danger">{t.statsFailed}</div>}
   {!loading && !failed && stats && (
    <div className="space-y-4 text-[13px]">
     <section className="space-y-1">
      <div className="text-[11px] font-semibold tracking-wide text-faint uppercase">{t.statsMessages}</div>
      <Row label={fmt(t.statsUser, n(stats.userMessages))} />
      <Row label={fmt(t.statsAssistant, n(stats.assistantMessages))} />
      <Row label={fmt(t.statsToolCalls, n(stats.toolCalls))} />
     </section>

     <section className="space-y-1">
      <div className="text-[11px] font-semibold tracking-wide text-faint uppercase">{t.statsTokensTitle}</div>
      <Row label={t.statsInput} value={n(stats.tokens.input)} />
      <Row label={t.statsOutput} value={n(stats.tokens.output)} />
      <Row label={t.statsCacheRead} value={n(stats.tokens.cacheRead)} />
      <Row label={t.statsCacheWrite} value={n(stats.tokens.cacheWrite)} />
      <Row label={t.statsReasoning} value={n(stats.tokens.reasoning)} />
      <Row label={t.statsTotal} value={n(stats.tokens.total)} />
     </section>

     <section className="space-y-1">
      <Row label={t.statsCost} value={`$${stats.cost.toFixed(2)}`} />
      {stats.premiumRequests > 0 && <Row label={fmt(t.statsPremium, n(stats.premiumRequests))} />}
     </section>

     {ctx && (
      <section className="space-y-1">
       <div className="text-[11px] font-semibold tracking-wide text-faint uppercase">{t.statsContext}</div>
       <Row
        label={`${ctx.tokens == null ? "—" : n(ctx.tokens)} / ${ctx.contextWindow == null ? "—" : n(ctx.contextWindow)}`}
        value={ctx.percent == null ? "—" : `${ctx.percent}%`}
       />
      </section>
     )}

     <section className="space-y-1">
      <Row label={t.statsModel} value={currentModel ?? "—"} />
      <Row label={t.statsThinking} value={thinkingLevel ?? "—"} />
      <Row label={t.statsApproval} value={approval ? approvalName(t, approval) : "—"} />
     </section>
    </div>
   )}
  </DialogShell>
 );
}

/** 一行「标签 / 值」；无值时只占左列（如消息计数已拼进标签）。 */
function Row({ label, value }: { label: string; value?: string }) {
 if (value === undefined) return <div className="text-foreground">{label}</div>;
 return (
  <div className="flex items-baseline gap-3">
   <span className="text-muted">{label}</span>
   <span className="ml-auto font-mono text-foreground">{value}</span>
  </div>
 );
}
