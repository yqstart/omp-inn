# 贡献指南

感谢关注 omp-inn。欢迎 Issue、讨论与 Pull Request。

## 开发环境

| 工具 | 建议版本 |
|---|---|
| Node.js | 22 及以上 |
| pnpm | 11 及以上 |
| Rust | stable（已验证 1.97）+ `cargo-tauri` |
| `omp` | 18.x |
| 系统 | macOS（Apple Silicon / Intel）、Windows x64、Linux x64 |

额外依赖见 [Tauri 前置条件](https://v2.tauri.app/start/prerequisites/)。

## 本地运行

```bash
git clone https://github.com/yqstart/omp-inn.git
cd omp-inn
pnpm install
pnpm tauri:dev
```

仅检查前端类型与打包（无需完整桌面壳）：

```bash
pnpm build
```

常用检查（提交前请全过；等价于 typecheck + lint + test + e2e:ipc）：

```bash
pnpm check
```

仅检查 Rust 侧（含单测）：

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

联调无需真实 LLM 时，以 Rust 慢测试为准（`cargo test --manifest-path src-tauri/Cargo.toml -- --ignored`，
`runtime.rs` 的 `real_rpc_*` 用真实 `omp` 做回环）。

## 贡献方向

- 当前主战场：聊天形态的体验打磨（消息流、输入卡、右栏工作台、设置视图）与四平台产物验证
- Windows / Linux 打包验证
- 文档与翻译

明确不做（请勿提交）：编辑器 / 内置浏览器 / SSH / PR 集成、
分屏与多窗口、worktree 生命周期管理、云同步 / 定时任务、终端形态的会话模型
（终端只作为右栏工作台的页签存在）；手机端只做远程控制 PWA，不做原生移动端 App。

## 提交约定

- 中文描述，一事一 PR；UI 变更请附截图；架构变更请同步 `docs/` 对应文档，新增硬约束同步 `AGENTS.md` 铁律。
- 禁止事项：不新增伪实时轮询（实时性走事件通道或既有轮询口径）；前端不自算 token 用量；
  会话改名走 omp 原生能力（`set_session_name` / `/rename`），壳侧不留本地覆盖。
- 不得提交密钥、Token、私钥、签名证书与个人路径（见 [SECURITY.md](SECURITY.md)）。

## 行为准则

请遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)（Contributor Covenant 2.1 中文简述版）。
