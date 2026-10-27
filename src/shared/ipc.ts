/** Tauri command / event 通道常量，前后端共用命名。 */
export const IPC = {
 // commands
 getHealth: "get_health",
 getModels: "get_models",
 refreshModels: "refresh_models",
 getOverlay: "get_overlay",
 listProjects: "list_projects",
 reconcileProjects: "reconcile_projects",
 addProject: "add_project",
 removeProject: "remove_project",
 relocateProject: "relocate_project",
 listSessions: "list_sessions",
 listArchivedSessions: "list_archived_sessions",
 archiveSessions: "archive_sessions",
 unarchiveSessions: "unarchive_sessions",
 deleteSessions: "delete_sessions",
 setOmpPath: "set_omp_path",
 // 工作区（V21）：多项目容器（左栏顶层单元）
 listWorkspaces: "list_workspaces",
 createWorkspace: "create_workspace",
 updateWorkspace: "update_workspace",
 deleteWorkspace: "delete_workspace",
 // 左栏拖拽（V26）：项目排序 + 拖进 / 拖出工作区（归属与全局顺序一次写完）
 moveProject: "move_project",
 // 目录行（V21 前叫「工作区行」）：项目 → 主目录 + git worktree（只读展示）
 listCheckouts: "list_checkouts",
 // 引用工作区文件（V22）：工作区成员项目的文件列表（git ls-files；只读）
 listProjectFiles: "list_project_files",
 // 工作区提交 / 推送（V19）：默认壳侧快路径（一次 omp -p 生成 + git commit/push），
 // 另有一条可选的完整轨（omp commit，含 CHANGELOG 维护）
 getChangeSet: "get_change_set",
 generateCommitMessage: "generate_commit_message",
 commitSelected: "commit_selected",
 startFullCommit: "start_full_commit",
 pushWorkspace: "push_workspace",
 cancelCommitTask: "cancel_commit_task",
 getWorkspaceGitState: "get_workspace_git_state",
 /** 拉取远程（行徽章的「远程有新提交」点击）：无冲突直接合并，冲突停在合并态。 */
 pullWorkspace: "pull_workspace",
 /** 冲突解决后继续合并（标记已解决 + 用合并信息提交）。 */
 continueMerge: "continue_merge",
 /** 放弃这次合并（恢复拉取前的工作区）。 */
 abortMerge: "abort_merge",
 // 供应商（设置 › 供应商）：login / logout / modelRoles
 listProviders: "list_providers",
 getProviderLogin: "get_provider_login",
 startProviderLogin: "start_provider_login",
 providerLoginInput: "provider_login_input",
 cancelProviderLogin: "cancel_provider_login",
 logoutProvider: "logout_provider",
 getModelRoles: "get_model_roles",
 setModelRole: "set_model_role",
 // 模型配置（设置 › 模型）：激活一套配置 / 编辑激活配置 = 整表覆盖 modelRoles
 applyModelRoles: "apply_model_roles",
 // Ctrl+P 轮换序（设置 › 模型）：cycleOrder = modelRoles 的派生投影，幂等同步
 syncCycleOrder: "sync_cycle_order",
 // 失败转移链（设置 › 模型）：retry.fallbackChains 的读写与两个配套开关
 getFallbackChains: "get_fallback_chains",
 setFallbackChain: "set_fallback_chain",
 setRetryOptions: "set_retry_options",
 /** 供应商登出 / 删除后清理 omp 侧对它的模型引用（modelRoles / fallbackChains / cycleOrder）。 */
 purgeProviderModels: "purge_provider_models",
 // 记忆（设置 › 记忆）：omp 项目记忆的列表 / 查看 / 删除
 listMemories: "list_memories",
 readMemoryFile: "read_memory_file",
 deleteMemoryFile: "delete_memory_file",
 deleteMemoryProject: "delete_memory_project",
 // 使用统计（设置 › 使用统计）：会话 jsonl 里 usage 的聚合 ∪ 壳侧账本（已删除会话的补记；只读）
 getUsageStats: "get_usage_stats",
 // 供应商用量（设置 › 供应商用量）：`omp usage --json` 的各供应商滚动窗口（只读）
 getProviderUsage: "get_provider_usage",
 // omp 设置目录（设置 ›「常用设置」）：上游完整目录（文本 + JSON 两路 config list 的合并，只读）
 getOmpSettingsCatalog: "get_omp_settings_catalog",
 // 写一个设置项 / 恢复默认（cwd 钉 agentDir，写 omp 全局配置）
 setOmpSetting: "set_omp_setting",
 resetOmpSetting: "reset_omp_setting",
 // 系统授权（设置 ›「系统授权」）：macOS TCC 四项授权检测 + 跳转系统设置
 getSystemPermissions: "get_system_permissions",
 openSystemPermission: "open_system_permission",
 // omp 约束（设置 ›「omp 约束」）：全局 AGENTS.md / RULES.md / rules/*.md 的读写
 getOmpConstraints: "get_omp_constraints",
 writeOmpConstraint: "write_omp_constraint",
 createOmpRule: "create_omp_rule",
 deleteOmpRule: "delete_omp_rule",
 // 自定义模型（设置 › 供应商）：omp `models.yml` 的读写——上游没有 CLI 写入口，写文件是唯一路径
 readModelsConfig: "read_models_config",
 writeModelsConfig: "write_models_config",
 // 供应商模型发现（设置 › 供应商 ›「获取可用模型」）：直接问端点要模型清单（只读探测，不落盘）
 fetchProviderModels: "fetch_provider_models",
 // 插件（设置 ›「插件」）：omp 插件清单 / 启停 / 特性 / 安装 / 卸载 / 体检（全部经 `omp plugin`）
 listPlugins: "list_plugins",
 setPluginEnabled: "set_plugin_enabled",
 setPluginFeatures: "set_plugin_features",
 installPlugin: "install_plugin",
 uninstallPlugin: "uninstall_plugin",
 pluginDoctor: "plugin_doctor",
 // 技能（设置 ›「技能」）：`omp skill list` 的发现结果 + `disabledExtensions` 的逐项启停
 listSkills: "list_skills",
 setSkillEnabled: "set_skill_enabled",
 readSkillFile: "read_skill_file",
 // 会话标题语言（V18）：把界面语言同步成 omp 的 `<agentDir>/TITLE_SYSTEM.md`（标题生成 prompt）
 syncTitlePrompt: "sync_title_prompt",
 // omp 运行时更新（`omp update --check` 只检查；`omp update` 才是真安装）
 checkOmpUpdate: "check_omp_update",
 startOmpUpdate: "start_omp_update",
 cancelOmpUpdate: "cancel_omp_update",
 // omp 缺失时的首次安装（官方安装脚本；与更新共用后端单槽与取消命令）
 installOmp: "install_omp",
 // 会话命令面（per-会话长驻 `omp --mode rpc-ui`）
 createSession: "create_session",
 openSession: "open_session",
 renameSession: "rename_session",
 getHistory: "get_history",
 sendMessage: "send_message",
 steerMessage: "steer_message",
 followUpMessage: "follow_up_message",
 runSlash: "run_slash",
 compactSession: "compact_session",
 readImageFile: "read_image_file",
/** omp blob 图片（历史会话里的 `blob:sha256:<hash>` 引用）按需读取。 */
readBlobImage: "read_blob_image",
/** 把一张图写进系统剪贴板（历史 blob 与实时 base64 共用）。 */
copyImage: "copy_image",
/** 另存为本地文件（路径来自系统保存对话框）。 */
saveImageFile: "save_image_file",
/** 存储维护：占用读数 / 清理预览 / 执行清理 / 立即回收闲置会话。 */
getStorageStats: "get_storage_stats",
previewStorageCleanup: "preview_storage_cleanup",
cleanStorage: "clean_storage",
reclaimIdleSessions: "reclaim_idle_sessions",
 checkPaths: "check_paths",
 completePath: "complete_path",
 stopSession: "stop_session",
 approve: "approve",
 respondUi: "respond_ui",
 setModel: "set_model",
 setThinking: "set_thinking",
 getSessionRuntime: "get_session_runtime",
 /** omp 全局「默认思考等级」（`defaultThinkingLevel`）：思考档选择器的默认显示与兜底档。 */
 getDefaultThinkingLevel: "get_default_thinking_level",
 getGlobalApproval: "get_global_approval",
 setGlobalApproval: "set_global_approval",
 setSessionApproval: "set_session_approval",
 getGitInfo: "get_git_info",
 /** 输入卡顶行分支切换（`git switch`）：脏工作区冲突由 git 拒绝并回传原文。 */
 switchBranch: "switch_branch",
 getContextBreakdown: "get_context_breakdown",
 // —— V40（对标 codex / zcode）：队列真值 / 消息分叉 / 目标模式 / 旁问 / 统计 / 重启 ——
 /** 撤回一条尚未投递的队列消息（steering 或 followUp）→ `{removed, images?, imagesDropped?}`。 */
 removeQueuedMessage: "remove_queued_message",
 /** 把一条 followUp 排队提升为 steering 插话 → `{promoted}`。 */
 promoteQueuedMessage: "promote_queued_message",
 /** 中断并交还队列（Esc 语义：omp TUI 的 Esc 等价物）→ `{steering,followUp}`。 */
 abortAndRestoreQueue: "abort_and_restore_queue",
 getSessionStats: "get_session_stats",
 /** 会话累计统计（轮 / 步 / 用时 / 吞吐 / token 累计；输入卡底部统计条）。 */
 getSessionLiveStats: "get_session_live_stats",
 btwAsk: "btw_ask",
 btwCancel: "btw_cancel",
 getBtwHistory: "get_btw_history",
 /** 重启会话 runtime（执行模式切换的即时生效路径；仅 idle 且队列空时允许）。 */
 restartSessionRuntime: "restart_session_runtime",
 /** 单文件工作区 diff（含 untracked 全新增视图）。 */
 gitFileDiff: "git_file_diff",
 // —— V41（对标二期）：子代理 / fast·slow 模式 / 会话导出 ——
 getSubagents: "get_subagents",
 cancelSubagent: "cancel_subagent",
 getSubagentMessages: "get_subagent_messages",
 setFastMode: "set_fast_mode",
 exportSessionHtml: "export_session_html",
 /** 大段粘贴转文件引用（V41）：文本落 `<appData>/omp-inn/paste/`，返回绝对路径。 */
 savePaste: "save_paste",
 /** 本地 shell（V41，codex 的 `!` 前缀）：在会话进程里跑一条命令并取回输出。 */
 runBash: "run_bash",
 // —— V42（右栏工作台）：文件目录树 + 终端 ——
 /** 列一层目录（文件页签懒加载）；`withRepoRoot` 只在树根传（变更标色要仓库根）。 */
 listDir: "list_dir",
 /** 文件页签的快速过滤：按名字 / 相对路径递归搜索文件与文件夹（只读，带扫描预算）。 */
 searchPaths: "search_paths",
 /** 引用注入的短标签：路径 → 最短唯一后缀（会话目录外原样返回绝对路径）。 */
 mentionLabel: "mention_label",
 /** 打开终端：PTY 里的登录 shell，输出经 Channel 回传（见 `pty.rs`）。 */
 terminalSpawn: "terminal_spawn",
 terminalWrite: "terminal_write",
 /** 脚本注入：等 shell 进入可输入状态再写（见 `pty.rs` 的 `terminal_write_ready`）。 */
 terminalWriteReady: "terminal_write_ready",
 terminalResize: "terminal_resize",
 /** 关闭终端（kill 子进程；已退出时是 no-op）。 */
 terminalKill: "terminal_kill",
 /** 识别项目里的可跑脚本（右栏「脚本」页签；只读扫描清单文件，不执行任何命令）。 */
 discoverScripts: "discover_scripts",
 // —— V51（右栏工作台）：Git 图谱（只读提交历史） ——
 /** 一页提交历史（跨分支；`rev` 给完整引用时只看该分支，`skip` / `limit` 分页）。 */
 gitGraph: "git_graph",
 /** 一次提交的元信息 + 文件清单（合并提交按第一个父提交）。 */
 gitCommitDetail: "git_commit_detail",
 /** 提交内单文件的统一 diff（路径相对仓库根）。 */
 gitCommitDiff: "git_commit_diff",
 // —— V50：手机远程控制（内嵌 HTTP/WS + 扫码配对）——
 remoteGetStatus: "remote_get_status",
 remoteStart: "remote_start",
 remoteStop: "remote_stop",
 remotePairing: "remote_pairing",
 remoteCancelPairing: "remote_cancel_pairing",
 remoteRevokeDevice: "remote_revoke_device",
 remoteRevokeAll: "remote_revoke_all",
 remoteTailscaleProbe: "remote_tailscale_probe",
 remoteTailscaleEnable: "remote_tailscale_enable",
 remoteTailscaleDisable: "remote_tailscale_disable",
 // events
 /** 供应商登录进度（payload = 全量 ProviderLoginStatus 快照）。 */
 providerLogin: "omp-provider://login",
 /**
  * 模型目录快照刷新完成（payload = 全量 ModelCatalog）。
  * `omp models --json` 实测 2–10s：后端把目录拉取收敛成单飞 + 缓存（过期只后台刷新），
  * 新快照完成后广播——已挂载的设置页（模型 / 供应商）据此原地更新，不必自己重拉。
  */
 modelsRefreshed: "omp-models://catalog",
 /** 聊天会话事件流（payload = 单帧 omp RPC 事件；`useSessionEvents` 归一成 ViewMsg）。 */
 chatEvent: (id: string) => `omp-event://${id}`,
 /** 聊天会话状态（payload = `{state}`；running / idle / awaiting-approval / error / exited）。 */
 chatStatus: (id: string) => `omp-status://${id}`,
 /** 聊天会话运行时真值（payload = 全量 SessionRuntime 快照）。 */
 chatRuntime: (id: string) => `omp-state://${id}`,
 /** 手机远程控制状态（payload = RemoteStatus；启动/停止/配对/撤销/连接数变化时推）。 */
 remoteState: "remote://state",
} as const;
