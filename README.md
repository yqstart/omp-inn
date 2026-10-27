# omp-inn

[oh-my-pi（`omp`）](https://github.com/ldx/oh-my-pi) 的桌面端：**聊天形态的 omp 工作台**。

把 omp 的编码代理会话带进一个专注的桌面聊天界面——项目与会话管理、流式对话、工具与审批、队列与插话、归档与统计，全部在聊天形态内完成。右栏工作台另提供文件目录、Git 图谱、项目脚本与多开终端（PTY 里的登录 shell）。

## 它长什么样

- **左栏**：工作区 → 项目 → 会话树（搜索 / 归档 / 拖拽排序 / git 徽章）；
- **中列**：会话消息流（Markdown / 工具卡 / 审批卡 / 流式渲染 / 轮次定位轨）＋ 输入卡（项目 / 分支 / 提交键 → 输入区 → `+` / 执行模式 / Fast / 模型 / 思考档 / 发送）＋ 卡下统计条（会话统计 / Token 用量 / 上下文 / 供应商用量）；
- **右栏工作台**（⌘⇧G，可拖宽）：文件目录树 / Git 图谱（提交图与只读 diff）/ 项目脚本 / 多开终端四页签；
- **设置**：常用设置（`omp config` 目录）/ omp 约束（全局 `AGENTS.md` / `RULES.md` / `rules/*.md`）/ 系统授权（macOS TCC 四项）/ 远程控制 / 模型与供应商 / 插件 / 技能 / 记忆 / 使用统计 / 已归档对话；
- **周边**：应用与 omp 运行时更新、供应商用量、跨项目文件引用、提交与推送；
- **手机**：扫码配对后在手机浏览器继续会话（PWA；局域网 / Tailscale HTTPS；审批只支持允许一次 / 拒绝）。

界面视觉与布局按 [`docs/ui-contracts.md`](docs/ui-contracts.md) 的设计约定对齐 Codex / ZCode 范式。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | Tauri v2（Rust） |
| 前端 | React 19 + TypeScript + Vite + Tailwind v4 + Zustand |
| 后端 | Rust + tokio + serde；`reqwest`（供应商用量补充探针） |
| 运行时 | `omp` 18.x（用户自行安装，不随仓库分发） |
| 工具链 | Node 22 + pnpm 11；Rust stable |

## 开发

```bash
pnpm install
pnpm tauri:dev        # 桌面壳联调（推荐）
pnpm dev              # 纯前端

pnpm check            # 提交前全过：typecheck + lint + test + e2e:ipc
pnpm build            # tsc + vite 构建

cargo test --manifest-path src-tauri/Cargo.toml
```

前置条件见 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)；开发环境、检查与提交约定见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，工程导航见 [`AGENTS.md`](AGENTS.md)。

## 构建

```bash
pnpm tauri:build      # 本机发布构建（产物见 src-tauri/target/release/bundle/）
pnpm icon             # 从 design-system/icon/omp-inn-icon.svg 重生成应用图标
pnpm file-icons       # 从 material-icon-theme 重新生成右栏文件树的图标子集
```

macOS 签名证书见 `scripts/make-signing-cert.sh`；版本号同步位置与发版流程见 [`AGENTS.md`](AGENTS.md) 的「发版与更新」，每个版本的变更记录写 [`CHANGELOG.md`](CHANGELOG.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [`CHANGELOG.md`](CHANGELOG.md) | 变更记录（版本节即 Release 说明）|
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 开发环境 / 检查 / 贡献与提交约定 |
| [`AGENTS.md`](AGENTS.md) | 工程导航、铁律与命令（改代码前读）|
| [`docs/architecture.md`](docs/architecture.md) | 架构与运行时（会话进程 / 数据面 / 源码地图）|
| [`docs/ui-contracts.md`](docs/ui-contracts.md) | 界面与交互口径（三栏 / 输入卡 / 消息列 / 工作台）|
| [`docs/integrations.md`](docs/integrations.md) | 设置 / 供应商 / 系统授权 / git / 更新链路 |
| [`SECURITY.md`](SECURITY.md) | 安全问题报告 |

## 许可

[MIT](LICENSE)
