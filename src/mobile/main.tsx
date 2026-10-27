import React from "react";
import ReactDOM from "react-dom/client";
import { installInputAssistOff } from "../lib/inputAssist";
import { applyTheme } from "../lib/theme";
import { useApp } from "../stores/app";
import { MobileApp } from "./MobileApp";
import "../index.css";
import "./mobile.css";

// 传输开关：必须在任何 API 调用之前设置。模块导入本身不调用 api，
// 因此在这里（render 之前）设置就够；`shared/remote.ts` 的判定不缓存。
window.__OMP_REMOTE__ = true;

applyTheme(useApp.getState().theme);
// 全 app 禁系统输入提示（与桌面入口同口径；移动端不装“禁用右键菜单”，长按复制要保留）。
installInputAssistOff();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MobileApp />
  </React.StrictMode>,
);
