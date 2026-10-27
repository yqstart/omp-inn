import { useCallback, useEffect } from "react";
import { Bulb, Check, ChevronDown } from "reicon-react";
import { api } from "@shared/api";
import type { ModelInfo } from "@shared/types";
import { useApp } from "../../stores/app";
import { fmt } from "../../lib/locale";
import { useText } from "../../lib/useText";
import { useDropdown } from "../../lib/useDropdown";
import { clampThinking, thinkingLevelsOf } from "../../lib/thinking";
import { ensureOmpDefaultThinking } from "../../lib/thinkingDefault";

/**
 * 思考档选择器（2026-10-14 与模型选择器拆分）：触发按钮 = 灯泡图标 + 当前档，浮层 = 当前模型
 * **真正支持**的档位行钮列表（`off` 恒可用，当前档打勾）+ 一行「omp 默认」提示。
 * 形态与模型 / 执行模式选择器同口径：顶部小标题 + 纵向行钮列表（不再用一排横向芯片）。
 *
 * **默认档口径**：读 omp 的 `defaultThinkingLevel`（`lib/thinkingDefault.ts`）——omp 真值合法就显示
 * 真值，真值不可用（缺档 / 对新模型非法）才显示配置默认档夹到该模型的支持集；配置没读到退最高档。
 * 选档只对**运行中的会话**有意义，模型不支持思考（可选档只有 off）时整个控件不出现。
 */
export function ThinkingMenu() {
  const t = useText();
  const activeSessionId = useApp((s) => s.activeSessionId);
  const composerMenu = useApp((s) => s.composerMenu);
  const currentModel = useApp((s) => s.currentModel);
  const currentThinking = useApp((s) => s.currentThinking);
  const currentEfforts = useApp((s) => s.currentEfforts);
  const models = useApp((s) => s.models);
  const ompDefaultThinking = useApp((s) => s.ompDefaultThinking);
  const open = composerMenu === "thinking";
  const setOpen = useCallback(
    (v: boolean) => useApp.setState({ composerMenu: v ? "thinking" : null }),
    [],
  );
  const ref = useDropdown(open, () => setOpen(false));
  // 打开时确保默认档是真值：App 启动已读过 → 命中缓存不起进程；上次读失败（omp 不在等）
  // 在这里自然重试，提示行不会永远空着。
  useEffect(() => {
    if (open) void ensureOmpDefaultThinking();
  }, [open]);
  const catalog = models?.models ?? [];
  const current: ModelInfo | null = catalog.find((m) => m.selector === currentModel) ?? null;
  const efforts = currentEfforts ?? current?.thinking ?? null;
  const levels = thinkingLevelsOf(efforts);
  // 真值合法显示真值；否则显示 omp 配置的默认档（夹到支持集；配置没读到 = 最高档）
  const level = currentThinking && levels.includes(currentThinking)
    ? currentThinking
    : clampThinking(ompDefaultThinking, efforts);
  // 档位选择只对运行中的会话有意义；不支持思考的模型没有可选档，整个控件不出现
  if (!activeSessionId || levels.length <= 1) return null;

  const pick = (lv: string) => {
    useApp.setState({ currentThinking: lv });
    setOpen(false);
    void api.setThinking(activeSessionId, lv).catch(() => undefined);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 py-1 whitespace-nowrap transition-colors duration-100 hover:bg-hover ${open ? "text-foreground" : "text-muted hover:text-foreground"}`}
        aria-label={t.chooseThinkingAria}
        aria-expanded={open}
        title={fmt(t.thinkingLevelsTitle, levels.join(" / "))}
      >
        <Bulb size={13} aria-hidden className="shrink-0 opacity-80" />
        <span>{level}</span>
        <ChevronDown size={13} aria-hidden className="shrink-0 opacity-60" />
      </button>
      {open && (
        <div className="absolute right-0 bottom-8 z-10 w-48 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-elevated p-1 pb-1.5 shadow-pop">
          <div className="px-2 pt-1.5 pb-0.5 text-[11px] text-faint">{t.thinkingSection}</div>
          {/* 只列 omp 真值（或目录）给出的支持档；off 恒可用 */}
          {levels.map((lv) => (
            <button
              key={lv}
              onClick={() => pick(lv)}
              className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-100 hover:bg-hover ${lv === level ? "font-medium text-foreground" : "text-muted"
                }`}
              aria-label={fmt(t.thinkingLevelAria, lv)}
              aria-pressed={lv === level}
            >
              <span className="min-w-0 flex-1 truncate">{lv}</span>
              {lv === level && <Check size={12} aria-hidden className="shrink-0 text-accent" />}
            </button>
          ))}
          {/* 默认档提示：对当前模型生效的 omp 配置默认档（真值不可用时显示的就是它） */}
          {ompDefaultThinking && (
            <div className="px-2 pt-1 text-[11px] text-faint">
              {fmt(t.thinkingDefaultHint, clampThinking(ompDefaultThinking, efforts))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
