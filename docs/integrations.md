# 设置与外部集成

本文件是设置页、供应商、git、更新链路的实现方案。写入规则（CLI 优先 / 写文件例外）见 `docs/architecture.md` 的「设置写入与本地数据」。

## 设置视图

`SettingsPage` 覆盖主区（`store.settingsTabOpen` / `settingsTabActive`）：

- 打开 = 左栏「设置」/ `⌘,`；关闭 = 顶部返回 / `⌘W` / 再点一次。
- 顶部条：返回 + 当前条目名。搜索钮已于 2026-10-19 去除，搜索入口只剩 `⌘F`。
- 左导航四组十条目：通用 / 模型 / 扩展 / 数据。通用组 = 常用设置 + omp 约束 + 系统授权 + 远程控制。窄窗 44px 图标档（容器查询）。
- 内容区唯一滚动。

### 设置搜索

- 状态 = `store.settingsSearchOpen`（`⌘F`）；数据源走 `lib/settingsSearch.ts`（模块级缓存 + 懒加载，设置视图卸载即清）。
- 参数：常用设置目录 / omp 约束 / 模型目录 / 插件 / 技能 / 记忆 / 归档。
- 四档打分复用 `filterCatalog`；结果点击经 `navigateTo` 跳条目。
- 常用设置项与约束文件带 `SettingsFocusRequest{key,seq}` 定位：通用页展开分组 → 滚动到行 → 一次闪烁；约束页选中文件；seq 防重放，消费后回调清空。

### 常用设置

- 展示清单 87 项（四稿 80 → 五稿并入浏览器自动化 7 项）。
- `browser.enabled` / `cdpUrl` / `relay` / `relayUrl` / `headless` / `freezeOnTurnEnd` / `idleCloseSec` / `screenshotDir` 全在「工具」组。
- `browser.cmux` / `browser.tern` 不进：cmux / Tern 宿主专属，桌面壳里无差异。
- **让浏览器操作可见 = 关掉 `browser.headless`**：行内标注「窗口可见」；omp 会另起一个有头 Chrome for Testing 窗口。壳侧不做内置浏览器（`browser.headless` 从三稿的删除名单解禁，理由见 `lib/settingsList.ts` 头部）。

## omp 约束

`components/settings/ConstraintsPanel.tsx` + `constraints.rs`。

- 只编辑 omp 的**全局**约束与规则文件，只碰 `<agentDir>` 下三处：
  - `AGENTS.md`：native 用户级上下文文件，每次会话启动注入。
  - `RULES.md`：sticky 规则，始终 always-apply、每轮重挂。
  - `rules/*.{md,mdc}`：独立规则，文件名即规则名，`enabled: false` 停用。
- 项目级 `.omp/` 由 omp 自己发现，本页不碰。
- **数据面**：
  - `get_omp_constraints`：固定两份文件 + `rules/` 列表，一次读全。
  - `write_omp_constraint`：`expectHash` 乐观锁 → 备份到 `<appData>/omp-inn/backups/constraints/` → 原子写 → 回读。
  - `create_omp_rule` / `delete_omp_rule`：先备份再删。
  - 文件名白名单：`rules/` 下单层 `.md` / `.mdc`、不以 `.` 开头、无路径分隔符 / 控制字符 / Windows 非法字符；内容上限 2 MiB；规则 frontmatter 必须有结束行。
  - `expectHash = ""` 表示「打开时文件不存在」（外部创建了也算冲突）；`null` = 冲突对话框里的显式强制覆盖。
- **编辑面**：三种文件一律直接编辑整份 Markdown（不再有表单 / 源码两档），frontmatter 由用户自己写、文本原样保存。
  - 默认视图 = 预览（frontmatter 不进正文），点「编辑」才换成编辑框；切换文件回到预览。唯一例外是新建规则（空文件、下一步就是写内容，直接进编辑态）。
  - `lib/constraints.ts` 的解析只在读侧：列表摘要与标题行的类型标签（`kindLabel(ruleKindOf(...))`）、未识别顶层字段提示、保存前校验（大小 / NUL / YAML 可解析）。保存前本地校验，失败不发请求。
  - 草稿在模块级缓存里跨设置页签 / 设置视图保留，「重新加载」才丢弃。
- **生效**：omp 在会话启动 / `/clear` / `/new` 时重新发现规则与上下文文件；界面只说「新建的会话一定读到」，已打开会话是否热读未实测。
- 设置搜索里 `constraints` 是独立数据源（条目名 / 文件名 / 路径 / 规则描述），命中跳转用 `focusKey = kind:name`。

## 技能

停用记录对账（`components/settings/SkillsPanel.tsx` + `skills.rs`）。

- 启停写 omp 全局 `disabledExtensions` 的 `skill:<名字>`（整组覆盖、`extensions_edit` 串行）。omp 在发现阶段就按名字过滤，所以「已停用」行只能从配置读。
- **技能被手动删掉后配置里的旧记录不会自动消失**：`list_skills` 多跑一次探测——
  - 把临时 overlay（`disabledExtensions: []`）经 **`PI_CONFIG_FILES`** 环境变量挂给 `omp skill list`（overlay 优先级高于全局层与项目层，实测生效；`--config` 对子命令无效）。
  - 拿到「全部技能」的名字全集；配置里不在全集的名字即 `staleDisabled`。
  - 前端不把这些当「已停用」行展示，只在底部给一行「N 条停用记录指向已不存在的技能」+「清除记录」（逐条摘掉配置项）；设置搜索同样跳过。
- **探测失败一律降级成 stale 为空**（宁可多显示一行，不误藏真实存在的停用项）。
- 临时 overlay 用完即删；`PI_CONFIG_FILES` 原有值追加而非覆盖。

## 模型角色

`components/settings/RoleProfilesSection.tsx` + `lib/roleProfiles.ts`。

- omp 只有一张全局 `modelRoles`；多套配置是**壳侧概念**（localStorage `omp.modelRoleProfiles.v1`，与「我的模型」同档、不写 omp 配置）。
- 设置 › 模型 ›「模型角色」= 配置列表 + 编辑弹窗（`DialogShell`，不在设置页行内展开）。
  - 列表行只展示名称 + 激活态（不展示模型信息；点击名称直接打开编辑弹窗）。
  - 弹窗里配名称与角色行；新建用同一弹窗的 new 模式（名称 + 角色一起配，创建后不自动激活）。
- 激活 = 把该套整表写进 omp（后端 `apply_model_roles` 整表覆盖 + 回读，`roles_edit` 串行）；未激活配置的编辑只落 localStorage。
- 同一时间恰好一套激活：激活中的配置不能删；删除未激活配置走 `ConfirmDialog`。
- **外部改动以 omp 为真值**：每次回读 `modelRoles` 与 localStorage 的 `applied`（上次写入快照）比对，不一致 = 用户在 omp TUI / CLI 改过 → 收进当前激活配置。
- Ctrl+P 轮换序由 `sync_cycle_order` 从激活配置派生，加载后与每次激活 / 编辑激活配置后同步。
- 不许把多套配置做成第二张 omp 配置，或让未激活配置影响聊天。

## 供应商与模型

### 自定义供应商：配置与模型清单拆开

- `CustomProviderEditForm` 只配名称 / 接口地址 / 接口类型 / API Key（不内嵌模型编辑区）。
- 模型清单一律在已配置的供应商行上点「挑选模型」：
  - 自定义端点走 `CustomProviderModelsDialog`（清单为空 = 打开即拉 → 候选勾选 → 逐项调参 → 保存）。
  - 登录型仍是 omp 目录里的星标挑选（`ProviderModelsDialog`）。
- 数据层两个写入面各写各的、互不覆盖：
  - `customModels.ts` 的 `upsertProvider`：供应商级字段，不碰 `models` 节点。
  - `setProviderModels`：模型清单，逐条复用原节点保真改；空清单删掉 `models` 键。
- **打开即拉**：清单为空的供应商点「挑选模型」时自动探测一次端点——成功直接落候选视图；失败留在清单视图（错误行 + 手工添加入口，右上角按钮可重试）。
  - 三种情况不自动拉：清单非空（用户是来看 / 调现有清单的）、清单只读（形状界面表达不了）、供应商缺 `baseUrl`（拉了必然报错）。
  - loading 初值跟着判定走（不闪一帧「还没有模型」）；「请求在飞」守卫用 ref（自动拉与点击可能落在同一帧）；effect 体里不许同步写 state（`react-hooks/set-state-in-effect` 构建期报错）。
- **行尾星标 = 加入 / 移出「我的模型」**：selector = `provider/id`（与 omp 目录里的 `ModelInfo.selector` 同形）；id 为空或重复时不摆星标（selector 不唯一）。
  - 新加的行在保存后才进目录，提前收藏会先在「我的模型」标「已不可用」，保存后自动恢复。
  - 星标只写 localStorage 的 `omp.favoriteModels.v1`，不写 `models.yml`。

### 登出 / 删除供应商后的引用清理

登录型的「登出」与自定义供应商的「删除」成功后，必须同步清掉指向该供应商的模型引用——否则模型选择器、角色与失败转移里会留着已经取不到的 selector。

- omp 侧走后端 `purge_provider_models`（`providers.rs`，同一把 `roles_edit` / `retry_edit` 串行）：
  - `modelRoles`：删除 selector 属于该供应商的角色。判定只比较第一个 `/` 前的供应商段（模型 id 可再含 `/`；`anthropicx/...` 不属于 `anthropic`）。
  - `retry.fallbackChains`：键为 `provider/...`（模型 / 供应商通配）或已被删角色的整条链删除；目标里属于该供应商的 selector 删除，目标清空后整链删除。
  - `cycleOrder`：按清理后的角色表重新派生（Ctrl+P 环不能指向已删角色）。
  - 写完回读角色表 / 转移链，作为界面真值返回。
- 本机侧由 `ModelsPanel` 的清理回调处理：
  - `omp.favoriteModels.v1` 删除该供应商的收藏（`removeProviderModels`）；
  - **每一套**角色配置都删除该供应商的角色（`removeProviderFromRoleProfiles`）；激活配置与 `applied` 采用 omp 回读真值，避免下一次回读把这次清理误判成「外部改动」。
- 清理失败不回滚已完成的登出 / 删除，单独提示（`providerPurgeFailedAfterLogout` / `providerPurgeFailedAfterRemove`）。

### 端点模型探测

`provider_models.rs` 的 `fetch_provider_models`（只读、不落盘），口径对齐 DeepSeek Harness 的 `discoverModels`。

- 只认三档 wire API：`openai-completions` / `openai-responses` / `anthropic-messages`。其余不猜——猜错会把鉴权失败报成「供应商没有模型」。
- 路径：
  - OpenAI 系：`GET {接口地址去尾斜杠}/models`，按前缀拼、不自动补 `/v1`（保住 `/openai/v1` 这类部署路径）。
  - Anthropic：`GET {去掉末尾一个 /v1 的根}/v1/models?limit=1000`（只读一页，不跟 `has_more`）。
- 认证：Anthropic 用 `x-api-key` + `anthropic-version: 2023-06-01`；其余 `Bearer`；没填 key 就不带认证头。
- 解析：`data[]` 优先，其次 `models`（对象按 map，键名优先于条目 `id`）；容量字段多别名兜底（`contextWindow` / `context_length` / `max_input_tokens` / `max_model_len`、`maxOutputTokens` / `max_completion_tokens`…）；坏行跳过、缺名回退 id。
- DSH 链路里没有超时，壳侧自加 20s；响应体上限 4 MiB，**超限报错不截断**（截断的清单不可解析）。
- **apiKey 三种写法**（omp 18.11 实测，探测与 omp 同口径）：`!命令` 执行取 stdout；裸名字先当环境变量名查（命中用其值）；其余按字面量；`${VAR}` 不展开。密钥只在本进程内用，不落盘、不进日志、不回传前端。
- **omp 侧实测事实**：
  - 没有 `models` 的自定义块被 omp 接受（`omp models --json` 退出码 0、stderr 空，只是该供应商不出现在目录里）——所以「先存供应商、后挑模型」成立。
  - 模型条目只给 `id`（或 `id`+`name`）时 omp 用默认值：上下文 128000 / 最大输出 16384 / 非推理 / 纯文本。
  - `models: []` 同样合法（界面仍选删键，文件更干净）。
  - `models` 静态列表与 provider 级 `discovery` 共存时目录取并集（壳侧未用 `discovery`——勾选即启用是用户口径）。

### 供应商用量

数据面与浮层口径见 `docs/ui-contracts.md` 的「供应商用量」；设置页只负责供应商配置与探针状态。

## 系统授权（macOS TCC）

`components/settings/SystemPermissionsPanel.tsx` + `system_permissions.rs` 的 `get_system_permissions` / `open_system_permission`。

- 四项的**实际生效状态**（不是系统设置里那个开关）：
  - 完全磁盘访问 = 能否读 `~/Library/Application Support/com.apple.TCC/TCC.db`（无公开 API，兜底 `~/Library/Safari/History.db`）。
  - 辅助功能 = `AXIsProcessTrusted()`。
  - 屏幕录制 = `CGPreflightScreenCaptureAccess()`。
  - 自动化 = `AEDeterminePermissionToAutomateTarget`（目标 System Events、`askUserIfNeeded = false`，只查不弹）。
- **自动化读数的坑**：该 API 按 bundle id 寻址，要求目标进程正在运行（否则 -600 `procNotFound`）；System Events 由 launchd 按需拉起、平时不常驻——系统设置里开关全开，面板仍显示未授权。
  - -600 时后端先 `open -g -b com.apple.systemevents` 拉起它、短暂等待后重查；拉起有效就不留门槛（用户手动退出后下一轮轮询即可恢复）；只有拉起本身失败才 30s 内不再重试。
  - 启动 app 不发 Apple Event、不弹授权框；仍拿不到才按未授权显示。
- **读数与签名身份绑定**：ad-hoc 签名 / 证书轮换会让 TCC 记录与当前签名身份对不上（tccd 日志 `Failed to match existing code requirement` + 屏幕录制 `does not allow prompting`），开关看着开着、API 全是 false。用户报「computer use 没有权限」先看这一页。
- 面板挂载期间每 2 秒回读（本地查询、单飞；唯一的子进程动作是自动化那档的「拉起 System Events」）+ 窗口重新获得焦点立刻读。
- 屏幕录制未授权时恒挂「退出并重新打开本应用」提示（macOS 对新进程才生效）。
- 「去授权」由用户主动触发：完全磁盘访问先在访达中定位当前可执行文件所属的应用包，再打开系统设置，由用户点击“+”选择应用；开发模式没有应用包时只打开设置，需使用打包应用。辅助功能与屏幕录制首次调用系统请求接口，仍未授权时再次点击打开对应设置（公开接口不能区分未询问和已拒绝）。
- 自动化先只读查询 System Events 的状态：尚未询问时在后台线程调用 `AEDeterminePermissionToAutomateTarget(..., true)` 请求授权；已拒绝时打开自动化设置。首次拒绝后不自动跳设置，用户可再次点击进入。其他目标应用的自动化授权由系统分别管理。
- 打包的 `Info.plist` 提供 Apple Events 用途说明，签名包含自动化 entitlement；授权仍取决于系统确认和当前签名身份。
- 非 macOS 只显示一句「仅 macOS 可用」，不摆假读数。

## 存储维护

`components/settings/StoragePanel.tsx`；后端行为见 `docs/architecture.md` 的「设置写入与本地数据」。

- 页面只展示读数（占用）、安全清理项、深度项（默认不勾，确认框追加风险说明）与闲置会话回收入口。
- 安全项 = 未引用图片缓存 / 日志 / 粘贴临时文件 / 设置备份 / WAL；深度项 = `--archive` / `--compress`。
- 会话 jsonl 永远不由壳侧删除（界面文案也不许诺）。

## git

### 提交 / 推送

- 两轨：快速 = 一次 `omp -p` 生成信息 + `git commit/push`；完整 = `omp commit`。
- 按 cwd 建任务表（并行 + BUSY + 取消 + 超时）。
- Git 命令超时或输出管道失败时终止对应进程树并等待回收；无法确认退出时明确返回错误。
- 提交和推送任务超时时保留子进程句柄，先尝试停止进程树再回收直接子进程；进程树无法定位时提示无法确认。取消时也先尝试停止进程树。
- 单独推送仅在取消分支完成时显示已取消；清理无法确认或其他错误显示失败及原因。
- Windows 提交、推送和提交信息生成在启动时关联作业对象；超时或取消时停止并等待整个作业，即使主进程已退出也可处理后代。
- 作业退出等待只执行一次，避免底层等待被中断后把缓存的主进程退出状态误认为整个作业已退出；无法确认时明确报错。
- 取消令牌先建立通知等待再检查取消标志，避免并发取消时漏掉唤醒。
- 变更超过 2000 项时拒绝展示不完整清单，并在同步暂存前再次检查；需先用外部 Git 工具处理部分变更。
- 入口 = 卡内顶行提交键（唯一入口；V42 起右栏「变更」区块随上下文面板退场）+ 左栏任务徽章。
  - 同一浮层链路、同一状态口径：运行中转圈 / 失败红点。
- **提交键可用性 = 有没有东西可提交或推送**：判定取 `store.workspaceGitStates[cwd]`，与提交面板同源（完整 `git status --porcelain -b`，含未跟踪新文件；提交走 `add -A`）。
  - 工作区干净且 `ahead === 0` 才置灰禁用（提示「没有可提交或推送的改动」）；有改动则键尾一个 warn 圆点。
  - 快照未知（还没回来）不置灰——真裁决在后端预检。
  - 任务在跑 / 失败一律可点（要能看进度与错误）。
- **改动状态要跟得上**：会话 `running → idle` 翻转那一下（agent 刚写完文件）就重读本会话目录的快照（`scheduleWorkspaceGitRefresh`，2s 防抖 + 合并，只刷该目录；重复 idle 帧不触发），不等 30s 兜底轮询。

### 拉取远程

- 左栏项目分组头的落后徽章 = `Download` 图标 + 数字，点击即拉取。
- 后端 `git_ops::pull_workspace`：`git pull --no-rebase --ff --no-edit`——能快进就快进、分叉就合并，不 rebase、不拉起终端编辑器。无冲突则更新合并、徽章随快照归零消失。
- **有冲突不是命令失败**：后端保留合并态并返回冲突文件绝对路径（`git diff --name-only --diff-filter=U -z` 按仓库根拼绝对）。
  - 前端 `lib/pull.ts` 立刻用系统默认程序打开第一个冲突文件并弹 `PullConflictDialog`：清单里逐个打开、继续合并（`continue_merge`：仍未标记解决的冲突文件先 `git add`，再 `git commit --no-edit --no-verify`）、放弃合并（`abort_merge` = `git merge --abort`）。
- 运行态在 `store.pullStates`（running 转圈 / conflict / error 危险色 + git 原文悬停）。
  - 刷新入口 `refreshWorkspaceGitState` 顺带对账：冲突态遇到 `behind === 0`（已在别处收尾）即清。
- 壳不做内置编辑器：冲突一律交给系统默认程序，壳只负责送到编辑器与收尾。

### 分支切换

- `BranchPicker` 展开清单点分支即切：后端 `switch_branch` = `git switch <branch>`（只认分支，不会被同名路径抢语义）。
- 脏工作区交给 git 裁决（带得走就带着走，冲突整条拒绝、错误原文就地显示）；壳侧不 stash / 不 force。
- 切换成功走 `refreshWorkspaceGitState([cwd])`——它是 **git 状态的统一刷新入口**（刷新时机 = 启动 / 焦点 / 30s 轮询 / 会话一轮收敛到 idle / 提交任务结束 / 分支切换）。
  - 每次刷新自增 store 的 `gitInfoSeq`，`useGitInfo` 的所有挂载实例（输入卡卡内顶行）一起重读，ahead/behind 快照同步刷新。
- 只读查询仍是 `get_git_info`（4s 超时、降级不报错）；写命令用 30s 超时。

## 更新链路

两条独立链路：本应用（Tauri updater，`latest.json`）与 omp 运行时（`omp update`）。入口 = 左栏顶栏两枚 chip。

- **omp 缺失时**同一位置换成「安装 omp」chip（`OmpUpdateChip` 缺失分支 + `OmpInstallDialog`）：
  - 后端 `install_omp` 跑 omp 官方安装脚本（`curl -fsSL https://omp.sh/install | sh`，Windows 为 `install.ps1`）；输出流式进 `store.ompInstallRun`，可取消。
  - 安装与更新共用后端单槽（`UpdateSlot`），不会并发。
  - 装完前端重新 `getHealth` 识别：官方脚本落点 `~/.local/bin/omp` 与 `~/.bun/bin/omp` 都在 `discover_omp_path` 兜底里，chip 自动变回版本号。
  - 脚本跑完仍识别不到时就地给「重新检测 / 手动指定路径」——不把「脚本成功」说成 omp 可用。
