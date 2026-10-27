import { useCallback, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { ChevronDown } from "reicon-react";
import "@xterm/xterm/css/xterm.css";
import { api } from "@shared/api";
import type { TerminalEvent } from "@shared/types";
import { useApp } from "../../stores/app";
import { TEXT, fmt } from "../../lib/locale";
import { readTermTheme } from "../../lib/termTheme";
import { useText } from "../../lib/useText";

/**
 * 右栏「终端」页签的渲染核心：一个 cwd 一个终端 = xterm 实例 + 到后端 PTY 的双向管道。
 *
 * 生命周期约定：
 * - xterm 实例随组件建立 / 销毁（多 cwd 保留 = 父组件把非当前终端 `hidden`，滚动缓冲区与服务进程都不丢）；
 * - PTY 随 `cwd + spawnSeq` spawn（「重新打开」= spawnSeq+1，不重建 xterm）；
 * - 卸载时 kill 进程；高频字节流只进 xterm，**不进 store**。
 *
 * 尺寸：隐藏态（`display:none`）测不到尺寸，fit 只在可见时做——可见性用 ref 追踪，
 * 避免 ResizeObserver 因 `visible` 变化被反复重建。
 */
export function TerminalPane({ id, cwd, visible }: { id: string; cwd: string; visible: boolean }) {
 const t = useText();
 const hostRef = useRef<HTMLDivElement | null>(null);
 const termRef = useRef<Terminal | null>(null);
 const fitRef = useRef<FitAddon | null>(null);
 const visibleRef = useRef(visible);
 /** shell 是否还活着（退出后浮出「重新打开」）。 */
 const [status, setStatus] = useState<"running" | "exited">("running");
 const [exitCode, setExitCode] = useState<number | null>(null);
 /** 重启计数：「重新打开」自增即重新 spawn（xterm 实例与回看缓冲不动）。 */
 const [spawnSeq, setSpawnSeq] = useState(0);
 /** 视口是否停在滚动缓冲底部——「回到最新输出」悬浮键的唯一显隐信号。 */
 const [atBottom, setAtBottom] = useState(true);
 /** 脚本页签投递过来的待运行命令（见 `store.runInTerminal`）。 */
 const pendingRun = useApp((s) => s.pendingTerminalRun);
 /** 已消费的命令序号：pendingRun 生效与 spawn 完成两条路都会走到，同一条不许写两次。 */
 const consumedRunRef = useRef(0);
 /** PTY 是否已 spawn 成功：命令只能写进有主儿的终端（spawn 还没回来时先不写）。 */
 const spawnedRef = useRef(false);

 /**
  * 把投递过来的命令写进 PTY。
  *
  * 写入时机交给后端（`terminalWriteReady`）：shell 启动期还在跑 rc 时终端是 cooked 模式，这时写进去
  * 命令会先被 tty 行规程回显一遍、行编辑器起来后再把输入缓冲连提示符重画一遍——界面上就成了
  * 两行同样的命令（实际只执行一次）。后端等行编辑器把终端切到 raw（提示符出来、能读输入了）再写。
  */
 const flushPendingRun = useCallback(() => {
  const p = useApp.getState().pendingTerminalRun;
  if (!p || p.terminalId !== id || consumedRunRef.current === p.seq) return;
  consumedRunRef.current = p.seq;
  void api.terminalWriteReady(id, `${p.command}\r`).catch(() => {});
  useApp.getState().clearTerminalRun(p.seq);
 }, [id]);

 // 投递来的命令（正常在 PTY 建好那一刻就写；这里兜「终端已存在、命令后到」的情况）
 useEffect(() => {
  if (!pendingRun || pendingRun.terminalId !== id) return;
  if (status === "exited") {
   // shell 已经退出：这条命令没有落点。清掉**并就地说明**——不静默丢，也不自动重启
   // （用户可能正看着回看内容；重开终端这个动作交给他，点「重新打开」即可）。
   consumedRunRef.current = pendingRun.seq;
   useApp.getState().clearTerminalRun(pendingRun.seq);
   termRef.current?.write(`\r\n\x1b[33m${t.termRunNoShell}\x1b[0m\r\n`);
   return;
  }
  if (spawnedRef.current) flushPendingRun();
 }, [pendingRun, id, flushPendingRun, status, t]);

 // xterm 实例（仅随组件建立 / 销毁）
 useEffect(() => {
  const host = hostRef.current;
  if (!host) return;
  const cs = getComputedStyle(document.documentElement);
  const x = new Terminal({
   fontFamily: cs.getPropertyValue("--font-mono").trim() || "Menlo, monospace",
   // 右栏 320px 宽：12px 等宽字一屏约 44 列，够看常规命令输出
   fontSize: 12,
   lineHeight: 1.25,
   cursorBlink: true,
   cursorStyle: "bar",
   scrollback: 5000,
   // macOS 的 Option 当 Meta（shell 里的 Alt+B / Alt+F 才到得了 PTY）
   macOptionIsMeta: true,
   theme: readTermTheme(),
  });
  const fit = new FitAddon();
  x.loadAddon(fit);
  x.open(host);
  termRef.current = x;
  fitRef.current = fit;
  const dataSub = x.onData((d) => {
   void api.terminalWrite(id, d).catch(() => {});
  });
  // Cmd+C 复制选中：xterm 自带 canvas 渲染，选区不在 DOM 里，浏览器原生复制拿不到
  x.attachCustomKeyEventHandler((e) => {
   if (e.type === "keydown" && e.metaKey && e.key === "c" && x.hasSelection()) {
    void navigator.clipboard?.writeText(x.getSelection()).catch(() => {});
    return false;
   }
   return true;
  });
  // 贴底跟踪：滚动与每次写入解析后各判一次——只有布尔翻转才写 React state
  const syncAtBottom = () => {
   const buf = x.buffer.active;
   const bottom = buf.viewportY >= buf.baseY;
   setAtBottom((cur) => (cur === bottom ? cur : bottom));
  };
  const scrollSub = x.onScroll(syncAtBottom);
  const parsedSub = x.onWriteParsed(syncAtBottom);
  // 皮肤切换（<html class="dark">）→ 跟 token 换色
  const mo = new MutationObserver(() => {
   if (termRef.current) termRef.current.options.theme = readTermTheme();
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => {
   dataSub.dispose();
   scrollSub.dispose();
   parsedSub.dispose();
   mo.disconnect();
   x.dispose();
   termRef.current = null;
   fitRef.current = null;
  };
 }, [id]);

 // PTY 生命周期：挂载 + 每次「重新打开」
 useEffect(() => {
  const x = termRef.current;
  const fit = fitRef.current;
  if (!x || !fit) return;
  let alive = true;
  setStatus("running");
  setExitCode(null);
  // spawn 完成前写命令没有落点（或落到上一次的旧进程）：命令统一在 spawn 成功后写，
  // 由后端等 shell 进入可输入状态（见 `flushPendingRun`）
  spawnedRef.current = false;
  // spawn 前先量一次尺寸；测不到就用 xterm 当前 cols/rows（可见后会补一次 resize）
  try {
   fit.fit();
  } catch {
   // 忽略：尺寸拿不到不阻断 spawn
  }
  const cols = Math.max(2, x.cols || 80);
  const rows = Math.max(2, x.rows || 24);
  void (async () => {
   // 重启路径：确保同 id 的旧进程先被收掉（已退出时 kill 是 no-op）
   await api.terminalKill(id).catch(() => {});
   if (!alive) return;
   const channel = new Channel<TerminalEvent>();
   channel.onmessage = (e) => {
    if (!alive) return;
    if (e.type === "data") {
     termRef.current?.write(e.data);
    } else {
     setStatus("exited");
     setExitCode(e.code);
    }
   };
   try {
    await api.terminalSpawn({ id, cwd, cols, rows }, channel);
    if (!alive) return;
    // PTY 有主儿了：脚本页签投递来的命令交给后端，由它等行编辑器进入 raw 再写
    spawnedRef.current = true;
    flushPendingRun();
   } catch (err) {
    if (!alive) return;
    const txt = TEXT[useApp.getState().locale];
    termRef.current?.write(`\r\n\x1b[31m${fmt(txt.termStartFailed, String(err))}\x1b[0m\r\n`);
    setStatus("exited");
    setExitCode(null);
    // 终端起不来，投递过来的命令没有落点：清掉，别让 `pendingTerminalRun` 一直挂着
    const p = useApp.getState().pendingTerminalRun;
    if (p && p.terminalId === id) useApp.getState().clearTerminalRun(p.seq);
   }
  })();
  return () => {
   alive = false;
  };
 }, [id, cwd, spawnSeq, flushPendingRun]);

 // 尺寸跟随（右栏宽度变化 / 窗口缩放）：隐藏态不量、不推
 useEffect(() => {
  const host = hostRef.current;
  if (!host) return;
  const ro = new ResizeObserver(() => {
   if (!visibleRef.current) return;
   const x = termRef.current;
   const fit = fitRef.current;
   if (!x || !fit) return;
   try {
    fit.fit();
   } catch {
    return;
   }
   void api.terminalResize(id, x.cols, x.rows).catch(() => {});
  });
  ro.observe(host);
  return () => ro.disconnect();
 }, [id]);

 // 切到本终端（页签激活 / 面板展开）：布局落定后再量一次、推尺寸、聚焦
 useEffect(() => {
  visibleRef.current = visible;
  if (!visible) return;
  const raf = requestAnimationFrame(() => {
   const x = termRef.current;
   const fit = fitRef.current;
   if (!x || !fit) return;
   try {
    fit.fit();
   } catch {
    // 忽略：尺寸拿不到就保持原样
   }
   void api.terminalResize(id, x.cols, x.rows).catch(() => {});
   x.focus();
  });
  return () => cancelAnimationFrame(raf);
 }, [visible, id]);

 // 卸载（终端被关掉 / 项目切走且超出保留数）= kill 进程
 useEffect(() => {
  const current = id;
  return () => {
   void api.terminalKill(current).catch(() => {});
  };
 }, [id]);

 const visibleClass = visible ? "" : "hidden";
 return (
  <div className={`relative h-full w-full ${visibleClass}`} aria-label={t.termPaneAria}>
   {/*
    终端容器底部留 24px（`bottom-6`）：最后一行不贴着面板底。
    这里是**抬高容器**而不是给容器 `pb-6`——xterm 的 FitAddon 在算可用高度时会再减一次
    容器的 padding（`getComputedStyle().height` 已是 content 高），用 padding 会双重扣减
    （实际留出 ~48px 且少两行）。
   */}
   <div ref={hostRef} className="absolute inset-x-0 top-0 bottom-6 px-1.5 pt-1" />
   {/* 回看中（视口离开底部）浮出「回到最新输出」键：一键回底再把键盘焦点交还终端 */}
   {!atBottom && status === "running" && (
    <button
     type="button"
     onClick={() => {
      const x = termRef.current;
      if (!x) return;
      x.scrollToBottom();
      x.focus();
     }}
     aria-label={t.termScrollToBottom}
     title={t.termScrollToBottom}
     className="absolute bottom-3 left-1/2 z-10 flex size-7 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full border border-border bg-elevated text-muted shadow-pop transition-colors duration-100 hover:bg-hover hover:text-foreground"
    >
     <ChevronDown size={14} aria-hidden />
    </button>
   )}
   {status === "exited" && (
    <div className="absolute inset-0 flex items-center justify-center bg-background/75">
     <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-elevated px-5 py-4 shadow-pop">
      <p className="text-center text-[12px] text-muted">
       {exitCode == null || exitCode === 0 ? t.termExited : fmt(t.termExitedCode, exitCode)}
      </p>
      <button
       onClick={() => setSpawnSeq((n) => n + 1)}
       className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-[12px] text-primary-foreground transition-opacity duration-100 hover:opacity-90"
      >
       {t.termRestart}
      </button>
     </div>
    </div>
   )}
  </div>
 );
}
