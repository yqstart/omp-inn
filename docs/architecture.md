# 架构与运行时

本文件是实现方案：进程模型、会话生命周期、事件流、本地数据。改这些路径前读对应小节。
不可违背的结论另见根 `AGENTS.md` 的「铁律」。

## 进程模型

- **每个会话 = 一个长驻 `omp --mode rpc-ui` 进程**（`src-tauri/src/runtime.rs`）。
  - 启动：spawn → 握手（`negotiate` / `get_state` / 子代理订阅 / ask 对话框开关）→ pump。
  - pump：stdin 写请求、stdout 读帧、`rpc_chunk` 重组、帧分类；stderr 由 `StderrBuf` 采集。
  - 结束：单会话走 `kill_runtime`；应用退出走 `kill_all`。
- **事件三通道用会话 id 命名**：`omp-event://<sid>`、`omp-status://<sid>`、`omp-state://<sid>`。sid 必须是完整 uuid（见下节）。
- **重启即换进程**：执行模式（权限档）在 idle 时改档要重启 runtime；running 时挂起到本轮结束。重启先等待旧进程和事件泵退出，再按恢复返回的真实身份继续。
- **闲置回收**：每 60s 一轮，`ACT_IDLE` 且已落盘、闲置 ≥30 分钟才 kill；重新打开 / 发消息自动 resume。
  - `agent_end{isTerminal:false, awaitingAsyncWork:true}` 折算 `idle-awaiting`，回收跳过。
  - 发送登记与回收判定使用同一进程表锁；未确认的请求和后台任务保护回收，静止回读确认后才解除。旧版缺少确认字段时保守跳过回收。
- 会话进程异常退出时按进程实例清理失效表项；打开、发送和改名共用会话级单飞恢复。发送仅在通道拒绝投递时重试，已入队消息不自动重发。

## 会话身份

- **身份 = jsonl 文件名里的完整 uuid**。`session_file_for` 只认完整 id。
- **任何定位 / `--resume` 都不许退回 8 字符前缀**：uuid v7 前 8 位同分钟内必然相同，会读错历史、删错文件、resume 到别的会话并顶掉它正在跑的进程。
- **open-elsewhere = omp 的保护性 fork**：打开一个已被其他进程持有的会话时，omp 会分到新身份（新 jsonl、`parentSession` 指向原会话、标题继承；日志 `Session moved to a new file / reason: open-elsewhere`）。列表因此出现两个同名会话，常见触发是两个壳实例（安装版 + dev）同时打开同一会话。
- **壳侧以 spawn 返回的真实 sid 为准**：
  - 后端 `spawn_session_runtime` 身份漂移分支：`sid != 请求 id` 时按新身份的文件读头返回；`send_prompt` 自动恢复同口径。
  - 前端打开及发送前恢复均使用 `opened.id`（激活 / 历史 / 导航栈 / 发消息），漂移时补一条说明分隔行、迁移草稿与附件，并等事件监听就绪；手机同步路由。
  - 发送与预检之间若再次发生分叉，后端拒绝投递并返回新身份，前端保留草稿供重试，不把消息发到未订阅的会话。
  - 不许用请求 id 继续——会错位到原会话并反复拉起新进程。

## 项目路径与外部改名

项目的显示名没有独立字段，**真相 = 覆盖层 `projects[].path` 的末段目录名**。用户在 Finder / 终端 / 其他应用里重命名项目目录（或它的任一上级目录）后，旧路径失效；壳侧按目录身份链把项目找回来（`src-tauri/src/project_paths.rs`）。

- **身份链**：新增项目 / 每次读到存在的路径时，从挂载根到项目目录逐级记录 `Project.path_ids`（Unix `dev:ino`，Windows 卷序列号 + 文件索引）。只存本地覆盖层，不参与展示。
- **找回**：某项目路径失联时，从根目录开始逐级扫描当前目录的直接子项，按身份匹配下一级——名字改了也能跟着走；不按名字猜（同名新目录不会误认领），目标路径已被其他项目占用时不动。
- **触发点**：`list_projects` / `list_checkouts` / `list_sessions` 读取前都会先对账（保证名字、worktree、会话归属都用新路径）；前端在窗口重新获得焦点 / 转回可见时重拉侧栏，可见时每 10s 调一次轻量 `reconcile_projects`（只 stat 路径，失联才扫描身份链）。
- **边界**：只跟随改名（项目目录本身或上级目录改名）。把项目移出原父目录、跨卷改名、或老覆盖层没有身份链时都保持「目录缺失」，继续手动重定位；不许按名字猜。**壳侧绝不改写会话 jsonl 的 `cwd`**：旧会话仍指向旧目录，归属与 `--resume` 由 omp 决定，壳不代偿。
- 写盘：对账只在身份链 / 路径真正变化时原子写覆盖层；写失败回滚内存快照，避免「界面已换新路径、重启又变回去」。

## 新建会话

`create_session` 的启动参数与失败降级。

- `last_model` / `last_thinking` 只是**偏好**，不许堵死新建流程：omp 对不存在的 `--model` / 非法 `--thinking` 直接退出（`Error: Model "…" not found`，stdout 一帧都没有）。
- 三层口径：
  1. spawn 失败必须带原因：`StderrBuf` + `with_stderr_reason`，`stderr_first_line` 只脱壳加的一层括号。
  2. 首发被拒 → **去掉这两个参数降级重试一次**（omp 用默认档）。成功即按 `Plan::Degraded` 清掉项目里那对失效偏好（否则每次新建都白失败一次），`FallbackNotice` 随回包返回；前端在会话流尾落一条本地说明行（`appendLocalNote`），不许静默换模型。
  3. 降级后仍没拿到模型 → 如实说明，**不动用户的项目偏好**。
- resume 路径不带这两个参数。

## 发送与队列

- idle：Enter 发送；`/` 开头走 omp 的 `run_slash`（壳本地命令组已于 2026-10-20 移除）。
- running：**Enter 插话（steer）/ Tab 排队（follow_up）/ Esc 中断并交还队列**（`abort_and_restore_queue`）。
- **队列 = omp 真值**：`queue_update` 帧落 `store.queuedBySession`；`applyQueue` 是唯一写入面；行可撤回 / 编辑 / 提升。
- **`/` 开头不被 running 改道**：omp 只在 `prompt` 入口过命令门，`steer` / `follow_up` 里的 `/skill:<名>` 不会注入技能（不产生 `skill-prompt` 帧）。所以 Enter / Tab / ⌘Ctrl+Enter 遇到 `/` 开头（无附件）一律走 `run_slash`，运行中由 omp 排到下一个边界。
- 空态（无活动会话）输入第一条消息 = 先按目录新建（`createChatIn`，目录取 `resolveNewChatCheckout`、退回第一个项目）再发送；空态草稿在 `drafts["__new__"]`（`NEW_DRAFT`），成功后清空。

## 状态收敛

- 终态 `agent_end` → idle；`agent_end{isTerminal:false, awaitingAsyncWork:true}` 也折算 idle（`idle-awaiting`）。
- `session_settled` 同样收敛。
- `get_state` 真值回读挂在「终态 `agent_end` ∪ `session_settled`」上：运行中注入的补标题 `/rename` 会把本轮 `agent_end` 变非终态，只认终态会漏掉首轮回读。
- 运行中另有一路：每个 assistant 步收尾（`message_end`）按 ≥2s 节流补一发 `get_state`（`runtime.rs` 的 `midrun_sync_due`），`contextUsage` 随长任务推进增长。
- 前端不许在 `open_session` 回包时把状态压成 idle（会打断进行中的轮次）。
- **`SessionView.running` 由进程表活动态派生**（`running_snapshot` → `activity_is_busy`：只有 running / awaiting-approval 才算），不存「进程在任」快照。
  - 打开过的空闲会话不应转圈；「跑完未读」的完成点就是 running→非 running 的翻转。

## 标题

omp 对 `--mode rpc-ui` 强制关闭自动标题，壳侧补两层。

- **生成**：pump 在首条用户消息帧（`message_start` role=user）一到就注入一次 `/rename`。`/` 开头在 omp 侧先过命令门、早于 streaming 判定，`/rename` 无参数走后台执行：运行中注入不插话、不排队、不阻塞。
- spawn 时（resume 旧会话）与每次终态 `agent_end`（失败兜底重试）各再看一眼；每进程至多成功一次；`session_info_update` 帧回灌。
- 后端扫描 `first_user_text` 派生显示标题兜底；标题语言随壳界面语言（`TITLE_SYSTEM.md`，用户自写文件不覆盖）。
- **显示去前缀**：omp 18.8.7+ 的标题卡（上游 `utils/title-card.ts`，`title.icons` 默认 `nf+emoji`）会写成 `${icon} ${code}: ${title}`。图标是私有区码位，壳里没有覆盖字体，WebKit 会回退成杂物字形。
  - `lib/sessionTitle.ts` 的 `sessionTitleForDisplay` 在显示层去掉「图标 + 大写短码」整段；侧栏行 / 删除确认 / 顶栏 / 归档页 / 设置搜索 / 改名输入框回显同一口径。
  - 裸 `HGT: `（无图标）不是标题卡，不剥；数据保持原样（jsonl、导出仍带前缀）。
- **改名交互**：顶栏点标题就地改名。Enter 或点输入框外提交，Esc 取消；改过才写 omp 真名。
  - 「点输入框外」走 document `pointerdown`，不用 blur（WKWebView 点非聚焦元素不搬焦点）；同一次点击的 pointerdown 提交后 blur 补发由一次性结算挡住。
- **标题变更不落正文**：jsonl 的 `title_change`（自动补标题与顶部改名都会落一行，带 `source: "user"`）在历史回放里只更新标题、不产出消息行（`lib/viewmsg.ts` 批量与单行两条归一口径都返回空）。

## 会话图片

- 实时帧（`message_start` / `message_end`）里的图片是 **base64**；omp 写 jsonl 时外置成 `blob:sha256:<hash>`（实体在 `~/.omp/agent/blobs/<sha256>`，另有同 inode 的 `<hash>.<ext>` 副本）。
- `lib/attachments.ts` 的 `blobRefOf` 只认 64 位小写 hex；`imagesFromContent` 命中即产出 `{mimeType, blob}`（不参与 base64 长度上限）。
- **绝不许**把 blob 引用当 base64 拼 `data:` URL——旧版历史图片坏图的根因。
- `thread/MessageImage.tsx` 统一两种来源：base64 直显；blob 经 `api.readBlobImage` 按需读（`lib/blobImages.ts` 40 张 / 48M 字符 LRU + 单飞；远程白名单含 `read_blob_image`）。
- 预览 `thread/ImageLightbox.tsx`：复制走后端 `copy_image`（`images.rs`：解码 → RGBA → `arboard` 主线程写系统剪贴板）；另存为走系统保存对话框 + `save_image_file`（只接受 PNG / JPEG / WebP / GIF）。手机端只保留预览。

## 使用统计

`usage.rs` = omp 会话记录 ∪ 壳侧账本。

- **为什么要账本**：只扫 jsonl 的话，删掉会话那部分用量就从统计里消失。
- 每条 assistant `message_end`（`runtime.rs`，`totalTokens > 0` 才记）把该轮 usage 追加进 `app_data_dir/omp-inn/usage-ledger.jsonl`。
  - **只追加、不改写**；键已记过即跳过。`UsageLedger` 懒加载，首次记账才建目录 / 开文件 / 重建去重集合。
- **去重键唯一口径 = `usage.rs` 的 `usage_key`**：`sid|responseId` 优先；`responseId` 缺失（失败 / 重试调用）退回 `sid|时间戳|四段用量`。
  - jsonl 解析与账本记录共用这一处；口径不一致就会重复计数。
  - 同一轮在实时帧与 jsonl 里的 `responseId` / `message.timestamp` / `usage` 实测完全一致。
  - 两路都有时**以 jsonl 为准**（jsonl 先扫、先占键）；**不许**再加时间窗口 / 「会话文件在不在」这类判据（按 mtime 判会误杀后来追加过消息的老会话；按数据时间窗判会重复或漏）。
- 派生指标（命中率 / 活跃天数 / 连续天数 / 热力图）与 jsonl 同口径；账本事件同样进活跃日与热力图。
- `extras` = 只由账本补上、jsonl 里已经没有的条数；**仅数据面**（界面只留读数）。
- 账本读不完与 jsonl 一样置 `truncated`；记账失败只影响已删会话的补记，不许拖累会话线程。

## 内存与流控

- `eventsBySession` 只留最近 3 个会话（切会话时触发 LRU 裁剪；running 豁免）。
- 工具全量输出封顶 100K 字符。
- 高频字节流（终端）/ 流式帧不进 Zustand 原始形态；解析放 store 边界，值没变不写。

## 模型目录

- `omp models --json`（2–10s）：单飞 + 5 分钟缓存 + 过期后台刷新（`omp-models://catalog` 广播）。
- `omp config list --json` 一次读全部配置键。

## 远程控制（手机 PWA）

- 桌面 Tauri 进程内嵌 axum HTTP/WS（`src-tauri/src/remote/`）；手机浏览器 PWA（`mobile.html` + `src/mobile/`）扫码配对后继续会话。
- **复用**：现有 `commands` 函数、`stores/app`、`useSessionEvents`、`openSessionWithHistory`、`Thread`、审批 / 任务卡；传输在 `src/shared/remote.ts` 切换（`window.__OMP_REMOTE__`），桌面仍走 Tauri。
- **安全口径**：默认关闭；仅白名单 RPC（无文件 / 终端 / 设置 / git）；会话 id 必须完整 uuid；审批仅 once / deny；`create_session` cwd 限已登记项目；设备 token 只存哈希且可撤销；局域网 HTTP 明文有 UI 警告，外网用 Tailscale Serve HTTPS。
- 设备撤销先在内存生效并断开连接；持久化失败时设置页持续提示重启后可能恢复，支持重试保存。配对记录保存失败时回退内存状态并拒绝交出新令牌。
- 远程事件连接在订阅撤销通知后复核令牌，转发事件前再次核验；撤销通知漏收或通道关闭时断开连接。
- 事件由 `remote::emit_event` 镜像；审批帧离线缓存 30 分钟，重连补拉。
- 手机事件连接以服务端完成订阅后的 `remote://hello` 为就绪信号，重连后补拉状态和待审批。
- **不许**把远程做成通用 Tauri 桥或第二套聊天语义。

### 历史回放

- `get_history` 从 jsonl 尾部按字节游标向前分页；普通页按 1 MiB 读取，单条记录最多扩展到 128 MiB，超限时跳过并提示。桌面和手机使用同一分页接口。
- 回退行身份使用文件偏移；历史与实时行按类别、文本和出现顺序配对。上游没有持久关联身份，相同文本的不同消息仍可能存在配对歧义。
- 发送时记录已加载历史的向前分页边界，向前翻页不会把边界之前的旧记录配给该次发送。

## 设置写入与本地数据

- omp 侧只经 `omp` CLI（`config set/reset`、`auth-broker`…）。
- **直接写文件的唯一例外**：`models.yml` 与「omp 约束」的 `AGENTS.md` / `RULES.md` / `rules/*.md`（上游没有对应 CLI）。
  - 两者都是 hash 乐观锁 + 预校验 + 备份 + 原子写。
- 本应用偏好不写 omp 配置（localStorage：`omp.modelRoleProfiles.v1` / `omp.favoriteModels.v1` / `omp.scripts.v1` / `omp.lastSession.v1`）。
- 存储维护（`storage.rs`）：
  - 读数 `get_storage_stats` 只扫目录（快）；blobs 只数无扩展名主文件（硬链接副本不重复计）；日志目录是 `~/.omp/logs`（与 agent 同级，不是 `agent/logs`）。
  - 清理前 `preview_storage_cleanup` 跑 `omp gc --json`（dry-run）；执行 `clean_storage` 才加 `--apply`。
  - 安全项 = 未引用图片缓存（`--blobs`，引用口径由 omp 扫全部 jsonl，壳侧不猜）/ 日志（跳过最近 1 小时）/ 粘贴临时文件 / 设置备份 / WAL；深度项 = `--archive` / `--compress`（默认不勾，确认框追加风险说明）。
  - **会话 jsonl 永远不由壳侧删除**。
  - `reclaim_idle_sessions` 复用 `runtime::reclaim_idle_now`（只收 `ACT_IDLE` 且已落盘、闲置 ≥30 分钟）。

## Git 图谱（只读）

右栏「Git 图谱」页签的数据面（实现口径见 `docs/ui-contracts.md` 的同名小节）：

- `git_graph(cwd, rev, limit, skip)`：`git log --topo-order --decorate=full`，默认从 `--branches --tags --remotes HEAD` 取（不含 stash / notes），返回提交（hash / 父提交 / 作者 / 时间 / 标题 / `%D` 引用）与分支清单；`rev` 必须是分支清单里的完整引用；非仓库返回 `isRepo:false`，空仓库返回空历史。
- `git_commit_detail(cwd, hash)`：`git show -s` + `--name-status -z` + `--numstat -z`；合并提交按 `--first-parent` 给文件清单。
- `git_commit_diff(cwd, hash, path)`：`git show --literal-pathspecs --no-ext-diff`，合并提交同样 `--first-parent`；diff 上限 40 万字符。
- 三条命令都在仓库根跑（会话目录可能是子目录），**全部只读**：不 checkout / reset / cherry-pick / stash。
- 前端 lane 布局在 `lib/gitGraph.ts`（纯函数 + 单测）：每个提交唯一 lane，父提交继承 / 新开 / 并入已有 lane；只连可见集合里的父提交。

## 源码地图

```
src/
  app/App.tsx                # 顶层装配（左栏 + 中列 + 右栏工作台 + 设置视图 + 全局浮层与快捷键）
  mobile/                    # 手机 PWA（独立入口 mobile.html）：配对页 / 会话列表 / MobileComposer；复用 Thread 与 useSessionEvents
  components/sidebar/        # ChatSidebar（命令入口 + 会话树 + 项目拖拽排序）/ SidebarTop / SidebarBottom / WorkspaceGroupDialog / RowAction / DropLine / OmpUpdateChip / AppUpdateChip
  components/workbench/      # WorkbenchPanel（停靠 + 四页签 + 宽度拖拽 + 终端标签行）/ FileTree / FileIcon / GitGraphPanel / GitGraphDiffDialog / ScriptsPanel / TerminalPane
  components/thread/         # ChatView / TopBar / Thread / AssistantText / ToolRow / ToolRunRow / TurnRow / ApprovalCard / UiRequestCard / ChatEmptyState / PlanCard / TurnRail / FindBar / BtwPanel / SessionStatsBar / ContextMeter / SessionStatsDialog / DiffDialog / MessageImage / ImageLightbox
  components/composer/       # Composer / CommitButton / ApprovalModeMenu / FastMenu / ModelMenu / ThinkingMenu / MentionList / SlashMenu / UsageLimits / draft/*
  components/pickers/        # ProjectPicker / BranchPicker
  components/settings/       # GeneralSettingsPanel / ConstraintsPanel / SystemPermissionsPanel / StoragePanel / ModelsPanel / RoleProfilesSection / PluginsPanel / SkillsPanel / ProvidersSection / CustomProviderEditForm / CustomProviderModelsDialog / ProviderModelsDialog / MemoryPanel / UsagePanel / SettingsSearch / Highlight
  components/usage/ update/ git/   # 供应商用量 / 更新弹窗 / 提交面板与 diff 行渲染
  components/SettingsPage.tsx / ReferencePicker.tsx / HealthBanner.tsx
  lib/                       # viewmsg / mergeEvents / threadLayout / threadScroll / termTheme / useSessionEvents / sessionOpen / streamReveal / mdBlocks / streamCaret / usePopoverAnchor / useDropdown / useGitInfo / localNote / promptHistory / useVisibleRefresh / btw / checkouts / workspaceGroups / projectDrag / locale / theme / platform / settingsTabs / settingsSearch / roleProfiles / sessionApproval / thinking / thinkingDefault / sessionTitle / attachments / blobImages / imageRefs / mentions / workspaceFiles / fileIcons / toolLine / turnRail / todoDisplay / sessionLiveStats / usageLimits / providerUsage / sessionRowStatus / lastSession / pull / gitGraph
  shared/                    # api（invoke 唯一入口，远程模式走 HTTP/WS）/ ipc / types / remote（transport + 401 处理）
  stores/app.ts              # Zustand 全局状态（会话 / 消息流 / 队列 / 未读标 / 右栏 / 引用浮层 / 设置视图 / 更新 / 提交任务 / 工作区 / 终端）
src-tauri/src/
  remote/                    # 手机远程控制：内嵌 axum HTTP/WS、扫码配对 / 设备、RPC 白名单、事件镜像与待审批、Tailscale
  runtime.rs                 # 会话 RPC 运行时（spawn 握手 → pump → kill_all；事件面泛型）
  images.rs                  # 会话图片：omp blob 读取 + 系统剪贴板复制 + 另存为
  storage.rs                 # 存储维护：目录读数 / omp gc 清理 / 闲置会话回收
  pty.rs                     # 右栏终端：PTY 登录 shell（spawn / write / resize / kill / kill_all）
  proc.rs                    # 进程与环境工具（登录 shell PATH 探测 / 进程组强杀）
  wsl.rs                     # WSL UNC 识别 + wsl.exe 终端启动（不跨发行版驱动 omp）
  commands/mod.rs            # RPC 命令面 + 项目 / 工作区 / 会话 / git 命令
  context.rs session_scan.rs overlay.rs project_paths.rs git_info.rs git_commit.rs git_ops.rs git_graph.rs project_files.rs workspace_fs.rs project_scripts.rs
  plugins.rs skills.rs settings.rs system_permissions.rs models_config.rs constraints.rs title_prompt.rs omp_update.rs commit_msg.rs
  providers.rs memories.rs usage.rs provider_usage.rs extra_usage.rs provider_models.rs live_stats.rs
scripts/                     # e2e-ipc-selfcheck / generate-icons / generate-material-icons / changelog-notes / fixup-latest-json / make-signing-cert / tauri-build
```

