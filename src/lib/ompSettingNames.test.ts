import { describe, expect, it } from "vitest";
import { OMP_SETTING_NAMES } from "./ompSettingNames";

/**
 * 名称表的「字典维护」契约：
 * 1. **覆盖率**：本机 omp 18.4.4 的全量键快照（519 项，2026-09-30 取）每一条都要有条目——
 *    上游新增键没有条目时行标题回退键名（不吞信息），但快照内的键漏了就是维护失误；
 * 2. **无幽灵**：表里不许有快照之外的键（拼错键 = 名字永远用不上，界面回退键名而看不出来）；
 * 3. **中英都在**：中文名含中文、英文名不含中文（漏译立刻暴露）。
 */

/** omp 18.4.4 的 `omp config list` 全量键快照（顺序照上游人读清单）。 */
const SNAPSHOT = `auth.broker.url auth.broker.token auth.accountPolicies enabledModels enabledProviders disabledProviders
modelRoleStorage modelRoles modelTags modelProviderOrder cycleOrder setupVersion autoResume git.enabled
theme.dark theme.light symbolPreset colorBlindMode composer.shape composer.tokenRate statusLine.preset
statusLine.separator statusLine.contextLine statusLine.sessionAccent statusLine.transparent
statusLine.compactThinkingLevel statusLine.showHookStatus statusLine.leftSegments statusLine.rightSegments
statusLine.segmentOptions terminal.showImages images.autoResize images.blockImages tui.maxInlineImageColumns
tui.maxInlineImageRows tui.maxInlineImages tui.resizeScrollback terminal.showProgress tui.textSizing
tui.renderMermaid tui.reactions tui.codexResetFireworks tui.titleState tui.titleSpinner tui.hyperlinks
tui.mouse tui.tight display.shimmer display.pinnedAgents display.smoothStreaming display.hideToolActivity
display.showTokenUsage display.showTurnTime display.cacheMissMarker display.collapseCompacted
showHardwareCursor tui.imeSafeCursor steeringMode followUpMode interruptMode tui.vimMode tui.vimModeDisplay
loop.mode loop.conditionTimeoutMs composer.recallClearedDrafts doubleEscapeAction input.bareExitOnEmptySession
input.bareSlashCommands treeFilterMode autocompleteMaxVisible spelling.typoDetection spelling.autocomplete
spelling.autocorrect emojiAutocomplete paste.largeMenuThreshold startup.quiet startup.showSplash
startup.setupWizard startup.checkUpdate update.channel marketplace.autoUpdate startup.changelogMode
magicKeywords.enabled magicKeywords.ultrathink magicKeywords.orchestrate magicKeywords.workflow
magicKeywords.jevify completion.notify error.notify ask.timeout ask.notify recap.enabled recap.idleSeconds
power.sleepPrevention prewalk.enabled providers.maxInFlightRequests providers.openai-codex.codeMode
providers.openai-codex.codeModeDirectTools images.describeForTextModels defaultThinkingLevel hideThinkingBlock
proseOnlyThinking omitThinking externalThinking model.loopGuard.enabled model.loopGuard.checkAssistantContent
model.loopGuard.toolCallReminder model.toolCallLoopGuard.enabled model.toolCallLoopGuard.threshold
model.toolCallLoopGuard.exemptTools inlineToolDescriptors includeModelInPrompt includeWorkspaceTree skillful
personality temperature topP topK minP presencePenalty repetitionPenalty textVerbosity tier.openai
tier.anthropic tier.google tier.subagent tier.advisor retry.enabled retry.maxRetries retry.baseDelayMs
retry.maxDelayMs retry.waitForUsageReset retry.modelFallback retry.usageAwareFallback retry.usageReservePct
retry.usageReservePolicy retry.fallbackChains retry.fallbackRevertPolicy
providers.anthropic.serverSideFallback providers.anthropic.slowMode providers.ollama-cloud.maxConcurrency
providers.webSearchTimeoutSeconds providers.antigravityEndpoint providers.fireworksTier
providers.tinyModelDevice providers.tinyModelDtype providers.autoThinkingMaxEffort
features.unexpectedStopDetection providers.kimiApiFormat providers.openaiWebsockets
providers.openaiLiveSteering providers.cacheRetention providers.cacheWarming
providers.streamFirstEventTimeoutSeconds providers.streamIdleTimeoutSeconds providers.openrouterVariant
live.voice tts.localVoice speech.enabled speech.mode speech.enhanced speech.voice providers.fetch
codexResets.autoRedeem codexResets.minBlockedMinutes codexResets.keepCredits codexResets.salvageHorizonHours
claudeResets.autoRedeem claudeResets.minBlockedMinutes claudeResets.keepCredits
claudeResets.salvageHorizonHours provider.appendOnlyContext thinkingBudgets.minimal thinkingBudgets.low
thinkingBudgets.medium thinkingBudgets.high thinkingBudgets.xhigh thinkingBudgets.max
telemetry.otlpExportEnabled advisor.enabled advisor.syncBacklog advisor.immuneTurns advisor.maxNotesPerUpdate
advisor.evictStaleResults workspace.additionalDirectories contextPromotion.enabled extendedContext
compaction.enabled compaction.experimentalContextManagement compaction.midTurnEnabled compaction.methodOrder
compaction.thresholdPercent compaction.thresholdTokens compaction.handoffSaveToDisk
compaction.remoteStreamingV2Enabled compaction.asyncEnabled compaction.reserveTokens
compaction.keepRecentTokens compaction.autoContinue compaction.remoteEndpoint
compaction.v2RetainedMessageBudget compaction.idleEnabled compaction.idleThresholdTokens
compaction.idleTimeoutSeconds compaction.supersedeReads compaction.dropUseless snapcompact.systemPrompt
snapcompact.toolResults tools.format snapcompact.shape branchSummary.enabled branchSummary.reserveTokens
memory.backend memories.enabled memories.maxRolloutsPerStartup memories.maxRolloutAgeDays
memories.minRolloutIdleHours memories.threadScanLimit memories.maxRawMemoriesForGlobal
memories.stage1Concurrency memories.stage1LeaseSeconds memories.stage1RetryDelaySeconds
memories.phase2LeaseSeconds memories.phase2RetryDelaySeconds memories.phase2HeartbeatSeconds
memories.rolloutPayloadPercent memories.phase1InputTokenLimit memories.fallbackTokenLimit
memories.summaryInjectionTokenLimit sharpshooter.model sharpshooter.intervalMinutes
sharpshooter.injectionTokenLimit autolearn.enabled autolearn.autoContinue autolearn.minToolCalls
mnemopi.dbPath mnemopi.bank mnemopi.scoping mnemopi.embeddingVariant mnemopi.autoRecall mnemopi.autoRetain
mnemopi.polyphonicRecall mnemopi.enhancedRecall mnemopi.proactiveLinking mnemopi.noEmbeddings
mnemopi.embeddingModel mnemopi.embeddingApiUrl mnemopi.embeddingApiKey mnemopi.llmMode mnemopi.llmBaseUrl
mnemopi.llmApiKey mnemopi.llmModel mnemopi.retainEveryNTurns mnemopi.recallLimit mnemopi.recallContextTurns
mnemopi.recallMaxQueryChars mnemopi.injectionTokenLimit mnemopi.debug hindsight.apiUrl hindsight.apiToken
hindsight.bankId hindsight.bankIdPrefix hindsight.scoping hindsight.bankMission hindsight.retainMission
hindsight.autoRecall hindsight.autoRetain hindsight.retainMode hindsight.retainEveryNTurns
hindsight.retainOverlapTurns hindsight.retainContext hindsight.recallBudget hindsight.recallMaxTokens
hindsight.recallContextTurns hindsight.recallMaxQueryChars hindsight.recallTypes hindsight.debug
hindsight.requestTimeoutMs hindsight.reflectTimeoutMs hindsight.recallTimeoutMs hindsight.retainTimeoutMs
hindsight.mentalModelsEnabled hindsight.mentalModelAutoSeed hindsight.mentalModelMaxRenderChars ttsr.enabled
ttsr.judge ttsr.contextMode ttsr.interruptMode ttsr.repeatMode ttsr.repeatGap ttsr.builtinRules
ttsr.disabledRules edit.mode edit.modelVariants edit.fuzzyMatch edit.fuzzyThreshold edit.streamingAbort
edit.recoverInlineEdits edit.blockAutoGenerated edit.enforceSeenLines edit.blackbox.enabled
edit.autoRepair.enabled tools.artifactSpillThreshold tools.artifactTailBytes tools.artifactHeadBytes
tools.outputMaxColumns tools.artifactTailLines readLineNumbers read.defaultLimit read.renderMarkdown
read.summarize.enabled read.summarize.prose read.summarize.minBodyLines read.summarize.minCommentLines
read.summarize.minTotalLines read.summarize.unfoldUntil read.summarize.unfoldLimit read.toolResultPreview
tools.approval tools.approvalMode todo.enabled todo.reminders todo.remindersMax todo.eager
tasks.todoClearDelay glob.enabled grep.enabled grep.contextBefore grep.contextAfter astGrep.enabled
astEdit.enabled find.enabled debug.enabled launch.enabled speechgen.enabled generate_image.enabled
computer.enabled computer.display computer.maxWidth computer.maxHeight images.questionTimeoutMs
checkpoint.enabled fetch.enabled vault.enabled github.enabled github.cache.enabled github.cache.softTtlSec
github.cache.hardTtlSec web_search.enabled security.enabled ask.enabled tools.intentTracing
tools.abortOnFabricatedResult tools.speculativeExecution.enabled tools.speculativeExecution.maxInFlight
tools.maxTimeout async.enabled async.maxJobs tools.xdev tools.xdevDocs tools.xdevInlineDevices dev.autoqa
dev.autoqaPush.endpoint dev.autoqaPush.token dev.autoqaConsent lsp.enabled lsp.lazy lsp.shared
lsp.formatOnWrite lsp.diagnosticsOnWrite lsp.diagnosticsOnEdit lsp.diagnosticsDeduplicate shellPath
bash.enabled bash.allowCompoundCommands bash.autoBackground.enabled bash.patterns bashInterceptor.enabled
bashInterceptor.patterns bash.direnv bash.direnvLoadTimeoutMs shellMinimizer.enabled
shellMinimizer.settingsPath shellMinimizer.only shellMinimizer.except shellMinimizer.maxCaptureBytes
shellMinimizer.sourceOutlineLevel shellMinimizer.legacyFilters bash.autoBackground.thresholdMs eval.py eval.js
eval.autoProvision eval.tools.enabled eval.workpool.freshAgents eval.autoBackground.enabled
eval.autoBackground.thresholdMs python.kernelMode python.interpreter task.isolation.enabled isolation.backend
worktree.clone worktree.cleanSource task.isolation.apply task.isolation.merge task.isolation.commits
worktree.base task.eager task.batch task.speculativeLaunch task.enableEffort task.maxConcurrency
task.enableLsp task.maxRecursionDepth task.maxRuntimeMs task.agentIdleTtlMs task.softRequestBudget
task.softRequestBudgetNotice task.maxEffort task.disabledAgents task.agentModelOverrides
task.agentServiceTierOverrides task.agentCompactionThresholdOverrides task.agentPrewalk task.agentAdvisor
task.prewalk task.showResolvedModelBadge plan.enabled plan.defaultOnStartup plan.autosave plan.autosaveDir
goal.enabled goal.statusInFooter goal.continuationModes title.refreshOnReplan extensions disabledExtensions
skills.registryUrl skills.enabled skills.enableSkillCommands skills.enableCodexUser skills.enableClaudeUser
skills.enableClaudeProject skills.enablePiUser skills.enablePiProject skills.enableAgentsUser
skills.enableAgentsProject skills.customDirectories skills.ignoredSkills skills.includeSkills
commands.enableClaudeUser commands.enableClaudeProject commands.enableOpencodeUser
commands.enableOpencodeProject extensionHandlers.toolCallTimeoutMs exa.enabled exa.searchDelayMs
searxng.endpoint searxng.token searxng.basicUsername searxng.basicPassword searxng.categories searxng.engines
searxng.language searxng.safesearch browser.enabled browser.cdpUrl browser.relay browser.relayUrl
browser.headless browser.cmux browser.tern browser.freezeOnTurnEnd browser.idleCloseSec browser.screenshotDir
ida.enabled ida.python ida.installDir ida.maxOpen ida.idleCloseSec mcp.enableProjectConfig
mcp.startupTimeoutMs mcp.renderMarkdownResults mcp.notifications mcp.notificationDebounceMs
images.urls.enabled images.urls.backends images.urls.options images.urls.credentials images.urls.command
images.urls.publicBaseUrl images.urls.ttlHours images.urls.bindHost images.urls.sshTarget
images.urls.sshRemotePort secrets.enabled stt.enabled stt.language stt.submitTrigger collab.relayUrl
collab.webUrl collab.displayName collab.autoStart share.serverUrl share.store share.redactSecrets
stream.serverUrl stream.redactPatterns commit.mapReduceEnabled commit.mapReduceThreshold
commit.mapBatchTokenBudget commit.cacheEnabled commit.cacheTtlDays commit.changelogMaxDiffChars gc.blobs
gc.archive gc.wal gc.coldArchiveAfterDays gc.retainNewestGlobal gc.retainNewestPerCwd`.trim().split(/\s+/);

describe("omp 设置名称表（519 项全量）", () => {
 it("快照本身：519 项、无重复、都是合法点分标识符", () => {
  expect(SNAPSHOT).toHaveLength(519);
  expect(new Set(SNAPSHOT).size).toBe(SNAPSHOT.length);
  for (const key of SNAPSHOT) {
   expect(key, key).toMatch(/^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z][A-Za-z0-9_-]*)*$/);
  }
 });

 it("覆盖快照的每一条键", () => {
  const missing = SNAPSHOT.filter((key) => !(key in OMP_SETTING_NAMES));
  expect(missing, `缺名称：${missing.join(", ")}`).toEqual([]);
 });

 it("没有快照之外的键（拼错的键 = 名字用不上）", () => {
  const snapshot = new Set(SNAPSHOT);
  const extra = Object.keys(OMP_SETTING_NAMES).filter((key) => !snapshot.has(key));
  expect(extra, `幽灵键：${extra.join(", ")}`).toEqual([]);
 });

 it("中英名都非空；中文名含中文、英文名不含中文", () => {
  for (const [key, [nameZh, nameEn]] of Object.entries(OMP_SETTING_NAMES)) {
   expect(nameZh.trim(), `${key} 中文名`).not.toBe("");
   expect(nameEn.trim(), `${key} 英文名`).not.toBe("");
   expect(/[\u4e00-\u9fff]/.test(nameZh), `${key} 中文名没有中文：${nameZh}`).toBe(true);
   expect(/[\u4e00-\u9fff]/.test(nameEn), `${key} 英文名混了中文：${nameEn}`).toBe(false);
  }
 });
});
