import { useState } from "react";
import { Folder, X } from "reicon-react";
import type { ProjectView } from "@shared/types";
import { createChatIn } from "../lib/sessionOpen";
import { useText } from "../lib/useText";

export function NewSessionSheet({
 projects,
 onClose,
 onCreated,
}: {
 projects: ProjectView[];
 onClose: () => void;
 onCreated: (id: string) => void;
}) {
 const t = useText();
 const [busy, setBusy] = useState<string | null>(null);
 const [error, setError] = useState<string | null>(null);

 const create = async (p: ProjectView) => {
  setBusy(p.id);
  setError(null);
  const out = await createChatIn(p.path, { projectName: p.name });
  setBusy(null);
  if (out.ok) onCreated(out.id);
  else setError(out.message);
 };

 return (
  <div className="mobile-sheet-backdrop" onClick={onClose}>
   <div className="mobile-sheet" onClick={(e) => e.stopPropagation()}>
    <div className="flex items-center justify-between border-b border-border-soft px-4 py-3">
     <h2 className="text-[16px] font-medium">{t.mobileNewChat}</h2>
     <button
      type="button"
      onClick={onClose}
      className="cursor-pointer rounded-lg p-2 text-faint hover:bg-hover"
      aria-label={t.close}
     >
      <X size={18} />
     </button>
    </div>
    <div className="max-h-[60dvh] overflow-y-auto">
     {projects.length === 0 ? (
      <p className="px-4 py-8 text-center text-[13px] text-muted">{t.mobileNoProjects}</p>
     ) : (
      <ul className="divide-y divide-border-soft">
       {projects.map((p) => (
        <li key={p.id}>
         <button
          type="button"
          disabled={busy !== null}
          onClick={() => void create(p)}
          className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left hover:bg-hover disabled:opacity-50"
         >
          <Folder size={18} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
           <span className="block truncate text-[14px]">{p.name}</span>
           <span className="mt-0.5 block truncate font-mono text-[11px] text-faint">{p.path}</span>
          </span>
          {busy === p.id && <span className="shrink-0 text-[12px] text-muted">{t.mobileConnecting}</span>}
         </button>
        </li>
       ))}
      </ul>
     )}
    </div>
    {error && (
     <div role="alert" className="border-t border-danger/30 bg-danger/10 px-4 py-2 text-[12px] text-danger">
      {error}
     </div>
    )}
   </div>
  </div>
 );
}
