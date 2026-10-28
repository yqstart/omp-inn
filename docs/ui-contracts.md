# 界面与交互口径

本文件是前端形态与交互的实现方案：布局、输入卡、消息列、左栏、右栏工作台。
改对应组件前读对应小节；不可违背的结论见根 `AGENTS.md` 的「铁律」。

## 三栏布局

- 左栏 `SidebarShell` + `ChatSidebar` / 中列 `ChatView` / 右栏 `WorkbenchPanel`（装配在 `App` 主区内、`ChatView` 之侧）。
- **右栏开关** = `store.workbenchOpen`（⌘⇧G）：每次启动都收起，不恢复上次展开态（开合只在本次运行内有效）。打开即停靠为第三栏（布局变三栏，会话列让位、不遮盖）。
- **右栏宽度可拖**：`store.workbenchWidth` 260–640、默认 320、持久化；手柄在左缘，另受「给中列留 420px」的窗口约束，窗口变窄自动收回超限值。
- **右栏四个页签**：`store.workbenchTab`（文件 / Git 图谱 / 脚本 / 终端，持久化）。面板**常驻挂载、只切显隐**：收起 / 切页签 / 切设置视图都不卸载（终端进程与 xterm 回看缓冲、文件树展开位置、图谱筛选与选中详情都不丢）。页签区在窄栏（260px）横向滚动，关闭键固定在外侧。

## 输入卡

`components/composer/`。结构：

- **卡内顶行**：项目 / 分支 + 提交键。
- 输入区（Lexical 草稿编辑器）。
- **卡底工具行**：`+` / 执行模式 / Fast / 模型 / 思考档 / 发送。
- **卡下统计条**（卡外，与卡片同宽）：`thread/SessionStatsBar` = 会话统计 / Token 用量 / 上下文占用 / 供应商用量。
- `@` / `/` 补全浮层也在卡外、卡片上方。

### Lexical 草稿编辑器

`components/composer/draft/` 三个文件：

- `DraftEditor.tsx`：Lexical plain-text；读写句柄；capture 阶段把键盘 / 粘贴转给 Composer；`DraftTextSource` 来源标记。
- `ReferenceChipNode.ts`：`DecoratorNode`，携带 `{path,label,isDir}`；`getTextContent()` = `@真路径`（目录补尾斜杠）；`isKeyboardSelectable() = false`。
- `ReferenceChip.tsx`：图标 + 短标签的视觉本体。

**草稿恒定一个段落**，换行是 LineBreakNode——Lexical 不把段落分隔写进 `getTextContent()`，而「按段落自己拼换行」会撞上规范化中间态（实测段落数指数增长直到 OOM）。

Store 里的草稿是**编辑器的投影**：

- `sync`（store → 编辑器）**不回写**（迟到的投影通知会覆盖更新的草稿，例如发送失败的回滚）。
- `insert`（壳插引用 / `#N` 占位 / 粘贴转文件）回写，但不打断历史浏览。
- `user` 回写并退出历史浏览。
- 外部往草稿插引用走 `store.pendingReference`（编辑器非受控，改草稿文本插不出芯片）。
- 文件和消息引用经同一通道按会话保序消费；发送前同步取走本次草稿与附件，同会话发送串行，失败时合并新输入并处理附件编号冲突。

### `+` / `/` 共用面板

`composer/SlashMenu.tsx`。`+` 按钮与 `/` 打开**同一个**浮层：

- 顶部「操作」组：文件 / 工作区文件 / 压缩。
- 「技能」组：当前会话命令面里的 `skill:<名>`。
- **omp 命令不再列出**（手打其它 `/xxx` 仍走 `run_slash`，由 omp 裁决）。
- `+` 打开时列全部技能；`/` 打开时按输入过滤。
- 行是单行：图标 + 标题 + 命令名 / 描述，三者垂直居中，行高 28px 档。
- **Esc / 点面板外关闭**（`lib/useDropdown.ts` 的 `useOutsideDismiss`：document `pointerdown` capture，不抢编辑器焦点；`+` 触发按钮算「里面」，否则 pointerdown 先关、click 又开）。`@` 补全同口径，但点编辑器里不算外部——那是接着改这枚 `@`。

各项行为：

- **文件** = 系统文件选择器，按类型分流：
  - 图片（png / jpg / jpeg / webp / gif）走附件：`api.readImageFile` → `commitImages`，`#N` 占位与粘贴 / 拖拽同一收尾。
  - 其他文件在光标处插引用芯片：`insertReference`，路径 = `lib/workspaceFiles.ts` 的 `referenceTarget(cwd, abs)`——会话目录内相对、目录外绝对，与右栏文件树 / ⌘⇧P 同一条投递口径。**不许**给 omp 塞它不支持的通用文件附件。
- **图片 `#N` 映射**：`#N` 只是壳写进正文的普通文本，omp 不解析。发送时若正文引用了**已附带附件**的 `#N`，壳侧在 wire text 末尾补一行 `[omp image order: #1=image 1, #3=image 2]`（`lib/imageRefs.ts`，按图片数组顺序，不是正文出现顺序；没有引用就不补）。
- 排队消息编辑或中断退回草稿时，按顺序注记将正文引用改成新分配的附件编号；多条消息分别处理，保留已有草稿附件的编号。
  - 这行只给模型看：乐观回显 / 历史回放 / 队列行 / 队列编辑与中断还原 / 派生标题都按同格式剥掉（`stripImageOrderNote` + 后端 `user_message_text`）。omp 会原样落进 jsonl，所以导出文件里仍能看到。
  - 删图后的编号空洞、悬空 `#N` 如实按剩余图片位置映射。
- **工作区文件** = ⌘⇧P 的跨项目引用浮层（投 `refPickerTarget`），不是第二个文件选择器。**入口只在当前项目处于多成员工作区时出现**（`lib/workspaceFiles.ts` 的 `hasWorkspaceRefs` = `referenceScope().others.length > 0`）：未分组 / 单成员工作区 / 目录不属于任何项目时整行不渲染（不是禁用——没有可引用的范围）。
- **压缩** = `api.compactSession`（与工具行 ≥80% 才露面的 `CompactButton` 同一条后端通路）。`running` 时这一行禁用（omp 在任务跑着时不处理 compact 请求，实测不回包），不锁整张菜单。
- **技能** = 当前会话命令面里的 `skill:<名>`（omp `skills.enableSkillCommands` 开启时随 `available_commands_update` 推来）。单行「Sparkles + 技能名 + 描述（截断）」，点击把 `/skill:<名> ` 插到输入框光标处；面板限高滚动。数据源是 `currentRuntime.commands`，不另扫技能目录。

### `@` 提及

输入框里写的是**短标签**，进上下文的是**真路径**。

- **写入短标签**（`@components/`、`@FileTree.tsx`）——最短唯一后缀：`workspace_fs.rs` 的 `unique_labels(all, targets)` 段数从 1 增长，取第一个全库唯一的后缀；都不唯一就退完整相对路径。条目表 `entries_for(root)` 全量遍历一次（跳依赖目录、带预算、30s 缓存）。
  - 来源：右栏文件树 / 快速过滤的「引用到输入框」走 `mention_label(base, path)`（前端串行队列，连点不乱序）；`@` 补全候选自带 `label`（`PathCandidate.label`）。
  - 会话目录之外（⌘⇧P 跨项目引用）写绝对路径：该浮层文件与文件夹都能引用（目录行尾 hover 的链接键，或 ↑↓ 停在目录行后 Enter；`flattenRefTree` 行序号含目录行；浏览态打开不预选任何行、↑↓ 才落位；搜索态默认停在第一条文件行，打字后 Enter 仍是引用文件）。投 `isDir: true` 后芯片序列化补尾斜杠（`@/abs/dir/`）。
  - 目录开合：浏览态默认折叠（用户点过的记成「与默认相反的例外」，见 `dirCollapsed`）；搜索态默认展开；查询一变例外即作废。
- **取词**在后端 `complete_path`（纯逻辑 `complete_candidates`）：
  - 空 token / 带目录（`@`、`@components/`）列那一层；目录名是短标签时先按后缀反解出真目录再列，候选按用户写的前缀展示。
  - 有名字、没写目录（`@baselin`）递归搜名字（`search_entries`：忽略大小写、名字包含、浅层与前缀命中优先）。
  - 浮层三态必须可见（`MentionList.status`）：搜索中 / 没有匹配 / 候选——不许无声消失。Esc 关掉后继续打字重新打开（`mentionDismissed`，与 `/` 命令面同口径）。
- **`@` 浮层的「工作区文件」入口**：刚打出 `@`（token 为空）时 `MentionList` 最上面插一行入口（`MentionRow` 的 `workspace` 档），与路径候选之间一条细线；默认高亮仍落第一条路径，↑ 一下才到入口。
  - 选中 = 收掉这枚 `@`（`replaceMentionWithText("", "")`）→ 打开 `refPickerTarget` 浮层；**不记 `mentionDismissed`**（否则下一次 `@` 打不开浮层）。
  - 非空 token 不显示入口；入口只对工作区成员出现（同一个 `hasWorkspaceRefs`）。
  - 键盘导航（↑↓ / Tab / Enter）与默认落点按 `mentionRows` 走，不按 `mentionCands`。
- **选中候选两种动作**：
  - 目录 = 下钻：把光标前的 `@token` 换成路径文本 `@<短标签>/`（`replaceMentionWithText`，光标停在其后），浮层接着列这一层。目录不能插成芯片——原子节点挡住后续输入。
  - 文件 = 引用芯片（`replaceMention`，显示短标签、序列化真路径、尾随空格收口）。
- **取词会接上紧邻的芯片**：`$textBeforeCaret` 从光标往前凑、`$mentionRange` 按字符数找回 `@`；右栏注入的 `@dist/` 后面打 `app`，token 是 `@dist/app`。
  - `$mentionRange` 构造跨节点选区：起点落在芯片上时用「父元素 + 子索引」的 element point（decorator 不能做 text point），整段一次删掉再插入。
- **解析**（`check_paths` → `PathCheck.resolved`）：直接解析（相对 / 绝对）→ 短标签后缀唯一反解（真路径回填 `resolved`）→ 都不行记不存在。
  - **歧义一律不猜**：两个 `index.ts` → `@index.ts` 就是「不存在 + 警告」。
  - 展示只保留正文一种（不排芯片行）；完整路径在输入框悬停提示（`title` 逐行 `@标签 → 真路径`）与补全候选里；只有 `exists === false` 的引用才在输入框上方给一行警告（`mentionsMissingHint` + 原文）。
- **发送前还原**（`Composer.expandMentions` → `lib/mentions.ts` 的 `rewriteMentions`）：只对手打的纯文本短标签（芯片序列化出来已是真路径，`check_paths` 直接解析命中、不改写）。
  - `send` / `sendQueued`（steer / followUp）三条路都过一遍（目录写法保留尾斜杠；解不出来就按原文发）。
  - 回显 / prompt 历史 / 发送失败回滚都用原文；队列消息「编辑」退回草稿时反向缩短（`shortenMentions` → `mention_label`）。

### 执行模式（权限档）

- 输入卡上的档位 = **本会话生效档**：覆盖层 `sessionApproval` 优先，否则 omp `tools.approvalMode`。
- 两个来源都不许兜底成某一档——没读到就显示「读取中…」。
- 写入只走 `lib/sessionApproval.ts`：
  - 菜单选择 = 写 omp 全局默认（新会话档位）+ 本会话覆盖（idle 重启 runtime 立即生效 / running 挂起到本轮结束）。
  - Shift+Tab 循环只动本会话覆盖。
- 启动时 `loadApprovalState()` 水合覆盖层 + 全局档（`get_overlay` 的 wire 是覆盖层文件格式 snake_case，别按 camelCase 猜）。

### 思考档

- 默认档 = omp 配置的 `defaultThinkingLevel`（`get_default_thinking_level` → `omp config get`；前端单飞读在 `lib/thinkingDefault.ts`，后端在 `settings::read_default_thinking_level`）。
- 实测（18.10.3 rpc-ui）：切模型时 omp 保留仍然合法的档位、切到无思考模型直接丢档且切回不恢复。
  - 所以壳侧只在「档位缺失 / 对新模型非法」时落默认档（`runtime.rs` 的 `auto_think_level` 夹到该模型支持集），不覆盖用户已选的有效档。
  - 前端显示与乐观更新镜像同一口径（`lib/thinking.ts` 的 `clampThinking` / `resolveThinking`），真值经 `omp-state://` 回读收敛。
- 模型目录行必须带供应商（同名模型来自 ark.cn / ccproxy / commandcode 多家）。

### Fast（服务档位）

- **Fast = 当前模型的服务档位，不是快速模型**。工具行只有一个闪电图标（无文案 / 无菜单）：点击开 / 关 omp `set_fast_mode` 的 priority 档位，开启时 `text-warn` 黄色。
- **只有支持 Fast 的模型才显示闪电**：壳侧按 omp `service-tier.ts` 的 `ty` + `Cve`/`Cu` 规则，从 `get_state.model` / `set_model` 的 `provider` / `api` / `identity.class` 元数据算 `fastModeSupported`（`runtime.rs`），选择模型时即时更新；不支持直接隐藏。
- `ultra`（`/fast ultra`）只有终端 / TUI 有，rpc-ui 没有通道，界面完全不展示。
- **tok/s 不保证变快**：Fast 是供应商服务档位（OpenAI `service_tier=priority` / Anthropic `speed=fast` / Google priority），实际速度由供应商决定。
- `fastModeEnabled/Active` 来自 `get_state`；回包先乐观回填，再经 `omp-state://` 收敛。
  - 支持判定为真但运行时仍被拒 → 错误原文在图标上方就地显示；下一次点击清掉并允许重试。
  - `enabled` 但 `active=false` 时图标仍黄，提示说明未实际启用。
- 不要把闪电做成「选中模型即开 Fast」的复合动作。`omp models --json` 不暴露 Fast 能力，列表批量打标没有可靠数据源。

### 卡底统计条

`thread/SessionStatsBar`，2026-10-20 移到输入卡外部：

- 卡片下方一行四项，与卡片同宽（`mt-1.5`），整条靠右（`justify-end`）。
- **会话统计**：`N 轮 M 步 · X tok/s`；点开：模型用时 / 工具调用用时 / 首发平均 TTFT / 输出速度 TPS。
- **Token 用量**：`X tok · 缓存命中 P%`；点开：缓存命中 / 未缓存输入 / 缓存读取 / 输出 的分项与千分位总计。
- **上下文占用**：容量环，点开分项。
- **供应商用量**：只有图标 + 档位配色，点开全部窗口。
- 形态参照 DeepSeek Harness 的 composer dock，派生口径：
  - 轮 = 有过步的轮；步 = 每次模型调用；模型用时 = Σ`duration`；工具用时 = 按调用逐个配对求和；TTFT = 按步算术平均。
  - **TPS = 输出 token ÷ 解码墙钟（`duration` − `ttft`，不含首 token 等待）**。
  - 缓存命中 = `cacheRead ÷（未缓存输入 + 缓存读 + 缓存写）`；总计 = 三桶输入 + 输出。
- **数据只由后端 `live_stats.rs` 扫该会话 jsonl 聚合**（派生指标后端算好、按 mtime+size 缓存）；前端 `lib/sessionLiveStats.ts` 只做按会话快照 + 格式化（`fmtSpan` / `fmtTps` / `fmtHitRate`）。
- **收敛**：omp 不推这类投影——打开拉一次、运行中每 3s 回读、终态翻转再拉一次；2 秒节流 + 单飞 + 失败保留旧值；归档 / 删除走 `forgetSession` 一并清缓存。
- **门槛**：整条四项都没内容时不渲染；会话统计要求步数 > 0，Token 项要求计费输入或输出非 0。
- 不许把它做成第二个 `/status` 弹窗入口（`/status` 仍是独立模态，数据源是 omp 的 `get_session_stats`）。
- **四项浮层的包含块 = 整条统计条**：`relative` 挂在条根、按钮包装器不许带定位；浮层 `absolute right-0 bottom-full … max-w-full`，水平位置由 `lib/usePopoverAnchor` 实测锚到被点的项（居中于按钮再夹在条内，只写 style 不走 state，无布局环境退回 `right-0`）。
  - 相对按钮定位的宽浮层会在统计条换行时向左溢出输入卡、被中列 `overflow-hidden` 裁掉；贴条缘又会离靠左的项太远。

### 供应商用量

- 看**全部已配置供应商**的限额窗口，与当前会话模型无关。条上只有图标；读数 / 窗口名 / 「+N」只在悬停提示与浮层里；配色档由最紧的窗口定（`entryGlance`）。
- 只有「一次都没拿到数据且最近一次查询失败」才置灰（`lib/usageLimits.ts` 的 `usageEntryDisabled`）；不许按 `currentModel` 的供应商过滤或置灰。
- **读数口径唯一**（`lib/providerUsage.ts` 的 `limitReading`，弹窗与浮层共用）：
  - 有比例才画条 + 百分比；余额型给「$X 剩余」；计数型给数量原文。
  - percent 缺省 0 不是读数，拿它显示就是编造「0.0%」。
- 浮层按供应商分卡片：有比例的窗口两行（名称 + 重置倒计时 / 通栏进度条 + 百分比），余额窗口一行放完。
- **commandcode 月度窗口由壳侧补充探针补**：omp 18.12 只报 5 小时 / 每周 / 余额；月度剩余在官方 `credits.monthlyCredits`，总额按 planId / cap 组合反查官方套餐表。
  - omp 已有报告时只补缺的窗口、不覆盖 omp 读数——缺了月度就只剩一行 credits 余额。

## 消息列

### 流式渲染管线

`frameToViewMsgs` → `mergeEvents`（rAF 合并缓冲：同 id 折叠、工具卡合并）→ `useSessionEvents`（历史 LRU：只留最近 3 个会话，running 豁免）→ `Thread`。

- `AssistantText` 两段式分块（`mdBlocks`：冻结前缀 memo + 活跃尾块每帧重走；围栏骨架只在「围栏开、无内容」时）。
- 平滑揭示（`streamReveal`：有界追赶、complete 立即全量）。
- 光标 = 测量覆盖（`streamCaret` 只写 style，不许搬 React 管理的 DOM）。
- **贴底跟随 = sticky 语义**（`useLayoutEffect` + `onScroll` / `followBottom` 共用 `userScrolledAway` + ResizeObserver 回调 ref；`events` 引用变化即跟）。
  - 释放只看「用户上翻」（scrollTop 净位移 > 8px 且离底 ≥ 80px）。按「距底距离」判会把视口变矮（输入框长高 / 查找条 / 窗口缩放）当成滚开，跟随会永久死亡。
- 无内容文本块（只有空白 / 孤立标点的 `{"type":"text"}`）不落正文行（`textHasContent`，历史与实时同口径）。
- 实时行 id = `${sid}:${msgSeq}:${contentIndex}`（contentIndex 每条消息从 0 重数，只用它会撞车）；重开实时流过的会话按「类别 + 全文」与历史配对，不许翻倍。
- 历史先加载最近一页，向上可继续读取更早页；读失败提供重试，超长记录跳过时给出提示。
- 历史回读与实时消息交错时，以历史行顺序、已配对的实时锚点及可用时间合并；未能定位的实时行留在最新历史之后。
- 本地用户消息保存原文与实际发送文本：实时回显和历史回读按发送文本依次配对，已缓存的消息继续显示原文；重新启动后历史以 omp 记录为准。
- 本地消息和实时用户回显分别使用进程内递增身份，避免同一毫秒内的不同消息在帧合并时互相覆盖。
- 历史先于实时回显到达时，已配对行继续等待回显并保留历史身份；上游未提供跨提交与持久记录的关联身份时，相同发送文本仍可能存在歧义。
- 历史区间不连续而重建快照时，仍等待实时回显的用户消息继续保留。
- 向前读取发送前尚未加载的旧历史时，不把这些旧行与该次发送的本地消息或实时回显配对。
- 重读最新历史时，已知在发送前存在的文件记录也不参与该次发送的配对。
- `text_end` 是文本块完结信号（消费它，行才收敛）；工具占位卡从 `partial` 取真名 / 真 id / 半截参数。
- **注入消息分类**：`role=developer`（omp TTSR 规则提醒 `<system-reminder …>`）不落正文——历史与实时都渲染成一条 `divider:"reminder"` 紧凑行（规则名进文案，正文不入流）；其余未知 role 一律不按正文渲染（正文只认 assistant）。

### 滚动

- `.thread-scroll` 必须保持 `overflow-y: auto`（`index.css`）——跟随 / 回看 / 加载更早全靠它（V32 曾漏恢复导致「输入框上方文字重叠」）。

### 布局派生

`lib/threadLayout.ts` 的 `buildThreadLayout(shown, running)` 是渲染前的唯一布局派生：

- 相邻同类工具行聚合成摘要行（命令批 / 编辑卡 / 任务清单批——`todo` 工具行连成一段折成「更新了 N 次任务清单」，清单当前状态看底部浮卡）。
- 每轮末尾追加轮时长行（`user.at` → 该轮最后一条消息的 `at`；running 时跳过流尾轮）。
- `ViewMsg.at` 来源：历史 = jsonl 行的 `timestamp`（`lib/viewmsg.ts` 的 `lineAtOf`）；实时 = 帧到达时刻（`useSessionEvents` 统一打戳）。
- 聚合 / 时长只在布局层做，不改 `mergeViewMsgs` 的合并口径。

### 轮次定位轨

`components/thread/TurnRail.tsx` + 数据面 `lib/turnRail.ts`（形态照 DeepSeek Harness 的 `TurnNavigator`）。

- 消息列右缘一条每轮提问一道刻度的竖轨；`Thread` 外壳挂 `@container/thread`，容器宽 <900px 收起、<2 轮不渲染。
- **一轮 = 一条用户消息**（用户行带 `data-turn` 锚点）；刻度固定 10px 节距、20×2px 右对齐；满了在轨内滚动（两端遮罩淡出）；当前轮最长最亮（`aria-current`）。
- **当前轮判定**：贴底 = 最新一轮（与 Thread 跟随共用 `lib/threadScroll.ts` 的 `NEAR_BOTTOM_PX`）；否则阅读线 = 视口顶 + `min(96px, 20% 视口高)` 落在哪一轮之上（`activeTurnAt`）。
- 悬停 / 聚焦出预览：本轮提问 1 行 + 本轮最后一条**已完成**助手正文 3 行；`role=tooltip`、不可悬停；流式半截不进预览。
- 点击已加载轮次 = 行顶落到视口顶 +24px（`turnJumpTop`，平滑滚动，`prefers-reduced-motion` 时瞬时）。
- 还有未读取的历史页时隐藏轮次定位轨，避免用不完整历史计算绝对轮次；历史读全后，点击未渲染轮次先扩大渲染窗口，再在下一帧落地。
- 两条路都先撤贴底跟随（跳轮 = 读者接管）。
- 滚轮停在轨上时接力给消息列（轨装得下时；否则右缘 28px 会变成滚不动的死区；轨自己溢出时只滚轨）。
- 不许做成第二套滚动条 / 按内容比例铺刻度 / 用 `index` 当轮次号；展示定位轨时编号与预览始终以完整会话为准。

### 任务清单浮卡

`thread/PlanCard.tsx`；数据面 = `store.plansBySession`。

- **上游没有「清单更新」事件**，全量真值只有两处：
  - todo 工具帧的 `result.details.phases`（`tool_execution_end` 与 `message_end{toolResult}` 两路同形，实测 18.10.4）。`useSessionEvents` 的 handler 实时写 store 的 `applyPlans`——`plansBySession` 是唯一写入面，值没变不写。
  - `get_state.todoPhases` 回读（数组即覆盖；空数组 = 已清空并删浮卡状态；resume 历史会话靠它恢复）。
- `todo_reminder` 是「未完成项提醒」（`{todos,attempt,maxAttempts}`，不带 phases）——不解析、不进消息流。`todo_auto_clear` 收到即清空（探针 80s 未触发，兜底分支）。
- 真值形状：phase / task 无 id（key 用下标）；状态集含 `blocked`（带 `blocker` 文案）。
- 展示只有一处（符号 / 色调 / 统计文案统一在 `lib/todoDisplay.ts`：`TODO_DISPLAY` / `countTodos` / `todoStatsText`）：
  - 消息列底部浮卡：贴消息列底部、浮在输入卡上方；挂 Thread 相对定位外壳，宽度 = `--measure-content`；高度回报 Thread 给消息流垫等高留白，回底按钮随之让位。
  - 头部行 = 图标 + 「任务」+ 未完成档位统计「1 进行中 · 10 待处理」+ 折叠箭头；整行 = 开合开关；展开 = 清单区 `max-h` 内滚。
  - 开合在 `store.planCardBySession`：首次出现默认收起（无记录 = 收起；用户展开后不被清单更新覆盖）；全部完成只在 `allDone` 翻转那一下自动折成头部行，没有隐藏档；清空即退场。
- **新回合发送成功**（`Composer.sendTextTo` / 手机 `MobileComposer.send_message`）时若清单全部完成，走 `dismissCompletedPlans` 连数据带浮卡一起收起，并记下签名挡掉 `get_state` 在 omp 自动清理窗口内的同签名回读（omp 的 `tasks.todoClearDelay` 只是它自己 UI 的计时器，不挡会「复活」）。未完成的清单不动。

## 左栏

`components/sidebar/`。

### 会话状态点

`components/sidebar/SessionStatusDot.tsx` + `index.css` 的 `.status-*`。会话行的状态只有一处 = 行首 16px 槽里的一个点。

四档按唯一优先级取第一档（`lib/sessionRowStatus.ts` 的 `sessionRowStatus`，行首点 / 行尾标签 / 悬停文案共用）：

1. **待处理**（橙点，`awaiting-approval`：等审批 / 等回答）
2. **运行中**（中性灰转圈环）
3. **已完成未查看**（绿点）
4. **空闲**（不显示点，槽位仍占位、标题列不错行）

视觉参数对齐上游：环 14px SVG、轨道 `opacity .25`、弧 `stroke-width 2` + `dasharray 12 150`、1.5s 匀速旋转 + 弧长伸缩；实心点 = 10px 容器里 `inset 20%` 的圆（视觉 6px）；`prefers-reduced-motion` 走静态弧降级。

待处理档把行尾相对时间换成「待处理」标签（完整时间仍在 `title` 里）。

状态输入两路：`store.statusBySession`（打开过的会话，实时）× 行自带 `running` 快照（没打开过），与 `mergedSessions` 同口径。不许把状态标放回行尾。

### 未读

- 后台会话的一轮起止只有 `list_sessions` 快照看得到：`running` 字段 = 任务在跑（进程表活动态派生）。
- `ChatSidebar.reload` 对比上一份快照，`running → 非 running` 且不在前台 → `store.markUnread`；打开会话（SessionRow 点击）`clearUnread`。
- 运行期状态，不持久化。

### 列表缓存同步

`mergedSessions` 把 `store.sessions` 当真相覆盖，并把「扫描结果里没有的行」补回列表（服务刚新建、还没落盘的会话）。

- 删除 / 归档 / 恢复必须在 `runSessionBatch` 里同步这些行：删除 = 丢行 + 清激活；归档 / 恢复 = 只改归档位。
- 漏掉这一步的后果：后端删掉 jsonl、下一次刷新扫不到，缓存里那行又被补回来（还被顶到组首），看着像「点删除以后又冒出一个会话」；归档同理——缓存里过期的 `archived: false` 会顶掉扫描回传的 `true`。
- 归档 / 恢复 / 删除只走这一条实现，不许各写一份「归档完清什么」。

### 外部项目改名

左栏项目名来自后端覆盖层路径的末段目录名；外部（Finder / 终端 / 其他应用）重命名项目目录（或它的上级目录）后，前端不靠猜，交后端按目录身份链找回（见 `docs/architecture.md` 的「项目路径与外部改名」）。改变父目录的移动不跟随，仍显示「目录缺失」并走手动重定位。

- 窗口重新获得焦点 / 转回可见：重拉项目 + 目录行 + 工作区清单；可见时每 10s 轻量对账一次，路径变化立即重拉（`App` 的 `useExternalProjectSync`）。
- 前端用「项目 id + path」签名判断路径是否真的变了；变了一次就重扫会话列表，否则扫描行里的 `projectId` 仍是旧路径算出来的，新目录里的会话会被当成未归属。
- 旧会话的 `cwd` 不会被改写：项目路径跟随后，旧会话可能落到「未归属会话」或无法 resume，这是数据边界，不在 UI 里假装它跟着搬了。

### 冷启动水合

`projects` / `checkouts` / `workspaceGroups` 都是内存态，重启后为空的补齐只有左栏挂载这一趟（`ChatSidebar` 的 `coldLoaded`；目录行 + 工作区清单走 `loadCheckouts` 一次拉齐）。

- 条件必须各自独立（谁的清单为空补谁），不许拿旁证当门：老实现把工作区清单挂在「已经有项目」下，冷启动时 `projects` 还空着 → 那一趟整个跳过，左栏把建好的工作区渲染成平铺（`sections === null` 平铺分支），看着像「重启后工作区丢了」（后端 `overlay.json` 数据完好）。
- `loadCheckouts` 里两份数据各落各的（`allSettled`）：目录行要跑 `git worktree list`，它失败不许把工作区清单一起拖没；目录行自己的失败照旧抛给调用方。

### 顶层分组开合与上次会话恢复

- app 打开时左栏只展开第一个顶层分组（有工作区 = 第一个工作区段；平铺 = 第一个项目块），其余收起；上次关闭时选中的会话所在的那一个优先。
- 开合是受控 details（`ChatSidebar` 的 `openTop`）：默认值从数据派生、不写 state、不用 effect；用户第一次点击后由 `onToggle` 接管；不持久化，每次打开都重新摆。工作区段内的项目块不占开合表。
- 上次会话记在 `lib/lastSession.ts`（`omp.lastSession.v1`：id + projectId + title + cwd；随选中 / 改名写入，内容没变不写；只是 hint 不是真相）。
  - `App` 的 `useLastSessionRestore` 冷启动读它 → `openSessionWithHistory(id, hint, { trustView: true })`：hint 让标题 / 项目 / 目录立刻到位；`trustView` 让 open 的真值整行收敛 title/note（记录来自上次运行、可能陈旧；只有恢复路径传它）。
  - 打不开（会话被删 / omp 不可用）时回到空态（`activeSessionId: null`），记录留着下次再试。

### 前端显示层的 running 派生

左栏对**打开过的会话**（有 `statusBySession` 记录）的 `running` 一律按实时状态派生（`ChatSidebar.mergedSessions`，running / awaiting-approval = 在跑，与 Composer 同口径）。

- `store.sessions` 行的 `running` 只是 open / refresh 时刻的快照，任务结束没有写入面把它归零；整行覆盖扫描行会把跑完的会话永远钉在转圈。
- 没打开过的行（无状态记录）才用行自带值。

## 右栏工作台

`components/workbench/`。目标目录 = 当前会话 cwd（`lib/context.ts` 的 `resolveContext`），会话切换即跟着切。

### 文件页签

`workbench/FileTree.tsx`，只读目录树。

- 懒加载一层（`list_dir`，`withRepoRoot` 只在树根传）；目录优先 + 名称升序；每目录分片 200 条；单层超 2000 条截断。
- **类型图标 = Material Icon Theme**（`workbench/FileIcon.tsx` + `lib/fileIcons.ts`）。
  - 资产由 `scripts/generate-material-icons.mjs` 从 devDependency `material-icon-theme` 裁剪生成到 `lib/materialIcons.generated.ts`。
  - 匹配顺序：完整文件名 → 多段扩展名 → 扩展名 → 默认 `file`/`folder`；目录带展开态。
  - 只用于文件树与 ⌘⇧P 引用浮层的类型识别，是「单一 accent」的有意例外。
- **顶部快速过滤** = 输入即搜：防抖 180ms → `search_paths`，后端 `workspace_fs.rs` 只读递归搜名字 / 带 `/` 的相对路径，跳依赖与缓存目录，深度 24 / 扫描 20 万条 / 命中 800 三重预算。
  - 文件与文件夹都出；点结果 = 清空过滤 + 在树里逐级展开定位（1.6s 高亮）。
- 未提交改动拿一次 `get_change_set`，按「仓库根 + 相对路径」换算成绝对路径打徽标（`M/A/D/R·C/?`）。
- 点文件用系统默认程序打开；行尾 hover 出「引用到输入框」（`mention_label` 取短标签 → `store.pendingReference` → Composer 插成引用芯片）与「在访达中显示」。
- **不许变成编辑器**：只读、不写文件、不预览内容。

### Git 图谱页签

`workbench/GitGraphPanel.tsx`（形态参照 VS Code Git Graph）；数据面是 `git_graph.rs` 的三条**只读**命令。

- **提交图**：`git_graph(cwd, rev, limit, skip)` 按 `--topo-order` 取提交（`--branches --tags --remotes HEAD`，不含 stash / notes），返回 hash / 父提交 / 作者 / 时间 / 标题 / `%D` 引用（HEAD、本地分支、远程、标签）。
  - 前端 `lib/gitGraph.ts` 只算拓扑：每个提交在唯一 lane 等待；第一个父提交继承本 lane，其余父提交占新 lane，已被别的分支登记的父提交直接并入（斜线，不复制节点）。只连接**当前可见集合里存在**的父提交，筛选 / 分页边界不会挂悬空线。
  - 渲染是每行一个 SVG（列宽 = lane 数，封顶 120px；lane 颜色循环），行高按有无引用 chip 分 40 / 60px（正文 16px + 元信息 12px 固定行高，不溢出）。
- **分页**：一页 200 条，`skip` = 已加载条数；「加载更多」追加并去重，累计上限 2000 条（每行一个 SVG，不做虚拟化；到顶提示改用分支筛选）。刷新 / 换分支 / 换目录都从第一页重取。
- **分支筛选**：下拉只列本地 + 远程分支（符号引用 `origin/HEAD` 不收）；选中的是**完整引用**（`refs/heads/x`），后端校验存在后才传给 `git log`。文本筛选只筛**已加载**的提交（消息 / 作者 / hash / 引用名），并按其可见集合重算 lane。
- **未提交改动行**：`get_change_set` 与图谱并行取一次；有文件才出现，点开列文件，点文件走工作区 `git_file_diff`（未跟踪给全文）。
- **提交详情**：点提交行取 `git_commit_detail`（元信息 + 文件清单）；合并提交按**第一个父提交**给改动（`git show --first-parent`），详情里明说。点文件取 `git_commit_diff`，路径按仓库根、`--literal-pathspecs` 精确匹配；超过 40 万字符截断并提示。
- **只读**：不做 checkout / reset / cherry-pick / stash / 暂存；写操作仍走提交面板与 `switch_branch`。没有右键菜单（全 app 禁用原生右键），操作都在详情头部。
- 状态口径：列表结果按 `${cwd}\0${rev}\0${刷新序号}` 键存，「加载中」= 当前键没有结果（不在 effect 里同步清状态）；详情按 `${cwd}\0${hash}` 键存；切目录后旧选中 / 旧分支选择自然失效。页签 `visible` 为假时不取数，切回来重读一次。

### 脚本页签

`workbench/ScriptsPanel.tsx` + `project_scripts.rs` 的 `discover_scripts`。

- 后端只读扫清单文件给出候选命令：
  - `package.json` 的 scripts（包管理器由锁文件 / `packageManager` 定）
  - `Cargo.toml`（固定五条 + `.cargo` 的 `[alias]`）
  - `go.mod`、`manage.py` / `pyproject.toml` 的 scripts 段
  - `Makefile` / `justfile` / `Taskfile`
- 解析全是行扫描（不为几个清单文件引 TOML / YAML 依赖；认不出的写法就是没有，不猜）。
- **自定义脚本** = 本应用偏好：`store.customScripts` 按 cwd 分组、localStorage `omp.scripts.v1`；不写用户仓库。
- 执行：点脚本 → `runInTerminal(cwd, command, title)` 新开一个终端（标签名 = 脚本名）→ 展开右栏、切到终端页签 → 落 `store.pendingTerminalRun{terminalId}`，由那个 `TerminalPane` 在 PTY 建好后写进 PTY。
  - 注入走 `terminal_write_ready`：后端 `pty.rs` 的 `shell_ready` 等行编辑器把终端切到 raw（提示符出来、能读输入）再落字。
  - **不许**按首帧输出 / 固定延时写：cooked 期写会被 tty 回显一遍、行编辑器再重画一遍，命令在终端里出现两遍（2026-10-22 用户实测）。
  - 8s 超时兜底；`consumedRunRef` 挡重复投递。脚本面板不自己起进程；连点几条脚本就是几个终端。
- **终端页签** = 多开的 PTY 登录 shell（`pty.rs` + `workbench/TerminalPane.tsx`）：
  - `terminal_spawn` 建 PTY；输出走 Tauri Channel；`terminal_write` / `terminal_resize` / `terminal_kill` 三路寻址。
  - 实例表 = `store.terminals`（`{id, cwd, title}` + `activeTerminalId`）：页签内一条标签行（切换 / 新建 / 关闭，横向滚动、标签名截断）；上限 6，超出淘汰最旧的**非活跃**项（组件卸载即 kill）。
  - 终端在创建时定格 cwd，不随会话切换改目录、也不被会话切换杀掉（切会话只影响「新建终端用哪个目录」）。
  - 高频字节流只进 xterm，不进 store；应用退出走 `pty::kill_all`。
  - **不许**再引入终端形态的会话模型（π 标题 / 目录行 / 标签栏 / 覆盖层注入）。
