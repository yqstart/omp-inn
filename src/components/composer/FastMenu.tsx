import { useState } from "react";
import { Bolt, Loader } from "reicon-react";
import { api } from "@shared/api";
import { useApp } from "../../stores/app";
import { useText } from "../../lib/useText";

/**
 * Fast（omp `/fast`）的会话级开关。
 *
 * 口径（omp 18.12.3，2026-10-20 用户口径）：
 * - **Fast 不是换快速模型**：`/fast` 切的是**当前模型的服务档位**（provider priority；
 *   OpenAI `service_tier=priority` / Anthropic `speed=fast` / Google priority）——
 *   它请求供应商的优先通道，可能降低排队 / 首字延迟，但**不保证 tok/s 变快**。
 * - **Ultra（`ultrafast`）只有终端 / TUI 的 `/fast ultra`**：rpc-ui 没有这个开关，
 *   所以界面上不再展示 Ultra，也不伪造可点项。
 * - 界面只留一个闪电图标，且**只在支持 Fast 的模型上显示**：`fastModeSupported` 由后端按
 *   omp `service-tier` 规则从模型元数据（`provider` / `api` / `identity.class`）算出，
 *   选择模型 / 模型变化时更新；不支持直接不渲染。点击开 / 关 priority，开启时变黄；
 *   支持判定为真但运行时仍被拒时，错误原文在图标上方就地显示（下次点击自动清掉）。
 * - 状态真值 = `get_state.fastModeEnabled/Active`（`currentRuntime`）；`set_fast_mode`
 *   回包先乐观回填，后续 `omp-state://` 回读收敛。`enabled` = 设置已开，
 *   `active` = 当前模型 / 供应商真的在用这个档位。
 */
export function FastMenu() {
 const t = useText();
 const activeSessionId = useApp((s) => s.activeSessionId);
 const currentModel = useApp((s) => s.currentModel);
 const runtime = useApp((s) => s.currentRuntime);
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState<{ session: string; model: string; message: string } | null>(null);

 // 只有 omp 声明支持 priority 档位的模型才显示；不支持就在模型选择时直接不出现，
 // 不再等用户点了才报 “Fast mode is unavailable for the current model.”
 // `runtime.model` 与 `currentModel` 必须同源：模型菜单是乐观更新 `currentModel` 的，
 // 切换的一瞬间旧 runtime 还没回来——先按「未知」隐藏，等 set_model 的 omp-state 到达再定。
 const runtimeSelector = runtime?.model ? `${runtime.model.provider}/${runtime.model.id}` : null;
 if (
  !activeSessionId ||
  !currentModel ||
  !runtime ||
  runtimeSelector !== currentModel ||
  runtime.fastModeSupported !== true
 ) {
  return null;
 }

 const enabled = runtime.fastModeEnabled === true;
 const active = runtime.fastModeActive === true;
 /** 错误只对出错的会话 / 模型显示；切换后自然隐藏（不另开 effect 清状态）。 */
 const errorText =
  error && error.session === activeSessionId && error.model === currentModel
   ? error.message
   : null;

 const toggle = async () => {
  if (busy) return;
  const next = !enabled;
  setBusy(true);
  setError(null);
  try {
   const data = await api.setFastMode(activeSessionId, next);
   useApp.setState((s) => ({
    currentRuntime: s.currentRuntime
     ? { ...s.currentRuntime, fastModeEnabled: data.enabled, fastModeActive: data.active }
     : s.currentRuntime,
   }));
  } catch (e) {
   setError({ session: activeSessionId, model: currentModel, message: e instanceof Error ? e.message : String(e) });
  } finally {
   setBusy(false);
  }
 };

 const title = busy
  ? t.fastToggleBusy
  : errorText
    ? errorText
    : enabled
      ? active
        ? t.fastDisableHint
        : t.fastConfiguredNotActive
      : t.fastEnableHint;

 return (
  <div className="relative shrink-0">
   <button
    type="button"
    onClick={() => void toggle()}
    disabled={busy}
    aria-label={title}
    aria-pressed={enabled}
    title={title}
    className={`flex h-7 w-7 cursor-pointer items-center justify-center rounded-md transition-colors duration-100 hover:bg-hover disabled:cursor-default disabled:opacity-50 ${
     enabled ? "text-warn" : "text-muted hover:text-foreground"
    }`}
   >
    {busy ? (
     <Loader size={13} className="animate-spin" aria-hidden />
    ) : (
     <Bolt size={14} aria-hidden />
    )}
   </button>
   {errorText && (
    <div
     role="alert"
     className="absolute right-0 bottom-8 z-10 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-danger/40 bg-elevated px-2.5 py-2 text-[12px] leading-4 text-danger shadow-pop"
    >
     {errorText}
    </div>
   )}
  </div>
 );
}
