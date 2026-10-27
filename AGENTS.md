# omp-inn 工程导航

oh-my-pi（`omp`）的桌面端：**聊天形态的 omp 工作台**（Tauri v2 + React 19 + TS + Tailwind v4 + Zustand，pnpm）。

**本文件只放导航、铁律、命令与边界。** 实现方案按主题分在 `docs/`（见下表），不要指望在这里读到机制细节。

## 文档索引

| 文档 | 内容 |
|---|---|
| `AGENTS.md` | 本文件：铁律、技术基线、源码目录、命令、范围边界 |
| `docs/architecture.md` | 进程模型 / 会话身份 / 发送与队列 / 状态收敛 / 标题 / 图片 / 统计 / 内存 / 远程 / 源码地图 |
|`docs/ui-contracts.md`|三栏布局 / 输入卡（草稿、面板、`@`、执行模式、思考档、Fast）/ 消息列 / 左栏 / 工作台|
| `docs/integrations.md` | 设置页 / 技能 / 模型角色 / 供应商与探测 / 系统授权 / git / 更新链路 |
| `CHANGELOG.md` | 更新日志（发版节 = Release 说明） |
| `CONTRIBUTING.md` | 开发环境、检查、贡献与提交约定 |
| `SECURITY.md` | 安全问题报告与威胁模型 |

**阅读规则**：改哪个方向先读对应 docs（会话/数据面 → architecture；组件交互 → ui-contracts；设置/供应商/git → integrations）。docs 与本文件冲突 = 文档过期：按最近一次用户口径把两者统一（铁律是红线，机制细节以 docs 为准）；口径不明时先问，不许按猜测实现。

## 技术基线

- 壳：Tauri v2（`src-tauri/`，identifier `com.ompinn.app`）。自绘标题栏用 `data-tauri-drag-region` + `core:window:allow-start-dragging`；**要整条可拖就写 `="deep"`**（裸属性只认直接命中该元素的 mousedown；clickable 元素由拖拽脚本自动短路）。macOS 产物走自签名证书（`scripts/`）；Windows 保留系统标题栏、不做红绿灯留白。
- 前端：React 19 + Vite + Tailwind v4 + Zustand。
- 后端：Rust + tokio + serde；`reqwest`（供应商用量补充探针）。
- 工具链：Node 22 + pnpm 11；Rust stable。上游运行时：`omp` 18.x（不随仓库分发）。

## 源码目录

```
src/
  app/App.tsx          # 顶层装配（三栏 + 设置视图 + 全局浮层与快捷键）
  mobile/              # 手机 PWA（mobile.html）：配对 / 会话列表 / MobileComposer，复用 Thread 与 useSessionEvents
  components/          # sidebar / workbench / thread / composer / pickers / settings / usage / update / git
  lib/                 # 视图消息、流式渲染、滚动、补全、git 读写、设置搜索、主题与 locale
  shared/              # api（invoke 唯一入口）/ ipc / types / remote（transport + 401）
  stores/app.ts        # Zustand 全局状态
src-tauri/src/
  remote/              # 手机远程控制（axum HTTP/WS、配对、白名单、事件镜像）
  runtime.rs images.rs storage.rs pty.rs proc.rs wsl.rs
  commands/mod.rs context.rs session_scan.rs overlay.rs git_*.rs project_*.rs workspace_fs.rs
  settings.rs constraints.rs skills.rs plugins.rs providers.rs models_config.rs system_permissions.rs
  usage.rs live_stats.rs provider_usage.rs provider_models.rs extra_usage.rs memories.rs omp_update.rs
scripts/               # e2e-ipc-selfcheck / 图标生成 / changelog-notes / fixup-latest-json / 签名证书 / tauri-build
```

完整文件职责见 `docs/architecture.md` 的「源码地图」。

## 铁律

跨模块、违背就会出用户可见故障的结论。机制与理由见对应 docs。

### 会话与运行时

- 每会话一个长驻 `omp --mode rpc-ui` 进程；事件通道 `omp-event/status/state://<sid>` 用会话 id 命名；单会话 `kill_runtime`、退出 `kill_all`。
- **会话身份 = 完整 uuid**。定位 / `--resume` / 删除一律不许退回 8 字符前缀（uuid v7 同分钟内前缀相同）。
- **open-elsewhere** 会 fork 出新身份：壳侧以 spawn 返回的真实 sid 为准，前端全程用 `opened.id`，不许用请求 id 继续。
- `create_session` 的 `last_model` / `last_thinking` 只是偏好：omp 对非法参数直接退出 → 去掉参数降级重试一次 + 清失效偏好 + 回包带 `FallbackNotice`；前端落本地说明行，不许静默换模型。
- 发送：idle = Enter；running = Enter 插话 / Tab 排队 / Esc 中断并交还队列。队列以 omp 的 `queue_update` 为真值，`applyQueue` 唯一写入面。
- **`/` 开头的命令不被 running 改道**：`steer` / `follow_up` 不注入技能，一律走 `run_slash`。
- 状态收敛：终态 `agent_end` 与 `session_settled`（含 `awaitingAsyncWork`）→ idle；`open_session` 回包不许把前端状态压成 idle。
- `SessionView.running` 由进程表活动态派生（running / awaiting-approval），不存「进程在任」快照。

### 数据与持久化

- **项目名 = 覆盖层路径末段**；外部改名（项目目录或任一上级目录改名）靠 `Project.path_ids` 的目录身份链跟随（`list_projects` / `list_checkouts` / `list_sessions` 读取前对账，前端切回前台 / 可见时兜底对账）。改变父目录的移动 / 老覆盖层无身份链 / 跨卷改名都找不回：保持「目录缺失」，不许按名字猜；**绝不改写会话 jsonl 的 `cwd`**，旧会话仍指向旧目录。
- 图片：jsonl / 历史里的 `blob:sha256:<hash>` **绝不许**当 base64 拼 `data:` URL；`blobRefOf` 只认 64 位小写 hex。
- 使用统计去重只认 `usage.rs` 的 `usage_key`（`sid|responseId`，缺失时 `sid|时间戳|用量`）；两路都有时以 jsonl 为准，不许加时间窗口 / 文件存在性判据。
- 设置写入口径：omp 侧只经 CLI；**直接写文件的只有两处**——`models.yml` 与 omp 约束文件（`AGENTS.md` / `RULES.md` / `rules/*.md`），都必须 hash 乐观锁 + 备份 + 原子写。
- **会话 jsonl 永远不由壳侧删除**；本应用偏好只落 localStorage。
- 内存：`eventsBySession` 只留最近 3 个会话（running 豁免）；工具输出封顶 100K 字符；终端字节流 / 流式帧不进 store。

### 前端

- 标题：显示层一律剥掉 omp 标题卡的「图标 + 大写短码」前缀（`sessionTitleForDisplay`）；`title_change` 只更新标题、不产出正文行。
- 草稿 = Lexical 编辑器（恒定一个段落）；store 里的草稿是**投影**，`sync` 来源不回写。外部插引用只走 `store.pendingReference`。
- `@` 写短标签、进上下文是**真路径**：发送前 `rewriteMentions` 还原（芯片已是真路径不改写）；歧义不猜，按「不存在 + 警告」。
- 执行模式 = 本会话生效档（覆盖层优先，其次 omp 全局）；读不到显示「读取中…」，不许兜底成某一档。
- 思考档只在缺失 / 对新模型非法时落默认档；Fast 只对支持模型显示闪电，`ultra` 不展示。
- 贴底跟随按「用户上翻」释放，不按距底距离；实时行 id = `${sid}:${msgSeq}:${contentIndex}`；`role=developer` 注入不落正文。
- `.thread-scroll` 必须保持 `overflow-y: auto`。
- 任务清单只有一个数据面（`applyPlans` / `plansBySession`）与一处展示（底部浮卡）；发送新回合时 `dismissCompletedPlans` 挡掉 `get_state` 复活回读。
- 左栏状态只有一个点、一套优先级（待处理 > 运行中 > 已完成未查看 > 空闲）；删除 / 归档 / 恢复必须在 `runSessionBatch` 同步列表缓存；冷启动补齐条件各自独立。
- 右栏工作台常驻挂载、只切显隐；文件树**只读**；脚本注入 PTY 必须走 `terminal_write_ready`（等 raw 模式），终端不随会话切换改目录或被杀。
- **Git 图谱只读**：`git_graph` / `git_commit_detail` / `git_commit_diff` 不做 checkout / reset / cherry-pick / stash / 暂存；分支筛选与文本筛选只影响查询，不改仓库状态。合并提交按第一个父提交给改动；图谱分支按完整引用寻址。
- 供应商用量：看全部供应商、与当前模型无关；读数只认 `limitReading`（percent 缺省 0 不是读数）。
- 手机远程只做白名单 RPC（无文件 / 终端 / 设置 / git）、完整 uuid、审批仅 once/deny；不许做成通用 Tauri 桥。

### 设置与集成

- omp 约束页只编辑全局三处文件；技能停用记录对账用 `PI_CONFIG_FILES` 临时 overlay，探测失败降级为 stale 为空。
- 模型角色：多套只存 localStorage，同一时间恰好一套激活；omp 是外部改动真值。
- 自定义供应商的「供应商字段」与「模型清单」两个写入面互不覆盖；空清单才打开即拉；`apiKey` 不落盘、不日志、不回传。
- 供应商登出 / 删除必须同步清理对它的模型引用：omp 侧 `modelRoles` / `retry.fallbackChains` / `cycleOrder` 走后端 `purge_provider_models`，本机侧「我的模型」与每一套角色配置由前端清理；清理失败单独提示，不回滚登出 / 删除。
- 系统授权读的是 TCC **实际生效状态**，不是系统设置开关；自动化读数用「拉起 System Events 再查」。
- git 状态统一走 `refreshWorkspaceGitState`；冲突交给系统默认程序，壳不做内置编辑器，也不 stash / force。
- 应用更新与 omp 更新两条独立链路；安装 / 更新共用后端单槽，不许并发。

## 工程约定

- **语言**：界面文案 / 注释 / 文档 / 提交信息用简体中文；标识符英文。界面文案一律走 `lib/locale.ts` 字典。
- **版本文案**：文档里不写「仓库重置 / 版本归零 / 清除历史版本」这类字样；版本历史按实际版本节记录。
- **文档更新**：架构或数据流变化 → `docs/architecture.md`；组件交互口径 → `docs/ui-contracts.md`；设置 / 供应商 / git / 更新 → `docs/integrations.md`；新增「不许」→ 本文件铁律；用户可见变更 → `CHANGELOG.md`。
- **提交信息**：`omp commit` 生成（type 英文 + summary 首词英文过去式 + 其余中文，30 字符内）。
- **输入框**：全 app 禁系统输入提示（`lib/inputAssist.ts` 全局挂 `spellcheck=false`），组件不许各自写。
- **滚动条**：全 app 不显示滚动条（`index.css` 全局规则），滚动照常。
- **弹层**：`lib/useDropdown.ts` 统一（最上层 Esc / Tab 圈定 / 焦点恢复 / 挂载层 = 最上层模态）；`EnumSelect` 面板 `width: max-content`，不许截断。
- **状态**：高频字节流 / 流式帧不进 Zustand 原始形态（rAF 合并后进）；解析放在 store 边界，值没变不写。

## 常用命令

```bash
pnpm install
pnpm tauri:dev              # 桌面壳联调
# OMP_REMOTE_AUTOSTART=1 pnpm tauri:dev   # 调试远程控制：自动起服务并打印配对 URL（仅 debug）
pnpm dev                    # 纯前端
pnpm check                  # 提交前全过：typecheck + lint + test + e2e:ipc
pnpm typecheck / lint / test / e2e:ipc
pnpm build                  # tsc + vite 构建
cargo test --manifest-path src-tauri/Cargo.toml            # Rust 单测
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored   # 慢测试（真实 omp）
pnpm tauri:build            # 本机发布构建
pnpm icon                   # 从 design-system/icon/omp-inn-icon.svg 重生成应用图标
pnpm file-icons             # 从 material-icon-theme 重新生成文件树图标子集
```

## 发版与更新

- 打 `v*` tag 推送 → `.github/workflows/release.yml` 四平台打包 + `latest.json`；仓库必须 public（updater 匿名拉取）；`fixup` job 把资产链接改写为公开直链。
- 更新说明取 `CHANGELOG.md` 版本节（`scripts/changelog-notes.mjs`），版本节缺失会挡发版——**发版前先写 CHANGELOG**。
- macOS 签名用自签证书（`scripts/make-signing-cert.sh`；TCC 授权持久化）；CI 用 secrets `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD`。
- 升版本号：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`（+ `Cargo.lock`）四处同步。
- 应用内更新链路与 omp 安装细节见 `docs/integrations.md` 的「更新链路」。

## 范围边界

- **做**：聊天唯一形态、右栏工作台（文件 / 脚本 / 多开终端）、会话读数（卡底统计条）、omp 约束编辑、手机远程控制 PWA。
- **不做**：编辑器（文件只读，打开交给系统默认程序；omp 约束页不是通用编辑器）/ 内置浏览器 / SSH / 原生移动端 App / 远程桌面 / PR 集成；分屏 / 多窗口；worktree 生命周期管理；云同步 / 定时任务；目标模式 / 计划模式（壳不提供入口、展示与启动参数；手打 `/goal`、`/plan` 仍按 omp 命令面透传）。
- 终端只作为右栏工作台页签（页签内可多开），不许长出终端形态的会话模型（π 标题 / 目录行 / 覆盖层注入 / 独立窗口 / 任意分屏）；文件树不许升级成编辑器或全屏工作区。
- 手机端只作为远程控制 PWA 存在，不是独立移动端产品形态。
