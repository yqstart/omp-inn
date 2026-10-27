import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { installInputAssistOff } from "./lib/inputAssist";
import { installNativeContextMenuOff } from "./lib/contextMenu";
import "./index.css";

// 关掉系统对输入框的「输入提示」（拼写建议 / 自动大写 / 智能标点 / 自动填充）：
// 现有与之后插入的所有 input / textarea / contenteditable 都会被装饰，
// 后挂载的输入框也无须重挂——见 lib/inputAssist.ts。
installInputAssistOff();

// 全 app 禁用系统默认右键菜单（WebView 的重新载入 / 检查元素 / 拼写建议等）：
// 左栏行级操作已退回 hover 图标（V43），没有自定义菜单需要共存——见 lib/contextMenu.ts。
installNativeContextMenuOff();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
