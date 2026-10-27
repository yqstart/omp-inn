/**
 * 全 app 禁用系统默认右键菜单（2026-10-10 立，2026-10-13 V43 精简）。
 *
 * 左栏行（工作区段头 / 项目头 / 会话行 / 目录行）的自定义右键菜单已退回 hover 图标
 * （V43，用户口径：「将工作区、项目、会话上的右键菜单去除，改为悬浮展示以图标形式展示到行内」），
 * 这里只保留最后一块职责：`installNativeContextMenuOff`——WebView 的原生右键菜单
 * （重新载入 / 检查元素 / 复制 / 拼写建议…）在任何区域都不弹出。
 */

let installed = false;

/** 幂等安装：全 app 只挂一次（`main.tsx` 启动时调用）；已装则 no-op。 */
export function installNativeContextMenuOff(): void {
 if (installed) return;
 installed = true;
 document.addEventListener("contextmenu", (event) => event.preventDefault());
}
