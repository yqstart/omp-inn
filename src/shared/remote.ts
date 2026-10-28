/**
 * 手机远程控制的传输层（仅 PWA 模式使用）。
 *
 * 桌面端继续走 Tauri `invoke` / `listen`；手机端由 `mobile.html` 的入口在渲染前
 * 设置 `window.__OMP_REMOTE__ = true`，`api.ts` 与 `useSessionEvents.ts` 据此切换。
 *
 * 协议：
 * - `POST /api/v1/rpc {cmd,args}` → `{ok:true,result}` / `{ok:false,code,message,hint}`；
 * - `WS /api/v1/events` → `{seq,channel,payload}`（channel 与 Tauri 事件同名）；
 * - Cookie 是 HttpOnly 设备令牌，前端拿不到也不需要拿。
 */

import type { RemoteDevice, RemoteOverview } from "./types";

declare global {
  interface Window {
    __OMP_REMOTE__?: boolean;
  }
}

export type RemoteConnState = "connecting" | "open" | "closed" | "unauthorized";

export class RemoteError extends Error {
  code: string;
  hint: string | null;
  constructor(message: string, code = "REMOTE_ERROR", hint: string | null = null) {
    super(message);
    this.name = "RemoteError";
    this.code = code;
    this.hint = hint;
  }
}

export function isRemoteClient(): boolean {
  return typeof window !== "undefined" && window.__OMP_REMOTE__ === true;
}

const RPC_TIMEOUT_MS = 30_000;

let authFailed = false;
let ws: WebSocket | null = null;
let reconnectTimer: number | undefined;
let attempts = 0;
let lastState: RemoteConnState = "closed";

const handlers = new Map<string, Set<(e: { payload: unknown }) => void>>();
const reconnectHandlers = new Set<() => void>();
const stateHandlers = new Set<(s: RemoteConnState) => void>();
const unauthorizedHandlers = new Set<() => void>();

function setState(s: RemoteConnState) {
  if (lastState === s) return;
  lastState = s;
  for (const h of stateHandlers) h(s);
}

export function onRemoteConnection(cb: (s: RemoteConnState) => void): () => void {
  stateHandlers.add(cb);
  cb(lastState);
  return () => stateHandlers.delete(cb);
}

export function onRemoteUnauthorized(cb: () => void): () => void {
  unauthorizedHandlers.add(cb);
  return () => unauthorizedHandlers.delete(cb);
}

export function onRemoteReconnected(cb: () => void): () => void {
  reconnectHandlers.add(cb);
  return () => reconnectHandlers.delete(cb);
}

function markUnauthorized() {
  authFailed = true;
  setState("unauthorized");
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  ws?.close();
  ws = null;
  for (const h of unauthorizedHandlers) h();
}

function errorFrom(body: unknown, fallback: string): RemoteError {
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    const message = typeof o.message === "string" && o.message ? o.message : fallback;
    const code = typeof o.code === "string" ? o.code : "REMOTE_ERROR";
    const hint = typeof o.hint === "string" ? o.hint : null;
    return new RemoteError(hint ? `${message}\n${hint}` : message, code, hint);
  }
  return new RemoteError(fallback);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      signal: ctrl.signal,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json", "X-OMP-Remote": "1" } : {}),
        ...init.headers,
      },
    });
    if (res.status === 401) {
      markUnauthorized();
      throw new RemoteError("设备未配对或已被撤销", "UNAUTHORIZED");
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // 非 JSON 错误（代理页 / 空响应）走通用文案
    }
    if (!res.ok) throw errorFrom(body, `远程请求失败（HTTP ${res.status}）`);
    return body as T;
  } catch (e) {
    if (e instanceof RemoteError) throw e;
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new RemoteError("请求超时，请检查与电脑的连接", "TIMEOUT");
    }
    throw new RemoteError(e instanceof Error ? e.message : "无法连接电脑");
  } finally {
    window.clearTimeout(timer);
  }
}

function hasChannelArg(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  return Object.values(args as Record<string, unknown>).some((v) => {
    if (!v || typeof v !== "object") return false;
    return (v as { constructor?: { name?: string } }).constructor?.name === "Channel";
  });
}

export async function remoteInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (hasChannelArg(args)) {
    throw new RemoteError("远程模式不支持流式通道命令", "CHANNEL_UNSUPPORTED");
  }
  const body = await request<{ ok?: boolean; result?: T }>("/api/v1/rpc", {
    method: "POST",
    body: JSON.stringify({ cmd, args: args ?? {} }),
  });
  if (body?.ok === false) throw errorFrom(body, "远程命令失败");
  return body?.result as T;
}

// ---------- WebSocket ----------

function dispatch(channel: string, payload: unknown) {
  const set = handlers.get(channel);
  if (!set) return;
  for (const h of set) {
    try {
      h({ payload });
    } catch {
      // 单个监听器异常不许拖垮整条事件流
    }
  }
}

function scheduleReconnect() {
  if (authFailed || reconnectTimer !== undefined) return;
  const delay = Math.min(15_000, 500 * 2 ** Math.min(attempts, 5));
  attempts += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    ensureSocket();
  }, delay);
}

function ensureSocket() {
  if (authFailed) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  setState("connecting");
  let socket: WebSocket;
  try {
    socket = new WebSocket(`${proto}://${location.host}/api/v1/events`);
  } catch {
    setState("closed");
    scheduleReconnect();
    return;
  }
  ws = socket;
  socket.onopen = () => {
    attempts = 0;
  };
  socket.onmessage = (ev) => {
    let frame: { channel?: string; payload?: unknown };
    try {
      frame = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (!frame.channel) return;
    if (frame.channel === "remote://hello") {
      // 服务端先订阅事件再发送 hello；此时才可认为接收通道就绪。
      setState("open");
      for (const h of reconnectHandlers) {
        try { h(); } catch { /* 忽略 */ }
      }
    }
    if (frame.channel === "remote://lagged") {
      // 广播积压：关闭后重连，由页面补历史 / 待审批
      socket.close();
      return;
    }
    dispatch(frame.channel, frame.payload);
  };
  socket.onerror = () => {
    // onclose 一定会来；这里不重复调度
  };
  socket.onclose = (ev) => {
    if (ws === socket) ws = null;
    if (ev.code === 4401) {
      markUnauthorized();
      return;
    }
    setState(authFailed ? "unauthorized" : "closed");
    scheduleReconnect();
  };
}

/** 与 Tauri `listen` 同形：返回 Promise<UnlistenFn>。 */
export async function remoteListen<T>(
  channel: string,
  handler: (e: { payload: T }) => void,
): Promise<() => void> {
  const set = handlers.get(channel) ?? new Set();
  const wrapped = handler as (e: { payload: unknown }) => void;
  set.add(wrapped);
  handlers.set(channel, set);
  ensureSocket();
  return () => {
    const cur = handlers.get(channel);
    if (!cur) return;
    cur.delete(wrapped);
    if (cur.size === 0) handlers.delete(channel);
  };
}

// ---------- 远程专用 HTTP ----------

export async function remoteMe(): Promise<{ device: RemoteDevice; protocol: number }> {
  const out = await request<{ device: RemoteDevice; protocol: number }>("/api/v1/me");
  authFailed = false;
  ensureSocket();
  return out;
}

export async function remotePair(secret: string, name: string): Promise<{ device: RemoteDevice }> {
  const out = await request<{ device: RemoteDevice }>("/api/v1/pair", {
    method: "POST",
    body: JSON.stringify({ secret, name }),
  });
  authFailed = false;
  ensureSocket();
  return out;
}

export async function remoteLogout(): Promise<void> {
  try {
    await request("/api/v1/logout", { method: "POST", body: "{}" });
  } finally {
    authFailed = true;
    ws?.close();
    ws = null;
    setState("unauthorized");
  }
}

export async function remoteOverview(limit = 200): Promise<RemoteOverview> {
  return request<RemoteOverview>(`/api/v1/overview?limit=${Math.max(1, Math.min(500, limit))}`);
}

export async function remotePending(sid: string): Promise<Record<string, unknown>[]> {
  const out = await request<{ frames?: Record<string, unknown>[] }>(
    `/api/v1/pending?sid=${encodeURIComponent(sid)}`,
  );
  return Array.isArray(out?.frames) ? out.frames : [];
}


