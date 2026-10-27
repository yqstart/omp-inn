import { useCallback, useEffect } from "react";
import { Bolt, Check, ChevronDown, Edit, Shield } from "reicon-react";
import { useApp } from "../../stores/app";
import { fmt } from "../../lib/locale";
import { useDropdown } from "../../lib/useDropdown";
import { useText } from "../../lib/useText";
import { APPROVAL_CYCLE, applyApproval, ensureGlobalApproval } from "../../lib/sessionApproval";

/**
 * 执行模式菜单（v2 §3，对齐 ZCode / Codex 的 `Full access ▾`）：触发按钮 = 图标 + 当前档名，
 * 菜单行 = 图标 + 名称 + 说明 + 当前项勾选。
 *
 * **真值口径（2026-10-14）**：触发键显示**本会话当前生效**的档位（覆盖优先，见 `lib/sessionApproval.ts`），
 * 没读到 omp 的全局默认前显示「读取中…」——不再拿 `"write"` 冒充真值（那正是「每次新开对话都不对」的来源）。
 * 选中一行 = 写 omp 全局默认（新会话的档位）+ 本会话覆盖（立即生效：idle 重启 / 运行中挂起到本轮结束）。
 *
 * 三档（与 omp 一一对应，不造不可用项）：`always-ask` 每次询问 / `write` 写入询问 / `yolo` 自动通过。
 * `yolo` 的说明行带危险标注（跳过所有确认），档名走 danger 色——颜色之外还有说明文字，不作唯一信号。
 */
export function ApprovalModeMenu() {
 const t = useText();
 const { activeSessionId, composerMenu } = useApp();
 const open = composerMenu === "approval";
 const setOpen = useCallback(
  (v: boolean) => useApp.setState({ composerMenu: v ? "approval" : null }),
  [],
 );
 const ref = useDropdown(open, () => setOpen(false));
 // 三份状态都订阅 store（不各存拷贝，拷贝会与真实值漂移）：全局默认 + 本会话覆盖 = 触发键与勾选的真值
 // （写入只走 `lib/sessionApproval.ts`；Shift+Tab 循环与本菜单共用同一条链路）。
 const global = useApp((s) => s.globalApproval);
 const session = useApp((s) => (activeSessionId ? (s.sessionApprovals[activeSessionId] ?? null) : null));
 const pendingRestart = useApp((s) => (activeSessionId ? !!s.approvalRestartBySession[activeSessionId] : false));

 // 打开浮层时确保全局默认是真值：App 启动已读过 → 命中缓存不起进程；上一次读失败（omp 不在等）
 // 在这里自然重试，行勾选不会永远停在「读取中…」。
 useEffect(() => {
  if (open) void ensureGlobalApproval();
 }, [open]);

 /** 三档的展示表（顺序 = `APPROVAL_CYCLE`，图标 / 名称 / 说明一次给全）。 */
 const MODES = [
  { id: APPROVAL_CYCLE[0] as string, icon: Shield, name: t.permAlwaysAsk, desc: t.permAlwaysAskDesc },
  { id: APPROVAL_CYCLE[1] as string, icon: Edit, name: t.permWrite, desc: t.permWriteDesc },
  { id: APPROVAL_CYCLE[2] as string, icon: Bolt, name: t.permYolo, desc: t.permYoloDesc },
 ];
 const shown = session ?? global;
 const shownMode = MODES.find((m) => m.id === shown) ?? null;
 const danger = shown === "yolo";

 const pick = async (mode: string) => {
  try {
   await applyApproval(activeSessionId, mode);
  } finally {
   setOpen(false);
  }
 };

 const row = (mode: (typeof MODES)[number], current: boolean) => (
  <button
   key={mode.id}
   onClick={() => void pick(mode.id)}
   className="flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-100 hover:bg-hover"
   aria-pressed={current}
  >
   <mode.icon size={13} aria-hidden className={`mt-0.5 shrink-0 ${mode.id === "yolo" ? "text-danger" : "text-muted"}`} />
   <span className="min-w-0 flex-1">
    <span className={`block text-[13px] ${current ? "font-medium text-foreground" : "text-muted"}`}>{mode.name}</span>
    <span className="block text-[11px] leading-4 text-faint">
     {mode.desc}
     {mode.id === "yolo" && <span className="text-danger">{t.permYoloNote}</span>}
    </span>
   </span>
   {current && <Check size={12} aria-hidden className="mt-0.5 shrink-0 text-accent" />}
  </button>
 );

 return (
  <div className="relative" ref={ref}>
   <button
    onClick={() => setOpen(!open)}
    className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[13px] whitespace-nowrap transition-colors duration-100 hover:bg-hover ${danger ? "text-danger" : open ? "text-foreground" : "text-muted hover:text-foreground"}`}
    aria-label={fmt(t.permAria, shownMode?.name ?? t.permUnknown)}
    aria-expanded={open}
    title={pendingRestart ? t.permPendingRestart : undefined}
   >
    {shownMode ? (
     <shownMode.icon size={13} aria-hidden className="shrink-0" />
    ) : (
     <Shield size={13} aria-hidden className="shrink-0 opacity-40" />
    )}
    <span className={`min-w-0 max-w-32 truncate ${shownMode ? "" : "text-faint"}`}>
     {shownMode?.name ?? t.permUnknown}
    </span>
    {pendingRestart && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden />}
    <ChevronDown size={12} aria-hidden className="shrink-0 opacity-60" />
   </button>
   {open && (
    <div className="absolute bottom-8 left-0 z-10 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-elevated p-1 pb-2 shadow-pop">
     <div className="px-2 pt-1.5 pb-0.5 text-[11px] text-faint">{t.permScopeNote}</div>
     {MODES.map((m) => row(m, m.id === shown))}
     {pendingRestart && <div className="px-2 pt-1 text-[11px] text-warn">{t.permPendingRestart}</div>}
    </div>
   )}
  </div>
 );
}
