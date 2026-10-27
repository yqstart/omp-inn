import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Copy, Loader, Refresh, Mobile, Wifi } from "reicon-react";
import { api } from "@shared/api";
import { IPC } from "@shared/ipc";
import type { RemotePairing, RemoteStatus, RemoteTailscale } from "@shared/types";
import { fmt } from "../../lib/locale";
import { useText } from "../../lib/useText";
import { ConfirmDialog } from "../ConfirmDialog";
import { Switch } from "./Switch";

/**
 * 设置 ›「远程控制」：服务开关 / 地址 / 扫码配对 / 设备撤销 / Tailscale。
 *
 * 安全口径：
 * - 服务默认关闭，每次启动都要显式开启；
 * - 二维码 2 分钟单次有效，离开面板即取消；
 * - 设备令牌只存哈希，撤销立即断开；
 * - 手机端只能调用会话控制白名单，审批不提供「总是允许」。
 */
export function RemotePanel() {
 const t = useText();
 const [status, setStatus] = useState<RemoteStatus | null>(null);
 const [error, setError] = useState<string | null>(null);
 const [busy, setBusy] = useState(false);
 const [port, setPort] = useState(43110);
 const [access, setAccess] = useState<"lan" | "tailscale">("lan");
 const [baseUrl, setBaseUrl] = useState("");
 const [pairing, setPairing] = useState<RemotePairing | null>(null);
 const [pairedAt, setPairedAt] = useState(0);
 const [now, setNow] = useState(0);
 const [tsProbe, setTsProbe] = useState<RemoteTailscale | null>(null);
 const [copied, setCopied] = useState<string | null>(null);
 const [revoke, setRevoke] = useState<{ id?: string; all?: boolean } | null>(null);
 const mounted = useRef(true);

 const apply = useCallback((s: RemoteStatus) => {
  setStatus(s);
  setAccess(s.access === "tailscale" ? "tailscale" : "lan");
  setPort(s.port);
 }, []);

 useEffect(() => {
  mounted.current = true;
  api
   .remoteGetStatus()
   .then((s) => {
    if (mounted.current) apply(s);
   })
   .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  // Tailscale 探测要跑 CLI：只进面板时探测一次，状态轮询不重复跑
  api
   .remoteTailscaleProbe()
   .then((ts) => {
    if (mounted.current) {
     setTsProbe(ts);
     setStatus((s) => (s ? { ...s, tailscale: ts } : s));
    }
   })
   .catch(() => undefined);
  let un: (() => void) | undefined;
  void listen<RemoteStatus>(IPC.remoteState, (e) => {
   if (mounted.current) apply(e.payload);
  }).then((fn) => {
   if (!mounted.current) fn();
   else un = fn;
  });
  return () => {
   mounted.current = false;
   un?.();
   void api.remoteCancelPairing().catch(() => undefined);
  };
 }, [apply]);

 // 二维码倒计时
 useEffect(() => {
  if (!pairing) return;
  const timer = window.setInterval(() => setNow(Date.now()), 1000);
  return () => window.clearInterval(timer);
 }, [pairing]);

 const remaining = pairing ? Math.max(0, pairing.expiresIn - Math.floor((now - pairedAt) / 1000)) : 0;
 const expired = !!pairing && remaining <= 0;

 const start = async (nextAccess = access, nextPort = port) => {
  setBusy(true);
  setError(null);
  try {
   apply(await api.remoteStart(nextAccess, nextPort));
  } catch (e) {
   setError(e instanceof Error ? e.message : String(e));
  } finally {
   setBusy(false);
  }
 };

 const stop = async () => {
  setBusy(true);
  setError(null);
  setPairing(null);
  try {
   apply(await api.remoteStop());
  } catch (e) {
   setError(e instanceof Error ? e.message : String(e));
  } finally {
   setBusy(false);
  }
 };

 // 默认地址：优先 Tailscale HTTPS，其次局域网，最后本机。派生而不是 effect 回写，
 // 避免「状态变化 → effect setState → 再渲染」的级联（react-hooks/set-state-in-effect）。
 const preferredBase =
  status?.addresses.find((a) => a.kind === "tailscale" && a.url.startsWith("https://"))?.url ??
  status?.addresses.find((a) => a.kind === "lan")?.url ??
  status?.addresses.find((a) => a.kind === "tailscale")?.url ??
  status?.addresses[0]?.url ??
  "";
 const effectiveBase = baseUrl && status?.addresses.some((a) => a.url === baseUrl) ? baseUrl : preferredBase;

 const refreshQr = async (base = effectiveBase) => {
  if (!base) return;
  setBusy(true);
  setError(null);
  try {
   const p = await api.remotePairing(base);
   setPairing(p);
   setPairedAt(Date.now());
   setNow(Date.now());
  } catch (e) {
   setError(e instanceof Error ? e.message : String(e));
  } finally {
   setBusy(false);
  }
 };

 const copy = async (text: string) => {
  try {
   await navigator.clipboard.writeText(text);
   setCopied(text);
   window.setTimeout(() => setCopied(null), 1500);
  } catch {
   // 剪贴板不可用时退化为选中文本（内容本身已在页面上）
  }
 };

 const doRevoke = async () => {
  if (!revoke) return;
  setBusy(true);
  setError(null);
  try {
   apply(revoke.all ? await api.remoteRevokeAll() : await api.remoteRevokeDevice(revoke.id ?? ""));
   setRevoke(null);
  } catch (e) {
   setError(e instanceof Error ? e.message : String(e));
  } finally {
   setBusy(false);
  }
 };

 // 初始 status 的 tailscale 是默认空值；探测结果在 status 还没带上真实信息时优先。
 const tailscale = status?.tailscale?.installed || status?.tailscale?.error ? status.tailscale : (tsProbe ?? status?.tailscale);

 return (
  <div className="mx-auto w-full max-w-3xl px-8 py-8">
   <div className="flex items-start justify-between gap-4">
    <div>
     <h1 className="text-[19px] font-semibold tracking-tight">{t.tabRemote}</h1>
     <p className="mt-1 max-w-xl text-[13px] leading-6 text-muted">{t.remoteIntro}</p>
    </div>
    <div className="flex shrink-0 items-center gap-3">
     <span className={`text-[12px] ${status?.running ? "text-ok" : "text-faint"}`}>
      {status?.running ? t.remoteConnections.replace("{0}", String(status.connections)) : t.tabRemoteHint}
     </span>
     <Switch
      on={!!status?.running}
      disabled={busy}
      label={status?.running ? t.remoteDisable : t.remoteEnable}
      onToggle={() => void (status?.running ? stop() : start())}
     />
    </div>
   </div>

   {error && (
    <div role="alert" className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
     {error}
    </div>
   )}

   <section className="mt-6 border-t border-border-soft pt-5">
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
     <label className="text-[13px] text-muted" htmlFor="remote-port">
      {t.remoteAccess}
     </label>
     <div className="flex rounded-md border border-border p-0.5">
      {(["lan", "tailscale"] as const).map((mode) => (
       <button
        key={mode}
        type="button"
        disabled={busy || (status?.running ?? false)}
        onClick={() => setAccess(mode)}
        className={`cursor-pointer rounded px-3 py-1 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
         access === mode ? "bg-accent/15 text-accent" : "text-muted hover:bg-hover"
        }`}
       >
        {mode === "lan" ? t.remoteAccessLan : t.remoteAccessTailscale}
       </button>
      ))}
     </div>
     <label className="ml-auto flex items-center gap-2 text-[13px] text-muted" htmlFor="remote-port">
      {t.remotePort}
      <input
       id="remote-port"
       type="number"
       min={1024}
       max={65535}
       value={port}
       disabled={busy || (status?.running ?? false)}
       onChange={(e) => setPort(Math.max(1024, Math.min(65535, Number(e.target.value) || 43110)))}
       className="w-24 rounded-md border border-border bg-surface px-2 py-1 font-mono text-[13px] outline-none focus:border-accent disabled:opacity-50"
      />
     </label>
    </div>
    <p className="mt-2 text-[12px] leading-5 text-faint">{t.remoteAccessHint}</p>
    {access === "tailscale" && status?.running && !tailscale?.serveEnabled && (
     <p className="mt-1 text-[12px] leading-5 text-warn">{t.remoteTailscaleNeeded}</p>
    )}
   </section>

   {status?.running && (
    <>
     <section className="mt-6 border-t border-border-soft pt-5">
      <div className="flex items-center justify-between">
       <h2 className="text-[13px] font-medium text-muted">{t.remoteAddresses}</h2>
       <button
        type="button"
        onClick={() => void api.remoteGetStatus().then(apply).catch(() => undefined)}
        className="cursor-pointer rounded-md p-1.5 text-faint hover:bg-hover hover:text-foreground"
        aria-label={t.retry}
       >
        <Refresh size={14} />
       </button>
      </div>
      {status.addresses.length === 0 ? (
       <p className="mt-2 text-[13px] text-warn">{t.remoteAddressEmpty}</p>
      ) : (
       <div className="mt-2 space-y-1.5">
        {status.addresses.map((a) => (
         <div key={a.url} className="flex items-center gap-3">
          <span className="w-40 shrink-0 truncate text-[12px] text-faint">{a.label}</span>
          <code className="min-w-0 flex-1 truncate rounded bg-code px-2 py-1 font-mono text-[12px]">{a.url}</code>
          <button
           type="button"
           onClick={() => void copy(a.url)}
           className="shrink-0 cursor-pointer rounded-md p-1.5 text-faint hover:bg-hover hover:text-foreground"
           aria-label={t.remoteCopy}
          >
           <Copy size={14} />
          </button>
          {copied === a.url && <span className="text-[11px] text-ok">{t.remoteCopied}</span>}
         </div>
        ))}
       </div>
      )}
     </section>

     <section className="mt-6 border-t border-border-soft pt-5">
      <div className="flex items-center gap-2">
       <Mobile size={15} className="text-accent" aria-hidden />
       <h2 className="text-[14px] font-medium">{t.remotePairingTitle}</h2>
      </div>
      <p className="mt-1 text-[12px] leading-5 text-faint">{t.remotePairingHint}</p>
      <div className="mt-3 flex flex-wrap items-start gap-5">
       {pairing && !expired ? (
        <div className="h-[266px] w-[266px] shrink-0 overflow-hidden rounded-xl border border-border bg-white p-3">
         <div
          className="remote-qr h-[240px] w-[240px] overflow-hidden"
          dangerouslySetInnerHTML={{ __html: pairing.svg }}
         />
        </div>
       ) : (
        <div className="flex h-[266px] w-[266px] shrink-0 items-center justify-center rounded-xl border border-dashed border-border px-3 text-center text-[12px] text-faint">
         {expired ? t.remotePairingExpired : t.tabRemoteHint}
        </div>
       )}
       <div className="min-w-0 flex-1 basis-56 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
         <select
          value={effectiveBase}
          onChange={(e) => setBaseUrl(e.target.value)}
          className="min-w-0 max-w-full flex-1 basis-32 rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] outline-none focus:border-accent"
         >
          {status.addresses.map((a) => (
           <option key={a.url} value={a.url}>
            {a.label}
           </option>
          ))}
         </select>
         <button
          type="button"
          disabled={busy || !effectiveBase}
          onClick={() => void refreshQr()}
          className="shrink-0 cursor-pointer rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
         >
          {expired ? t.remotePairingRefresh : t.remotePairingTitle}
         </button>
         {pairing && (
          <button
           type="button"
           onClick={() => {
            setPairing(null);
            void api.remoteCancelPairing().catch(() => undefined);
           }}
           className="shrink-0 cursor-pointer rounded-md border border-border px-3 py-1.5 text-[12px] hover:bg-hover"
          >
           {t.remotePairingCancel}
          </button>
         )}
        </div>
        {pairing && (
         <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
          {expired ? t.remotePairingExpired : `${remaining}s`}
          <button
           type="button"
           onClick={() => void copy(pairing.url)}
           className="ml-2 cursor-pointer text-accent hover:opacity-80"
          >
           {copied === pairing.url ? t.remoteCopied : t.remoteCopy}
          </button>
         </div>
        )}
       </div>
      </div>
     </section>

     <section className="mt-6 border-t border-border-soft pt-5">
      <div className="flex items-center justify-between">
       <h2 className="text-[13px] font-medium text-muted">{t.remoteDevicesTitle}</h2>
       {status.devices.length > 0 && (
        <button
         type="button"
         onClick={() => setRevoke({ all: true })}
         className="cursor-pointer text-[12px] text-danger hover:opacity-80"
        >
         {t.remoteRevokeAll}
        </button>
       )}
      </div>
      {status.devices.length === 0 ? (
       <p className="mt-2 text-[13px] text-faint">{t.remoteDevicesEmpty}</p>
      ) : (
       <div className="mt-2 divide-y divide-border-soft">
        {status.devices.map((d) => (
         <div key={d.id} className="flex items-center gap-3 py-2.5">
          <Mobile size={15} className="shrink-0 text-muted" aria-hidden />
          <div className="min-w-0 flex-1">
           <div className="truncate text-[13px]">{d.name}</div>
           <div className="mt-0.5 text-[11px] text-faint">
            {d.lastSeenAt
             ? fmt(t.remoteDeviceLastSeen, new Date(d.lastSeenAt).toLocaleString())
             : t.remoteDeviceNever}
            {d.lastIp ? ` · ${d.lastIp}` : ""}
           </div>
          </div>
          <button
           type="button"
           onClick={() => setRevoke({ id: d.id })}
           className="shrink-0 cursor-pointer rounded-md border border-border px-2.5 py-1 text-[12px] text-danger hover:bg-danger/10"
          >
           {t.remoteRevoke}
          </button>
         </div>
        ))}
       </div>
      )}
     </section>
    </>
   )}

   {!status?.running && status && status.devices.length > 0 && (
    <section className="mt-6 border-t border-border-soft pt-5">
     <div className="flex items-center justify-between">
      <h2 className="text-[13px] font-medium text-muted">{t.remoteDevicesTitle}</h2>
      <button
       type="button"
       onClick={() => setRevoke({ all: true })}
       className="cursor-pointer text-[12px] text-danger hover:opacity-80"
      >
       {t.remoteRevokeAll}
      </button>
     </div>
     <div className="mt-2 divide-y divide-border-soft">
      {status.devices.map((d) => (
       <div key={d.id} className="flex items-center gap-3 py-2.5">
        <Mobile size={15} className="shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
         <div className="truncate text-[13px]">{d.name}</div>
         <div className="mt-0.5 text-[11px] text-faint">
          {d.lastSeenAt ? fmt(t.remoteDeviceLastSeen, new Date(d.lastSeenAt).toLocaleString()) : t.remoteDeviceNever}
          {d.lastIp ? ` · ${d.lastIp}` : ""}
         </div>
        </div>
        <button
         type="button"
         onClick={() => setRevoke({ id: d.id })}
         className="shrink-0 cursor-pointer rounded-md border border-border px-2.5 py-1 text-[12px] text-danger hover:bg-danger/10"
        >
         {t.remoteRevoke}
        </button>
       </div>
      ))}
     </div>
    </section>
   )}

   <section className="mt-6 border-t border-border-soft pt-5">
    <div className="flex items-center gap-2">
     <Wifi size={15} className="text-accent" aria-hidden />
     <h2 className="text-[14px] font-medium">{t.remoteTailscaleTitle}</h2>
    </div>
    {!tailscale?.installed ? (
     <p className="mt-1 text-[12px] leading-5 text-faint">{t.remoteTailscaleMissing}</p>
    ) : (
     <div className="mt-2 space-y-2 text-[12px] text-muted">
      <div>
       {tailscale.backendState ?? "—"}
       {tailscale.dnsName ? ` · ${tailscale.dnsName}` : ""}
       {tailscale.ipv4 ? ` · ${tailscale.ipv4}` : ""}
      </div>
      {tailscale.error && <div className="text-warn">{tailscale.error}</div>}
      {tailscale.httpsUrl && <div className="text-ok">{fmt(t.remoteTailscaleHttps, tailscale.httpsUrl)}</div>}
      <div className="flex flex-wrap items-center gap-2">
       <button
        type="button"
        disabled={busy || !status?.running}
        onClick={async () => {
         setBusy(true);
         setError(null);
         try {
          apply(await api.remoteTailscaleEnable());
         } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
         } finally {
          setBusy(false);
         }
        }}
        className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[12px] hover:bg-hover disabled:opacity-50"
       >
        {t.remoteTailscaleEnable}
       </button>
       {tailscale.serveEnabled && (
        <button
         type="button"
         disabled={busy}
         onClick={async () => {
          setBusy(true);
          try {
           apply(await api.remoteTailscaleDisable());
          } catch (e) {
           setError(e instanceof Error ? e.message : String(e));
          } finally {
           setBusy(false);
          }
         }}
         className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[12px] hover:bg-hover disabled:opacity-50"
        >
         {t.remoteTailscaleDisable}
        </button>
       )}
       <button
        type="button"
        disabled={busy}
        onClick={() => {
         setBusy(true);
         api
          .remoteTailscaleProbe()
          .then((ts) => setStatus((s) => (s ? { ...s, tailscale: ts } : s)))
          .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
          .finally(() => setBusy(false));
        }}
        className="cursor-pointer rounded-md p-1.5 text-faint hover:bg-hover hover:text-foreground"
        aria-label={t.retry}
       >
        <Loader size={14} className={busy ? "animate-spin" : undefined} />
       </button>
      </div>
     </div>
    )}
   </section>

   <section className="mt-6 border-t border-border-soft pt-5">
    <h2 className="text-[13px] font-medium text-muted">{t.remoteSecurityTitle}</h2>
    <ul className="mt-2 space-y-1.5 text-[12px] leading-5 text-faint">
     <li>{t.remoteSecurityBody}</li>
     <li className="text-warn">{t.remoteSecurityHttp}</li>
     <li>{t.remoteSecurityScope}</li>
    </ul>
   </section>

   <ConfirmDialog
    open={revoke !== null}
    title={revoke?.all ? t.remoteRevokeAll : t.remoteRevoke}
    detail={t.remoteRevokeConfirm}
    confirmLabel={t.remoteRevoke}
    danger
    onConfirm={() => void doRevoke()}
    onCancel={() => setRevoke(null)}
   />
  </div>
 );
}
