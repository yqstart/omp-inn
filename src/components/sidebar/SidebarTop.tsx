import { isWindows } from "../../lib/platform";
import { AppUpdateChip } from "./AppUpdateChip";
import { OmpUpdateChip } from "./OmpUpdateChip";

/**
 * 左栏顶栏（v1 起只剩聊天形态）：两枚 chip（V30 应用更新 / V24 omp 更新）与 macOS 红绿灯同一行。
 *
 * - 整行是窗口拖拽区（`data-tauri-drag-region`）——按钮等交互件的点击不触发拖窗；
 * - 行高 32px：chip 的垂直中心落在 16px，与系统绘制的红绿灯圆心（≈14–16px）同带，
 *   `items-center` 即成对齐——红绿灯位置由 AppKit 决定，壳侧只能对齐，不能搬动；
 * - 左侧 `pl-[72px]` 与中列 `TopBar` 同口径，避让红绿灯（水平 0–72px）。
 * - **Windows 没有红绿灯**（保留系统标题栏，见 `tauri.conf.json`）：用普通内边距，
 *   否则左上角会多出一块 72px 的空白。
 */
export function SidebarTop() {
 return (
  <div
   data-tauri-drag-region
   className={`flex h-8 shrink-0 items-center pr-3 ${isWindows() ? "pl-3" : "pl-[72px]"}`}
  >
   <div className="ml-auto flex min-w-0 items-center gap-1.5">
    <AppUpdateChip />
    <OmpUpdateChip />
   </div>
  </div>
 );
}
