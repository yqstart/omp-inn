import { useEffect, useRef, useState } from "react";
import { QuoteDownSquare } from "reicon-react";
import { api } from "@shared/api";
import { useApp } from "../../stores/app";
import { fmt } from "../../lib/locale";
import { useText } from "../../lib/useText";
import type { AskQuestion, ViewMsg } from "@shared/types";

/**
 * 通用 UI 请求卡（非审批）：omp 的 `confirm` / `input` / `editor` / 非审批 `select`。
 *
 * 与 `ApprovalCard` 的分工：审批 = `select(options 含 Approve)`，回包是 `{value:"Approve"}` /
 * `{cancelled:true}`，且「总是允许」要写会话级 yolo 意向；本卡回包按方法走
 * `respond_ui`（`confirm` → `{confirmed}`，`input`/`editor`/`select` → `{value}`，取消 → `{cancelled}`）。
 * 两者都是「agent 在等你」，出现即滚入视野、等待期间 composer 锁定。
 */
type AskDraft = { selected: string[]; custom: string };
/** 未作答的题草稿（只读默认值；任何写入都走新对象，绝不原地改）。 */
const EMPTY_DRAFT: AskDraft = { selected: [], custom: "" };

export function UiRequestCard({ m, sessionId }: { m: Extract<ViewMsg, { kind: "ui" }>; sessionId: string }) {
 const { statusBySession } = useApp();
 const t = useText();
 const [text, setText] = useState(m.prefill ?? "");
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState<string | null>(null);
 // ask：已提交答案（终态，表单收起）；每题的勾选 / 自由输入草稿
 const [asked, setAsked] = useState(false);
 const [askState, setAskState] = useState<Record<string, AskDraft>>({});
 const [remaining, setRemaining] = useState(m.method === "ask" ? (m.timeout ?? 0) : 0);
 const ref = useRef<HTMLDivElement>(null);
 // 与审批卡同规矩：请求出现时必须带进视野（长会话里可能落在视口之外）
 useEffect(() => {
  ref.current?.scrollIntoView({ block: "nearest" });
 }, []);
 // ask 的超时倒计时：每秒减 1s，到 0 / 卸载即清理（到 0 只停表——omp 侧按推荐项继续并推 cancel 帧撤卡）
 useEffect(() => {
  if (remaining <= 0) return;
  const timer = setTimeout(() => setRemaining((r) => Math.max(0, r - 1000)), 1000);
  return () => clearTimeout(timer);
 }, [remaining]);
 const waiting = statusBySession[sessionId]?.state !== "awaiting-approval";

 const reply = async (
  kind: "value" | "confirm" | "cancel",
  opts?: { value?: string; confirmed?: boolean },
 ) => {
  setBusy(true);
  setError(null);
  try {
   await api.respondUi(sessionId, m.uiId, kind, opts);
  } catch (e) {
   setError(e instanceof Error ? e.message : t.uiFailed);
  } finally {
   setBusy(false);
  }
 };

 const submitValue = () => {
  if (m.method !== "confirm") void reply("value", { value: text });
 };
 // ── ask：多问题卡 ───────────────────────────────────────────────────────────
 const questions: AskQuestion[] = m.questions ?? [];
 // 单选 = radio（点别的选项即替换；再点已选项保持选中）；多选 = 在已选集合上增删
 const pickOption = (q: AskQuestion, label: string) => {
  setAskState((s) => {
   const cur = s[q.id] ?? EMPTY_DRAFT;
   const selected = q.multi
    ? cur.selected.includes(label)
     ? cur.selected.filter((x) => x !== label)
     : [...cur.selected, label]
    : [label];
   return { ...s, [q.id]: { ...cur, selected } };
  });
 };
 // 单选：自定义输入与选项互斥（输入即清掉已选）；多选：可与选项并存
 const typeCustom = (q: AskQuestion, v: string) => {
  setAskState((s) => {
   const cur = s[q.id] ?? EMPTY_DRAFT;
   return { ...s, [q.id]: { selected: q.multi ? cur.selected : [], custom: v } };
  });
 };
 const submitAnswers = async () => {
  if (busy) return;
  setBusy(true);
  setError(null);
  try {
   const answers = questions.map((q) => {
    const st = askState[q.id] ?? EMPTY_DRAFT;
    const customInput = st.custom.trim();
    return {
     id: q.id,
     selectedOptions: [...st.selected],
     ...(customInput ? { customInput } : {}),
    };
   });
   await api.respondUi(sessionId, m.uiId, "answers", { answers });
   setAsked(true);
  } catch (e) {
   setError(e instanceof Error ? e.message : t.uiFailed);
  } finally {
   setBusy(false);
  }
 };
 const mmss = (ms: number) => {
  const total = Math.ceil(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
 };
 const onAskKeyDown = (e: React.KeyboardEvent) => {
  if (e.key === "Enter" && !e.shiftKey) {
   e.preventDefault();
   void submitAnswers();
  }
 };
 const onKeyDown = (e: React.KeyboardEvent) => {
  if (e.key === "Escape") {
   e.preventDefault();
   void reply("cancel");
   return;
  }
  // input：Enter 直接提交；editor：Cmd/Ctrl+Enter 提交，单独 Enter 留给换行
  const plainEnter = e.key === "Enter" && !e.shiftKey && (m.method === "input" || e.metaKey || e.ctrlKey);
  if (plainEnter) {
   e.preventDefault();
   submitValue();
  }
 };

 const btn = "cursor-pointer rounded-md px-3.5 py-1.5 text-[13px] transition-colors duration-100 disabled:opacity-50";
 const primary = `${btn} bg-accent font-medium text-white hover:opacity-90`;
 const ghost = `${btn} border border-border hover:bg-hover`;

 return (
  <div
   ref={ref}
   role="group"
   aria-label={m.title || t.uiNeedsInput}
   className={`rounded-lg border bg-surface p-3.5 ${asked ? "border-border" : "border-accent/50"}`}
  >
   <div className="flex items-center gap-2">
    <QuoteDownSquare size={15} className="text-accent" aria-hidden />
    <span className="text-sm font-medium">{m.title || t.uiNeedsInput}</span>
    {m.method === "ask" && m.timeout != null && remaining > 0 && !asked && (
     <span className="ml-auto shrink-0 text-[12px] text-muted" title={t.askTimeoutNote}>
      {fmt(t.askTimeout, mmss(remaining))}
     </span>
    )}
   </div>
   {m.message && (
    <div className="mt-1.5 rounded-md bg-code px-2.5 py-2 text-[13px] whitespace-pre-wrap">{m.message}</div>
   )}
   {m.method === "input" && (
    <input
     value={text}
     onChange={(e) => setText(e.target.value)}
     onKeyDown={onKeyDown}
     placeholder={m.placeholder ?? ""}
     aria-label={m.title || t.uiInput}
     autoFocus
     disabled={busy}
     className="mt-2 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-accent/70"
    />
   )}
   {m.method === "editor" && (
    <textarea
     value={text}
     onChange={(e) => setText(e.target.value)}
     onKeyDown={onKeyDown}
     rows={5}
     aria-label={m.title || t.uiEdit}
     autoFocus
     disabled={busy}
     className="mt-2 w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs leading-5 outline-none focus:border-accent/70"
    />
   )}
   {m.method === "ask" && !asked && (
    <div className="mt-2 flex flex-col gap-3">
     {questions.map((q) => {
      const draft = askState[q.id] ?? EMPTY_DRAFT;
      const multi = q.multi === true;
      return (
       <div key={q.id} role={multi ? "group" : "radiogroup"} aria-label={q.header || q.question}>
        {q.header && <div className="text-[13px] font-medium text-muted">{q.header}</div>}
        <div className="mt-1 text-[13px] whitespace-pre-wrap">{q.question}</div>
        <div className="mt-2 flex flex-col gap-1.5">
         {q.options.map((opt, i) => {
          const on = draft.selected.includes(opt.label);
          return (
           <button
            key={opt.label}
            type="button"
            role={multi ? "checkbox" : "radio"}
            aria-checked={on}
            disabled={busy}
            onClick={() => pickOption(q, opt.label)}
            className={`cursor-pointer rounded-md border px-2.5 py-1.5 text-left text-[13px] transition-colors duration-100 disabled:opacity-50 ${
             on ? "border-accent bg-accent/10 text-accent" : "border-border hover:bg-hover"
            }`}
           >
            <span className="flex flex-wrap items-center gap-1.5">
             <span>{opt.label}</span>
             {i === q.recommended && (
              <span className="rounded-sm border border-accent/40 px-1 text-[11px] text-accent">
               {t.askRecommended}
              </span>
             )}
            </span>
            {opt.description && <span className="mt-0.5 block text-[12px] text-muted">{opt.description}</span>}
           </button>
          );
         })}
        </div>
        <input
         value={draft.custom}
         onChange={(e) => typeCustom(q, e.target.value)}
         onKeyDown={onAskKeyDown}
         placeholder={t.askCustomPlaceholder}
         aria-label={q.header || q.question}
         disabled={busy}
         className="mt-1.5 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-accent/70"
        />
        {multi && <div className="mt-1 text-[12px] text-muted">{t.askMultiHint}</div>}
       </div>
      );
     })}
    </div>
   )}
   <div className="mt-2.5 flex flex-wrap items-center gap-2">
    {m.method === "confirm" && (
     <>
      <button
       className={primary}
       autoFocus
       disabled={busy}
       onClick={() => void reply("confirm", { confirmed: true })}
      >
       {t.confirm}
      </button>
      <button className={ghost} disabled={busy} onClick={() => void reply("confirm", { confirmed: false })}>
       {t.cancel}
      </button>
     </>
    )}
    {(m.method === "input" || m.method === "editor") && (
     <>
      <button className={primary} disabled={busy} onClick={submitValue}>
       {busy ? t.uiSending : t.uiSubmit}
      </button>
      <button className={ghost} disabled={busy} onClick={() => void reply("cancel")}>
       {t.uiSkip}
      </button>
     </>
    )}
    {m.method === "select" &&
     (m.options ?? []).map((opt, i) => {
      const detail = m.optionDetails?.[i];
      return (
       <button
        key={opt}
        className={`${ghost} flex-col items-start gap-0.5`}
        disabled={busy}
        onClick={() => void reply("value", { value: opt })}
        title={detail ?? opt}
       >
        <span>{opt}</span>
        {detail && <span className="text-[13px] text-muted">{detail}</span>}
       </button>
      );
     })}
    {m.method === "select" && (
     <button className={ghost} disabled={busy} onClick={() => void reply("cancel")}>
      {t.cancel}
     </button>
    )}
    {m.method === "editor" && <span className="text-[13px] text-muted">{t.uiEditorHint}</span>}
    {m.method === "ask" && !asked && (
     <button className={primary} disabled={busy} onClick={() => void submitAnswers()}>
      {busy ? t.uiSending : t.askSubmit}
     </button>
    )}
   </div>
   {m.method === "ask" && asked && <div className="mt-1.5 text-[13px] text-ok">{t.askAnswered}</div>}
   {error && <div className="mt-1.5 text-[13px] text-danger">{error}</div>}
   {waiting && !error && <div className="mt-1.5 text-[13px] text-muted">{t.uiWaiting}</div>}
  </div>
 );
}
