# 第三方开源软件声明

本产品（omp-inn）以 MIT 许可证开源，并包含来自以下开源社区的代码与资源。
完整版权与许可证文本以各上游项目仓库为准。

---

## 前端依赖

### React
- 仓库：https://github.com/facebook/react
- 许可证：MIT

### Zustand
- 仓库：https://github.com/pmndrs/zustand
- 许可证：MIT

### Xterm.js（@xterm/xterm、@xterm/addon-fit）
- 仓库：https://github.com/xtermjs/xterm.js
- 许可证：MIT
- 说明：右栏工作台「终端」页签的终端模拟器与尺寸自适应（PTY 里跑的是登录 shell）。

### Vite（@vitejs/plugin-react）
- 仓库：https://github.com/vitejs/vite
- 许可证：MIT

### Tailwind CSS（tailwindcss、@tailwindcss/vite）
- 仓库：https://github.com/tailwindlabs/tailwindcss
- 许可证：MIT

### YAML（yaml）
- 仓库：https://github.com/eemeli/yaml
- 许可证：ISC
- 说明：设置 ›「供应商」页「自定义模型」区块的 `models.yml` 保真编辑——只改被编辑的节点，用户的注释与格式原样保留（零修改往返逐字节一致）。

### Reicon（reicon-react）
- 仓库：https://github.com/dqev/reicon
- 许可证：MIT
- 说明：界面图标（Outline 权重，填充路径）。每个图标按需具名导入，构建期 tree-shake。

### Lexical（lexical、@lexical/react）
- 仓库：https://github.com/facebook/lexical
- 许可证：MIT
- 说明：输入框草稿编辑器（单段落富文本投影、引用芯片节点）。

### Material Icon Theme（material-icon-theme）
- 仓库：https://github.com/material-extensions/vscode-material-icon-theme
- 许可证：MIT
- 说明：右栏文件树的文件类型图标资产（构建期由 `scripts/generate-material-icons.mjs` 裁剪成子集，随包分发）。

### Markdown 渲染（react-markdown、remark-gfm、rehype-highlight）
- 仓库：https://github.com/remarkjs/react-markdown · https://github.com/remarkjs/remark-gfm · https://github.com/rehypejs/rehype-highlight
- 许可证：MIT
- 说明：设置 ›「记忆」页的记忆文件预览与聊天形态（V32）的消息正文 / 更新说明渲染（底层 highlight.js/lowlight）。`react-markdown` 默认不渲染原始 HTML，正文内容不做 `dangerouslySetInnerHTML` 注入。

### Tauri 前端插件（@tauri-apps/api、plugin-dialog/opener/process/updater/notification）
- 仓库：https://github.com/tauri-apps/tauri
- 许可证：Apache-2.0 / MIT（双许可）

### TypeScript / Vitest / ESLint（eslint、typescript-eslint、@eslint/js、eslint-plugin-react-hooks、eslint-plugin-react-refresh、globals）
- 仓库：https://github.com/microsoft/TypeScript · https://github.com/vitest-dev/vitest · https://github.com/eslint/eslint · https://github.com/typescript-eslint/typescript-eslint
- 许可证：Apache-2.0 / MIT / MIT

### jsdom（测试环境）
- 仓库：https://github.com/jsdom/jsdom
- 许可证：MIT
- 说明：纯逻辑单测的 DOM 环境（如 `localStorage` 依赖），仅测试期使用，不进构建产物。

## Rust 依赖

### Tauri（tauri、tauri-build、tauri-plugin-dialog/opener/process/updater/notification）
- 仓库：https://github.com/tauri-apps/tauri
- 许可证：Apache-2.0 / MIT（双许可）

### Tokio
- 仓库：https://github.com/tokio-rs/tokio
- 许可证：MIT

### portable-pty
- 仓库：https://github.com/wezterm/wezterm（portable-pty crate）
- 许可证：MIT
- 说明：右栏工作台终端的 PTY 进程管理（每个终端 = 一个跑在 PTY 里的登录 shell）。

### serde / serde_json / chrono / libc
- 仓库：https://github.com/serde-rs/serde · https://github.com/serde-rs/json · https://github.com/chronotope/chrono · https://github.com/rust-lang/libc
- 许可证：MIT / Apache-2.0（双许可）
- 说明：`libc` 用于进程组信号与终端 termios 查询。

### axum / tower-http / futures-util（远程控制 HTTP/WS）
- 仓库：https://github.com/tokio-rs/axum · https://github.com/tower-rs/tower-http · https://github.com/rust-lang/futures-rs
- 许可证：MIT
- 说明：手机远程控制的内嵌 HTTP/WS 服务、请求体上限与压缩。

### qrcode / if-addrs / sha2 / rand / base64 / subtle（远程控制）
- 仓库：https://github.com/kennytm/qrcode-rust · https://github.com/if-addrs/if-addrs · https://github.com/RustCrypto/hashes · https://github.com/rust-random/rand · https://github.com/marshallpierce/rust-base64 · https://github.com/dalek-cryptography/subtle
- 许可证：MIT（qrcode / if-addrs）/ MIT 或 Apache-2.0（sha2 / rand / base64）/ BSD-3-Clause（subtle）
- 说明：配对二维码、局域网地址枚举、设备 token 哈希 / 常量时间比较。

### reqwest / rustls（HTTP 客户端）
- 仓库：https://github.com/seanmonstar/reqwest · https://github.com/rustls/rustls
- 许可证：Apache-2.0 / MIT（reqwest）；Apache-2.0 / ISC / MIT（rustls）
- 说明：「供应商用量」浮层（入口 = 输入卡底部统计条的第四项）的**补充探针**——对 omp 没有用量探针、但上游提供「API key 可用」查询接口的供应商（commandcode / deepseek）做只读 GET；TLS 走 rustls + webpki-roots（纯 Rust，无系统依赖，四平台构建一致）。

## 上游运行时（不随本仓库分发，需用户另行安装）

### oh-my-pi（omp）
- 仓库：https://github.com/ldx/oh-my-pi
- 本 app 以长驻 `omp --mode rpc-ui` 子进程驱动聊天会话（工作区创建走 `omp worktree add`，
  供应商登录 / 登出走 `omp auth-broker`，设置读写走 `omp config`，用量统计走 `omp usage`，
  补充探针的凭据经 `omp token` 只读取出、只在内存中传递）。
