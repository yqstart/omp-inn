import { useMemo, useState } from "react";
import { Plus, Refresh, Search, Sliders } from "reicon-react";
import type { SessionStatus, SessionView } from "@shared/types";
import { SessionStatusDot } from "../components/sidebar/SessionStatusDot";
import { sessionRowStatus, sessionRowStatusLabel } from "../lib/sessionRowStatus";
import { sessionTitleForDisplay } from "../lib/sessionTitle";
import { useText } from "../lib/useText";

function timeText(ts: number): string {
 if (!ts) return "";
 const d = new Date(ts);
 const now = new Date();
 const sameDay = d.toDateString() === now.toDateString();
 if (sameDay) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
 return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function SessionList({
 sessions,
 statuses,
 pending,
 projectNames,
 onOpen,
 onNew,
 onRefresh,
 refreshing,
 onSettings,
}: {
 sessions: SessionView[];
 statuses: Record<string, string>;
 pending: Record<string, number>;
 projectNames: Record<string, string>;
 onOpen: (id: string) => void;
 onNew: () => void;
 onRefresh: () => void;
 refreshing: boolean;
 onSettings: () => void;
}) {
 const t = useText();
 const [query, setQuery] = useState("");
 const rows = useMemo(() => {
  const q = query.trim().toLowerCase();
  const list = q
   ? sessions.filter(
      (s) =>
       sessionTitleForDisplay(s.title).toLowerCase().includes(q) ||
       s.cwd.toLowerCase().includes(q) ||
       (projectNames[s.projectId ?? ""] ?? "").toLowerCase().includes(q),
     )
   : sessions;
  return [...list].sort((a, b) => b.timestamp - a.timestamp);
 }, [sessions, query, projectNames]);

 return (
  <div className="mobile-main">
   <header className="mobile-safe-top border-b border-border-soft px-4 pb-3">
    <div className="flex items-center justify-between pt-3">
     <h1 className="text-[18px] font-semibold tracking-tight">{t.mobileSessions}</h1>
     <div className="flex items-center gap-1">
      <button
       type="button"
       onClick={onRefresh}
       disabled={refreshing}
       className="cursor-pointer rounded-lg p-2 text-faint hover:bg-hover hover:text-foreground disabled:opacity-50"
       aria-label={t.retry}
      >
       <Refresh size={18} className={refreshing ? "animate-spin" : undefined} />
      </button>
      <button
       type="button"
       onClick={onSettings}
       className="cursor-pointer rounded-lg p-2 text-faint hover:bg-hover hover:text-foreground"
       aria-label={t.mobileSettings}
      >
       <Sliders size={18} />
      </button>
      <button
       type="button"
       onClick={onNew}
       className="flex cursor-pointer items-center gap-1 rounded-lg bg-primary px-3 py-2 text-[13px] font-medium text-primary-foreground"
      >
       <Plus size={16} />
       {t.mobileNewChat}
      </button>
     </div>
    </div>
    <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
     <Search size={15} className="shrink-0 text-faint" aria-hidden />
     <input
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      placeholder={t.mobileSearchSessions}
      className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint"
      type="search"
     />
    </div>
   </header>

   <div className="min-h-0 flex-1 overflow-y-auto">
    {rows.length === 0 ? (
     <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
      <p className="text-[14px] text-muted">{t.mobileNoSessions}</p>
      <button
       type="button"
       onClick={onSettings}
       className="cursor-pointer rounded-lg p-2 text-faint hover:bg-hover hover:text-foreground"
       aria-label={t.mobileSettings}
      >
       <Sliders size={18} />
      </button>
      <button
       type="button"
       onClick={onNew}
       className="mt-4 cursor-pointer rounded-lg border border-border px-4 py-2 text-[13px] hover:bg-hover"
      >
       {t.mobileNewChat}
      </button>
     </div>
    ) : (
     <ul className="divide-y divide-border-soft">
      {rows.map((s) => {
       const state = (statuses[s.id] as SessionStatus["state"] | undefined) ?? undefined;
       const st = sessionRowStatus({ live: state, running: s.running, unread: false });
       const label = sessionRowStatusLabel(st, t);
       const waiting = pending[s.id] ?? 0;
       return (
        <li key={s.id}>
         <button
          type="button"
          onClick={() => onOpen(s.id)}
          className="mobile-list-row flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left hover:bg-hover active:bg-hover"
         >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
           <SessionStatusDot status={st} label={label ?? ""} />
          </span>
          <span className="min-w-0 flex-1">
           <span className="flex items-center gap-2">
            <span className="truncate text-[15px] leading-6">{sessionTitleForDisplay(s.title) || t.mobileNoSessions}</span>
            {waiting > 0 && (
             <span className="shrink-0 rounded-full bg-warn/15 px-2 py-0.5 text-[11px] text-warn">
              {t.statusAwaitingTag}
             </span>
            )}
           </span>
           <span className="mt-0.5 flex items-center gap-2 text-[11px] text-faint">
            <span className="truncate">{projectNames[s.projectId ?? ""] ?? "—"}</span>
            <span>·</span>
            <span className="shrink-0">{timeText(s.timestamp)}</span>
           </span>
          </span>
         </button>
        </li>
       );
      })}
     </ul>
    )}
   </div>
  </div>
 );
}
