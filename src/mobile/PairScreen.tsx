import { useState } from "react";
import { Key, Mobile } from "reicon-react";
import { RemoteError, remotePair } from "@shared/remote";
import { useText } from "../lib/useText";

function defaultDeviceName(): string {
 const ua = navigator.userAgent;
 if (/iPhone/i.test(ua)) return "iPhone";
 if (/iPad/i.test(ua)) return "iPad";
 if (/Android/i.test(ua)) return "Android 手机";
 return "手机";
}

function secretFrom(input: string): string | null {
 const text = input.trim();
 if (!text) return null;
 const marked = text.match(/[#?&]pair=([A-Za-z0-9_-]+)/);
 if (marked) return marked[1];
 try {
  const url = new URL(text);
  const m = url.hash.match(/pair=([A-Za-z0-9_-]+)/);
  if (m) return m[1];
 } catch {
  // 不是 URL：把整段当密钥试试（用户可能只复制了 secret）
  if (/^[A-Za-z0-9_-]{20,}$/.test(text)) return text;
 }
 return null;
}

export function PairScreen({ initialSecret, onPaired }: { initialSecret: string | null; onPaired: () => void }) {
 const t = useText();
 const [secret, setSecret] = useState(initialSecret ?? "");
 const [name, setName] = useState(defaultDeviceName);
 const [paste, setPaste] = useState("");
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState<string | null>(null);

 const codeMessage = (e: unknown): string => {
  if (e instanceof RemoteError) {
   switch (e.code) {
    case "PAIRING_EXPIRED":
     return t.mobilePairExpired;
    case "PAIRING_USED":
     return t.mobilePairUsed;
    case "PAIR_RATE_LIMIT":
     return t.mobilePairRate;
    case "PAIRING_BAD":
     return t.mobilePairInvalid;
    default:
     return e.message;
   }
  }
  return e instanceof Error ? e.message : String(e);
 };

 const pair = async (value = secret) => {
  if (!value.trim()) {
   setError(t.mobilePairInvalid);
   return;
  }
  setBusy(true);
  setError(null);
  try {
   await remotePair(value.trim(), name.trim() || defaultDeviceName());
   onPaired();
  } catch (e) {
   setError(codeMessage(e));
  } finally {
   setBusy(false);
  }
 };

 return (
  <div className="mobile-root">
   <div className="flex flex-1 flex-col items-center justify-center px-6 py-10">
    <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-accent">
     <Mobile size={26} />
    </div>
    <h1 className="mt-5 text-[20px] font-semibold tracking-tight">{t.mobilePairTitle}</h1>
    <p className="mt-2 max-w-sm text-center text-[13px] leading-6 text-muted">{t.mobilePairHint}</p>

    <div className="mt-6 w-full max-w-sm space-y-3">
     <label className="block text-[12px] text-faint" htmlFor="pair-name">
      {t.mobileDeviceName}
     </label>
     <input
      id="pair-name"
      value={name}
      onChange={(e) => setName(e.target.value)}
      maxLength={64}
      className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-[15px] outline-none focus:border-accent"
     />
     <button
      type="button"
      disabled={busy || !secret}
      onClick={() => void pair()}
      className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-[15px] font-medium text-primary-foreground disabled:opacity-50"
     >
      <Key size={16} />
      {busy ? t.mobileConnecting : t.mobilePairButton}
     </button>
     {error && (
      <div role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
       {error}
      </div>
     )}
    </div>

    <div className="mt-8 w-full max-w-sm border-t border-border-soft pt-5">
     <label className="block text-[12px] text-faint" htmlFor="pair-paste">
      {t.mobilePairPaste}
     </label>
     <div className="mt-2 flex gap-2">
      <input
       id="pair-paste"
       value={paste}
       onChange={(e) => setPaste(e.target.value)}
       placeholder="http://192.168.1.5:43110/#pair=…"
       className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[12px] outline-none focus:border-accent"
      />
      <button
       type="button"
       disabled={busy}
       onClick={() => {
        const s = secretFrom(paste);
        if (!s) {
         setError(t.mobilePairInvalid);
         return;
        }
        setSecret(s);
        setError(null);
       }}
       className="shrink-0 cursor-pointer rounded-lg border border-border px-3 py-2 text-[13px] hover:bg-hover disabled:opacity-50"
      >
       {t.confirm}
      </button>
     </div>
     {!secret && <p className="mt-2 text-[12px] leading-5 text-faint">{t.mobilePairHint}</p>}
    </div>
   </div>
  </div>
 );
}
