import { useEffect, useRef } from "react";
import { ArrowUp, X } from "reicon-react";
import type { BtwTurn } from "@shared/types";
import { useApp } from "../../stores/app";
import { useText } from "../../lib/useText";
import { fmt, type Text } from "../../lib/locale";
import { askBtw, cancelBtw } from "../../lib/btw";

/**
 * 旁问面板（V40，对齐 zcode 的辅助对话 / codex 的 `/side`）：聊天主区右侧浮层。
 *
 * 面板是「单会话单通道」——omp 每个会话同一时刻只跑一个旁问，运行中不允许再提问 / 追问，
 * 只在运行中的那条话题底部给「取消」。记录由 `lib/btw.ts` 与 `useSessionEvents` 的
 * `btw_record` / `btw_delta` 帧共同维护，本组件只负责展示与输入。
 */
export function BtwPanel() {
 const btw = useApp((s) => s.btw);
 const setBtw = useApp((s) => s.setBtw);
 const t = useText();
 const listRef = useRef<HTMLDivElement>(null);
 // 输入框草稿放 store（`btw.draft`）：划选「旁问」的预填与新打开面板直接写它——
 // 组件无本地拷贝，也就没有「effect 里同步 setState」的级联渲染问题。
 const text = btw.draft;
 const setText = (v: string) => setBtw({ draft: v });

 // 记录「最新在前」：新话题是插到列表头部的，把滚动区带回顶部让新轮次可见
 useEffect(() => {
  if (listRef.current) listRef.current.scrollTop = 0;
 }, [btw.records]);

 // Esc 关闭面板（与输入卡浮层同口径；焦点在输入框里也生效）
 useEffect(() => {
  if (!btw.open) return;
  const onKey = (e: KeyboardEvent) => {
   if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
   e.preventDefault();
   setBtw({ open: false, draft: "" });
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
 }, [btw.open, setBtw]);

 const sessionId = btw.sessionId;
 if (!btw.open || !sessionId) return null;

 const busy = btw.busyRecordId != null;
 const canSend = !busy && text.trim().length > 0;

 const send = () => {
  const q = text.trim();
  if (!q || busy) return;
  setText("");
  // 有最新话题就当它的追问（omp 侧把话题历史作为上下文回放），否则建新话题
  void askBtw(sessionId, q, btw.records[0]?.id);
 };

 const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
  if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey) return;
  // 中文输入法敲回车是在选词，不该当发送
  if (e.nativeEvent.isComposing) return;
  e.preventDefault();
  send();
 };

 return (
  <aside
   aria-label={t.btwTitle}
   className="fixed top-14 right-4 bottom-24 z-20 flex w-[400px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-border bg-elevated shadow-pop"
  >
   <header className="flex items-start justify-between gap-2 border-b border-border-soft px-3 py-2.5">
    <div className="min-w-0">
     <div className="text-[13px] font-medium text-foreground">{t.btwTitle}</div>
     <div className="truncate text-[11px] text-faint">{t.btwSubtitle}</div>
    </div>
    <button
     type="button"
     aria-label={t.btwCloseAria}
     onClick={() => setBtw({ open: false, draft: "" })}
     className="cursor-pointer rounded-md p-1 text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
    >
     <X size={14} aria-hidden />
    </button>
   </header>

   <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto px-3 py-2.5">
    {btw.records.length === 0 ? (
     <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-faint">
      {t.btwEmpty}
     </div>
    ) : (
     btw.records.map((r) => (
      <div key={r.id} className="space-y-2 rounded-md border border-border-soft bg-surface p-2.5">
       {[r as BtwTurn, ...(r.followUps ?? [])].map((turn, i) => (
        <TurnView key={`${r.id}-${i}`} turn={turn} t={t} />
       ))}
       {btw.busyRecordId === r.id && (
        <div className="flex justify-end">
         <button
          type="button"
          onClick={() => void cancelBtw(sessionId)}
          className="cursor-pointer rounded-md border border-border px-2.5 py-1 text-[12px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
         >
          {t.btwCancel}
         </button>
        </div>
       )}
      </div>
     ))
    )}
   </div>

   <div className="border-t border-border-soft px-3 py-2.5">
    {btw.error != null && <div className="mb-1.5 text-[12px] text-danger">{fmt(t.btwFailed, btw.error)}</div>}
    <div className="flex items-end gap-2">
     <textarea
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={onKeyDown}
      rows={2}
      disabled={busy}
      placeholder={t.btwPlaceholder}
      aria-label={t.btwPlaceholder}
      className="max-h-32 min-h-[38px] flex-1 resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] leading-5 outline-none focus:border-accent/70 disabled:opacity-50"
     />
     <button
      type="button"
      onClick={send}
      disabled={!canSend}
      aria-label={t.btwSendAria}
      className="cursor-pointer rounded-md bg-primary p-1.5 text-primary-foreground transition-colors duration-100 hover:opacity-90 disabled:opacity-40"
     >
      <ArrowUp size={15} aria-hidden />
     </button>
    </div>
   </div>
  </aside>
 );
}

/** 一问一答的一轮（话题本体与其 followUps 用同一渲染）。 */
function TurnView({ turn, t }: { turn: BtwTurn; t: Text }) {
 return (
  <div className="space-y-1">
   <div className="text-[13px] font-medium whitespace-pre-wrap text-foreground">{turn.question}</div>
   {turn.status === "running" ? (
    <div className="flex items-center gap-1.5 text-[12px] text-faint">
     <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
     {t.btwThinking}
    </div>
   ) : (
    <>
     {turn.answer && <div className="text-[13px] whitespace-pre-wrap text-muted">{turn.answer}</div>}
     {turn.status !== "complete" && (
      <div className="text-[12px] text-faint">
       {turn.status === "cancelled"
        ? t.btwStatusCancelled
        : turn.status === "error"
         ? t.btwStatusError
         : t.btwStatusInterrupted}
       {turn.status === "error" && turn.error ? ` ${turn.error}` : ""}
      </div>
     )}
    </>
   )}
  </div>
 );
}
