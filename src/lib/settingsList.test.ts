import { describe, expect, it } from "vitest";
import { TEXT } from "./locale";
import {
 OPTION_LABELS,
 SETTINGS_LIST,
 SETTINGS_LIST_SET,
 SETTING_NOTES,
 SETTING_SECTION_OVERRIDES,
} from "./settingsList";
import { OMP_SETTING_NAMES } from "./ompSettingNames";

const zh = TEXT["zh-CN"];
const en = TEXT.en;

/**
 * 「常用设置」页展示清单的维护契约（四稿筛选 2026-10-15，五稿 2026-10-22）：
 * ① 无重复；② 每项有中英短名（行标题不退化）；③ 规模 87（五稿在四稿 80 项上按用户口径并入
 * 浏览器自动化 7 项——`browser.enabled` 原本就在）；
 * ④ 三稿 / 四稿明确删掉的键不得回流；⑤ 翻译 / 标注 / 归位表的键都在清单里、字典键中英非空；
 * ⑥ 字典里的每个 `sv*` 键都被翻译表引用（无孤儿——删键时要同步清翻译）。
 *
 * 与上游真实目录的核对在测试外做：清单 ⊆ 名称表（第 ② 条），名称表 ⊆ 519 快照且无幽灵键
 * （`ompSettingNames.test.ts`）——传递保证清单里的键都是本机上游真实存在的。
 */

/** 三稿明确删掉的 33 项（用户口径）：不得回流到清单里。
 *  `browser.headless` 于 2026-10-22 解禁（五稿：浏览器可见性整组上浮），其余 32 项照旧。 */
const REMOVED_WAVE3 = [
 "colorBlindMode",
 "tui.imeSafeCursor",
 "workspace.additionalDirectories",
 "branchSummary.enabled",
 "providers.maxInFlightRequests",
 "providers.openai-codex.codeMode",
 "speech.enabled",
 "speech.voice",
 "providers.fetch",
 "exa.enabled",
 "searxng.endpoint",
 "secrets.enabled",
 "bash.autoBackground.enabled",
 "bash.direnv",
 "shellMinimizer.enabled",
 "python.interpreter",
 "worktree.base",
 "commands.enableClaudeUser",
 "commands.enableClaudeProject",
 "commands.enableOpencodeUser",
 "commands.enableOpencodeProject",
 "todo.eager",
 "grep.contextBefore",
 "grep.contextAfter",
 "astGrep.enabled",
 "astEdit.enabled",
 "find.enabled",
 "debug.enabled",
 "generate_image.enabled",
 "vault.enabled",
 "security.enabled",
 "ask.enabled",
];

/**
 * 四稿删掉的 37 项（判据 = 桌面壳里没有可观测差异，逐项对照上游 description）：
 * - 终端外观与渲染：主题 / 字形 / 输入框形态与速率 / 状态行（三键）/ 终端内联图片 /
 *   mermaid ASCII / 表情反应 / 终端标题（两键）/ 鼠标 / 边距 / 平滑流式 / 工具活动行 /
 *   逐轮用量与耗时行 / 硬件光标 / 子代理模型徽标；
 * - 终端输入：vim 模式 / ⎋⎋ 行为 / 拼写三键 / 麦克风语音输入；
 * - TUI 启动与通知：启动检查更新 / 更新说明展开 / 自动恢复最近会话 / 完成·错误·提问三种终端通知；
 * - transcript 渲染：read 的 Markdown 预览与内联结果行；思考块隐藏（壳侧自己渲染思考块，
 *   该键只管 TUI 折叠，实测 jsonl 与流式帧都照常带 thinking）。
 */
const REMOVED_WAVE4 = [
 "theme.dark",
 "theme.light",
 "symbolPreset",
 "composer.shape",
 "composer.tokenRate",
 "statusLine.preset",
 "statusLine.contextLine",
 "statusLine.compactThinkingLevel",
 "terminal.showImages",
 "tui.renderMermaid",
 "tui.reactions",
 "tui.titleState",
 "tui.titleSpinner",
 "tui.mouse",
 "tui.tight",
 "display.smoothStreaming",
 "display.hideToolActivity",
 "display.showTokenUsage",
 "display.showTurnTime",
 "showHardwareCursor",
 "task.showResolvedModelBadge",
 "read.renderMarkdown",
 "read.toolResultPreview",
 "autoResume",
 "tui.vimMode",
 "doubleEscapeAction",
 "spelling.typoDetection",
 "spelling.autocomplete",
 "spelling.autocorrect",
 "startup.checkUpdate",
 "startup.changelogMode",
 "completion.notify",
 "error.notify",
 "ask.notify",
 "recap.enabled",
 "stt.enabled",
 "hideThinkingBlock",
];

describe("常用设置展示清单", () => {
 it("87 项、无重复", () => {
  expect(SETTINGS_LIST).toHaveLength(87);
  expect(new Set(SETTINGS_LIST).size).toBe(SETTINGS_LIST.length);
 });

 it("每一项都有中英短名（名称表全覆盖；行标题不退化）", () => {
  const missing = SETTINGS_LIST.filter((k) => {
   const pair = OMP_SETTING_NAMES[k];
   return !pair || !pair[0] || !pair[1];
  });
  expect(missing, `缺名称：${missing.join(", ")}`).toEqual([]);
 });

 it("规模钉在五稿定稿的 87 项（加项必须先过判据并改这里，防被扩回全量）", () => {
  expect(SETTINGS_LIST.length).toBeLessThanOrEqual(87);
  expect(SETTINGS_LIST.length).toBeGreaterThanOrEqual(60);
 });

 it("三稿删掉的 32 项不在清单里（不得回流；browser.headless 已按五稿解禁）", () => {
  expect(REMOVED_WAVE3).toHaveLength(32);
  const back = REMOVED_WAVE3.filter((k) => SETTINGS_LIST.includes(k));
  expect(back, `回流：${back.join(", ")}`).toEqual([]);
 });

 it("四稿删掉的 37 项不在清单里（不得回流）", () => {
  expect(REMOVED_WAVE4).toHaveLength(37);
  const back = REMOVED_WAVE4.filter((k) => SETTINGS_LIST.includes(k));
  expect(back, `回流：${back.join(", ")}`).toEqual([]);
 });

 it("翻译表：键都在清单里、每个字典键中英非空", () => {
  const unknown = Object.keys(OPTION_LABELS).filter((k) => SETTINGS_LIST_SET[k] !== true);
  expect(unknown, `不在清单里的键：${unknown.join(", ")}`).toEqual([]);
  for (const [key, map] of Object.entries(OPTION_LABELS)) {
   for (const [value, labelKey] of Object.entries(map)) {
    expect(zh[labelKey], `${key} = ${value}（zh 缺 ${labelKey}）`).toBeTruthy();
    expect(en[labelKey], `${key} = ${value}（en 缺 ${labelKey}）`).toBeTruthy();
   }
  }
 });

 it("字典里的每个 sv* 键都被翻译表引用（无孤儿）", () => {
  const used = new Set<string>(Object.values(OPTION_LABELS).flatMap((m) => Object.values(m)));
  const orphans = Object.keys(zh).filter((k) => k.startsWith("sv") && !used.has(k));
  expect(orphans, `孤儿字典键：${orphans.join(", ")}`).toEqual([]);
 });

 it("标注与归位表：键都在清单里", () => {
  for (const k of [...Object.keys(SETTING_NOTES), ...Object.keys(SETTING_SECTION_OVERRIDES)]) {
   expect(SETTINGS_LIST_SET[k], `${k} 不在清单里`).toBe(true);
  }
 });
});
