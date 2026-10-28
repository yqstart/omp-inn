import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Loader, Sliders, Mobile, WifiOff } from "reicon-react";
import { api } from "@shared/api";
import type { ProjectView, RemoteDevice, RemoteOverview, SessionStatus } from "@shared/types";
import {
  RemoteError,
  onRemoteConnection,
  onRemoteReconnected,
  onRemoteUnauthorized,
  remoteLogout,
  remoteMe,
  remoteOverview,
  type RemoteConnState,
} from "@shared/remote";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { SessionStatusDot } from "../components/sidebar/SessionStatusDot";
import { Thread } from "../components/thread/Thread";
import { LOCALE_MODES, LOCALE_NAMES, type LocaleMode } from "../lib/locale";
import { sessionRowStatus, sessionRowStatusLabel } from "../lib/sessionRowStatus";
import { openSessionWithHistory } from "../lib/sessionOpen";
import { sessionTitleForDisplay } from "../lib/sessionTitle";
import { applyTheme, THEMES } from "../lib/theme";
import { useText } from "../lib/useText";
import { useSessionEvents } from "../lib/useSessionEvents";
import { useApp } from "../stores/app";
import { MobileComposer } from "./MobileComposer";
import { NewSessionSheet } from "./NewSessionSheet";
import { PairScreen } from "./PairScreen";
import { SessionList } from "./SessionList";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Route = { kind: "list" } | { kind: "session"; id: string };
type Auth = "checking" | "paired" | "unpaired" | "offline";

function readHash(): { route: Route; secret: string | null } {
 const h = location.hash.replace(/^#/, "");
 if (h.startsWith("pair=")) {
  return { route: { kind: "list" }, secret: h.slice("pair=".length).split("&")[0] };
 }
 if (h.startsWith("/s/")) {
  const id = h.slice(3).split("?")[0];
  return { route: UUID.test(id) ? { kind: "session", id } : { kind: "list" }, secret: null };
 }
 return { route: { kind: "list" }, secret: null };
}

function useMobileOverview(enabled: boolean) {
 const [overview, setOverview] = useState<RemoteOverview | null>(null);
 const [refreshing, setRefreshing] = useState(false);
 const [error, setError] = useState<string | null>(null);
 const busy = useRef(false);
 const refresh = useCallback(async () => {
  if (!enabled || busy.current) return;
  busy.current = true;
  setRefreshing(true);
  try {
   const o = await remoteOverview(200);
   setOverview(o);
   const st = useApp.getState();
   const ids = new Set(o.sessions.map((s) => s.id));
   const active = st.activeSessionId;
   const extra = active && !ids.has(active) ? st.sessions.filter((s) => s.id === active) : [];
   st.set({ sessions: [...extra, ...o.sessions] });
   setError(null);
  } catch (e) {
   if (!(e instanceof RemoteError && e.code === "UNAUTHORIZED")) {
    setError(e instanceof Error ? e.message : String(e));
   }
  } finally {
   busy.current = false;
   setRefreshing(false);
  }
 }, [enabled]);

 useEffect(() => {
  if (!enabled) return;
  const kick = window.setTimeout(() => void refresh(), 0);
  const timer = window.setInterval(() => {
   if (!document.hidden) void refresh();
  }, 5000);
  const onVisible = () => {
   if (!document.hidden) void refresh();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
   window.clearTimeout(kick);
   window.clearInterval(timer);
   document.removeEventListener("visibilitychange", onVisible);
  };
 }, [enabled, refresh]);

 return { overview, refresh, refreshing, error };
}

export function MobileApp() {
 const t = useText();
 useSessionEvents();

 const [initial] = useState(readHash);
 const [route, setRoute] = useState<Route>(initial.route);
 const [secret, setSecret] = useState<string | null>(initial.secret);
 const [auth, setAuth] = useState<Auth>("checking");
 const [device, setDevice] = useState<RemoteDevice | null>(null);
 const [conn, setConn] = useState<RemoteConnState>("closed");
 const [projects, setProjects] = useState<ProjectView[]>([]);
 const [opening, setOpening] = useState(false);
 const [openError, setOpenError] = useState<string | null>(null);
 const [showNew, setShowNew] = useState(false);
 const [settingsOpen, setSettingsOpen] = useState(false);
 const [confirmUnpair, setConfirmUnpair] = useState(false);

 const theme = useApp((s) => s.theme);
 const localeMode = useApp((s) => s.localeMode);
 const activeId = useApp((s) => s.activeSessionId);
 const liveStatus = useApp((s) => s.statusBySession);
 const storeSessions = useApp((s) => s.sessions);
 const { overview, refresh, refreshing, error: overviewError } = useMobileOverview(auth === "paired");

 const routeId = route.kind === "session" ? route.id : null;

 /** 打开会话发生身份漂移时，只有用户仍停留在原路由才替换地址。 */
 const syncRealRoute = useCallback((requested: string, actual: string) => {
  if (requested === actual || useApp.getState().activeSessionId !== actual) return;
  const current = readHash().route;
  if (current.kind !== "session" || current.id !== requested) return;
  history.replaceState(null, "", `#/s/${actual}`);
  setRoute({ kind: "session", id: actual });
 }, []);

 useEffect(() => {
  applyTheme(theme);
 }, [theme]);

 // iOS 键盘：visualViewport 高度变化时缩根容器（100dvh 在 iOS 上不跟随键盘）。
 useEffect(() => {
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => document.documentElement.style.setProperty("--mobile-vvh", `${Math.round(vv.height)}px`);
  update();
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  return () => {
   vv.removeEventListener("resize", update);
   vv.removeEventListener("scroll", update);
   document.documentElement.style.removeProperty("--mobile-vvh");
  };
 }, []);

 // 首屏：去掉 URL 里的配对 secret（放 state，别留在地址栏 / 历史里）
 useEffect(() => {
  if (initial.secret) history.replaceState(null, "", "#/");
 }, [initial.secret]);

 useEffect(() => {
  const onHash = () => setRoute(readHash().route);
  window.addEventListener("hashchange", onHash);
  return () => window.removeEventListener("hashchange", onHash);
 }, []);

 useEffect(() => {
  let alive = true;
  remoteMe()
   .then((me) => {
    if (!alive) return;
    setDevice(me.device);
    setAuth("paired");
   })
   .catch((e: unknown) => {
    if (!alive) return;
    setAuth(e instanceof RemoteError && e.code === "UNAUTHORIZED" ? "unpaired" : "offline");
   });
  return () => {
   alive = false;
  };
 }, []);

 useEffect(() => onRemoteConnection(setConn), []);
 useEffect(
  () =>
   onRemoteUnauthorized(() => {
    setAuth("unpaired");
    setDevice(null);
    setSecret(null);
    const st = useApp.getState();
    st.set({
     eventsBySession: {},
     statusBySession: {},
     activeSessionId: null,
     sessions: [],
     drafts: {},
     attachmentsBySession: {},
    });
   }),
  [],
 );

 useEffect(() => {
  if (auth !== "paired") return;
  let alive = true;
  api
   .listProjects()
   .then((list) => {
    if (alive) setProjects(list);
   })
   .catch(() => undefined);
  return () => {
   alive = false;
  };
 }, [auth]);

 // 断线重连：补列表 + 当前会话历史（open 是幂等的，会按身份漂移口径收敛）
 useEffect(
  () =>
   onRemoteReconnected(() => {
    void refresh();
    const id = useApp.getState().activeSessionId;
    if (id) void openSessionWithHistory(id).then((r) => {
     if (r.ok) syncRealRoute(id, r.id);
    }).catch(() => undefined);
   }),
  [refresh, syncRealRoute],
 );

 // 打开路由上的会话
 useEffect(() => {
  if (auth !== "paired" || !routeId) return;
  // 已经是当前会话（例如新建后主动切过去 / open-elsewhere 换算成真实 id 后重入）：
  // 不重复 open，也不要在 effect 里同步 setState（lint 规则要求）。
  if (useApp.getState().activeSessionId === routeId) {
   const clear = window.setTimeout(() => {
    setOpening(false);
    setOpenError(null);
   }, 0);
   return () => window.clearTimeout(clear);
  }
  let alive = true;
  const kick = window.setTimeout(() => {
   setOpening(true);
   setOpenError(null);
   const hint = useApp.getState().sessions.find((s) => s.id === routeId);
   openSessionWithHistory(routeId, hint)
    .then((r) => {
     if (!alive) return;
     setOpening(false);
     if (!r.ok) setOpenError(t.mobileOffline);
     else syncRealRoute(routeId, r.id);
    })
    .catch((e: unknown) => {
     if (!alive) return;
     setOpening(false);
     setOpenError(e instanceof Error ? e.message : String(e));
    });
  }, 0);
  return () => {
   alive = false;
   window.clearTimeout(kick);
  };
 }, [auth, routeId, t.mobileOffline, syncRealRoute]);

 const projectNames = useMemo(() => {
  const out: Record<string, string> = {};
  for (const p of projects) out[p.id] = p.name;
  return out;
 }, [projects]);

 const sessions = useMemo(() => {
  const base = overview?.sessions ?? storeSessions;
  const ids = new Set(base.map((s) => s.id));
  const extra = storeSessions.filter((s) => !ids.has(s.id) && s.id === activeId);
  return [...extra, ...base];
 }, [overview, storeSessions, activeId]);

 const statuses = useMemo(() => {
  const out: Record<string, string> = { ...(overview?.statuses ?? {}) };
  for (const [sid, st] of Object.entries(liveStatus)) out[sid] = st.state;
  return out;
 }, [overview, liveStatus]);

 const activeSession = sessions.find((s) => s.id === (routeId ?? activeId));
 const activeState = (routeId ? liveStatus[routeId]?.state : undefined) ?? (routeId ? statuses[routeId] : undefined);
 const rowStatus = sessionRowStatus({
  live: activeState as SessionStatus["state"] | undefined,
  running: activeSession?.running ?? false,
  unread: false,
 });
 const rowStatusLabel = sessionRowStatusLabel(rowStatus, t);

 const openSession = (id: string) => {
  location.hash = `#/s/${id}`;
 };
 const backToList = () => {
  location.hash = "#/";
 };

 const unpair = async () => {
  setConfirmUnpair(false);
  try {
   await remoteLogout();
  } catch {
   // 网络失败也要把本机退回未配对态（Cookie 可能已被服务端撤销）
  }
  setAuth("unpaired");
  setDevice(null);
  setSettingsOpen(false);
  useApp.getState().set({
   eventsBySession: {},
   statusBySession: {},
   activeSessionId: null,
   sessions: [],
   drafts: {},
   attachmentsBySession: {},
  });
 };

 if (secret || auth === "unpaired") {
  return (
   <PairScreen
    initialSecret={secret}
    onPaired={() => {
     setSecret(null);
     setAuth("paired");
     history.replaceState(null, "", "#/");
     void remoteMe()
      .then((me) => setDevice(me.device))
      .catch(() => undefined);
    }}
   />
  );
 }

 if (auth === "checking") {
  return (
   <div className="mobile-root items-center justify-center">
    <Loader size={24} className="animate-spin text-muted" />
   </div>
  );
 }

 if (auth === "offline") {
  return (
   <div className="mobile-root items-center justify-center px-8 text-center">
    <WifiOff size={30} className="text-warn" />
    <h1 className="mt-4 text-[18px] font-semibold">{t.mobileOffline}</h1>
    <p className="mt-2 text-[13px] leading-6 text-muted">{t.mobileOfflineHint}</p>
    <button
     type="button"
     onClick={() => {
      setAuth("checking");
      remoteMe()
       .then((me) => {
        setDevice(me.device);
        setAuth("paired");
       })
       .catch((e: unknown) => setAuth(e instanceof RemoteError && e.code === "UNAUTHORIZED" ? "unpaired" : "offline"));
     }}
     className="mt-5 cursor-pointer rounded-lg bg-primary px-5 py-2.5 text-[14px] font-medium text-primary-foreground"
    >
     {t.mobileReconnect}
    </button>
    <button
     type="button"
     onClick={() => setAuth("unpaired")}
     className="mt-3 cursor-pointer text-[13px] text-accent"
    >
     {t.mobilePairTitle}
    </button>
   </div>
  );
 }

 return (
  <div className="mobile-root">
   {conn === "closed" && (
    <div className="flex items-center justify-center gap-2 bg-warn/10 px-3 py-1 text-[11px] text-warn">
     <WifiOff size={12} />
     {t.mobileOffline}
     <button type="button" onClick={() => void refresh()} className="cursor-pointer underline">
      {t.mobileReconnect}
     </button>
    </div>
   )}

   {routeId ? (
    <div className="mobile-main">
     <header className="mobile-safe-top flex items-center gap-2 border-b border-border-soft px-2 py-2">
      <button
       type="button"
       onClick={backToList}
       className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg text-muted hover:bg-hover"
       aria-label={t.back}
      >
       <ArrowLeft size={20} />
      </button>
      <div className="min-w-0 flex-1">
       <div className="truncate text-[15px] font-medium">
        {sessionTitleForDisplay(activeSession?.title ?? "") || t.mobileSessions}
       </div>
       <div className="truncate text-[11px] text-faint">
        {projectNames[activeSession?.projectId ?? ""] ?? ""}
       </div>
      </div>
      <span className="flex items-center gap-1.5 px-1 text-[11px] text-muted">
       <SessionStatusDot status={rowStatus} label={rowStatusLabel ?? ""} />
       {rowStatusLabel}
      </span>
      <button
       type="button"
       onClick={() => setSettingsOpen(true)}
       className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg text-muted hover:bg-hover"
       aria-label={t.mobileSettings}
      >
       <Sliders size={20} />
      </button>
     </header>

     {opening ? (
      <div className="flex flex-1 items-center justify-center">
       <Loader size={22} className="animate-spin text-muted" />
      </div>
     ) : openError ? (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
       <p className="text-[13px] text-danger">{openError}</p>
       <button
        type="button"
        onClick={() => {
         setOpenError(null);
         void openSessionWithHistory(routeId).then((r) => {
          if (r.ok) syncRealRoute(routeId, r.id);
          else setOpenError(t.mobileOffline);
         }).catch(() => setOpenError(t.mobileOffline));
        }}
        className="cursor-pointer rounded-lg border border-border px-4 py-2 text-[13px] hover:bg-hover"
       >
        {t.mobileReconnect}
       </button>
      </div>
     ) : (
      <>
       <div className="mobile-thread">
        <Thread />
       </div>
       <MobileComposer
        sid={routeId}
        onSent={() => void refresh()}
        onStop={() => void api.stop(routeId).then(refresh).catch(() => undefined)}
       />
      </>
     )}
    </div>
   ) : (
    <>
     <SessionList
      sessions={sessions}
      statuses={statuses}
      pending={overview?.pending ?? {}}
      projectNames={projectNames}
      onOpen={openSession}
      onNew={() => setShowNew(true)}
      onRefresh={() => void refresh()}
      refreshing={refreshing}
      onSettings={() => setSettingsOpen(true)}
     />
     {overviewError && (
      <div className="px-4 pb-2 text-[11px] text-warn">{overviewError}</div>
     )}
    </>
   )}

   {showNew && (
    <NewSessionSheet
     projects={projects}
     onClose={() => setShowNew(false)}
     onCreated={(id) => {
      setShowNew(false);
      openSession(id);
     }}
    />
   )}

   {settingsOpen && (
    <div className="mobile-sheet-backdrop" onClick={() => setSettingsOpen(false)}>
     <div className="mobile-sheet" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between border-b border-border-soft px-4 py-3">
       <h2 className="text-[16px] font-medium">{t.mobileSettings}</h2>
       <button
        type="button"
        onClick={() => setSettingsOpen(false)}
        className="cursor-pointer rounded-lg px-3 py-1.5 text-[13px] text-muted hover:bg-hover"
       >
        {t.close}
       </button>
      </div>
      <div className="space-y-5 px-4 py-4">
       <div className="flex items-center gap-3">
        <Mobile size={18} className="text-accent" />
        <div className="min-w-0">
         <div className="truncate text-[14px]">{device?.name ?? t.mobilePairTitle}</div>
         <div className="text-[11px] text-faint">{conn === "open" ? t.mobileConnected : t.mobileOffline}</div>
        </div>
       </div>

       <div>
        <div className="text-[12px] text-faint">{t.mobileTheme}</div>
        <div className="mt-2 flex rounded-lg border border-border p-0.5">
         {THEMES.map((mode) => (
          <button
           key={mode}
           type="button"
           onClick={() => useApp.getState().setTheme(mode)}
           className={`flex-1 cursor-pointer rounded-md py-2 text-[13px] ${
            theme === mode ? "bg-accent/15 text-accent" : "text-muted"
           }`}
          >
           {mode === "system" ? t.themeSystem : mode === "dark" ? t.themeDark : t.themeLight}
          </button>
         ))}
        </div>
       </div>

       <div>
        <div className="text-[12px] text-faint">{t.mobileLanguage}</div>
        <div className="mt-2 flex rounded-lg border border-border p-0.5">
         {LOCALE_MODES.map((mode) => (
          <button
           key={mode}
           type="button"
           onClick={() => useApp.getState().setLocaleMode(mode as LocaleMode)}
           className={`flex-1 cursor-pointer rounded-md py-2 text-[13px] ${
            localeMode === mode ? "bg-accent/15 text-accent" : "text-muted"
           }`}
          >
           {mode === "system" ? t.localeSystem : LOCALE_NAMES[mode as "zh-CN" | "en"]}
          </button>
         ))}
        </div>
       </div>

       <button
        type="button"
        onClick={() => {
         setSettingsOpen(false);
         setConfirmUnpair(true);
        }}
        className="w-full cursor-pointer rounded-lg border border-danger/40 py-2.5 text-[14px] text-danger hover:bg-danger/10"
       >
        {t.mobileUnpair}
       </button>
      </div>
     </div>
    </div>
   )}

   <ConfirmDialog
    open={confirmUnpair}
    title={t.mobileUnpair}
    detail={t.mobileUnpairConfirm}
    confirmLabel={t.mobileUnpair}
    danger
    onConfirm={() => void unpair()}
    onCancel={() => setConfirmUnpair(false)}
   />
  </div>
 );
}
