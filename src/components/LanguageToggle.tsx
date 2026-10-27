import type { KeyboardEvent } from "react";
import { Monitor } from "reicon-react";
import { useApp } from "../stores/app";
import { useText } from "../lib/useText";
import { LOCALE_MODES, LOCALE_NAMES, LOCALE_SHORT, type LocaleMode } from "../lib/locale";

/**
 * 界面语言切换（跟随系统 / 简体中文 / English）：三档分段控件，挂在左栏底部「设置」行、
 * 皮肤切换（`ThemeToggle`）**左侧**——两个展示层偏好挨着，设置页不再重复放一份。
 *
 * - 与 `ThemeToggle` 同款结构与视觉（`radiogroup` + 逐项 `aria-checked` + 左右方向键组内循环、
 *   同一套 `bg-active` 选中底），档位按钮统一为 24 × 26px，保证中英文下底栏不挤压。
 * - 「跟随系统」档与皮肤同款用 `Monitor` 图标（语义都是"听系统的"），两个语言档显简称
 *   （`中` / `EN`）——窄处放不下全称，全称进 `title` / `aria-label`；容器 `title` 是
 *   「只改本应用展示、不写 omp 配置」那句口径说明（设置页移走语言区后仅存的位置）。
 * - `system` 档的实际语言由 `resolveLocale` 解析（`zh*` → 中文，其余 → 英文），系统语言
 *   变化由 `App` 的 `useLocale` 接管；这里只写偏好（localStorage `omp.locale.v1`）。
 */
export function LanguageToggle() {
  const localeMode = useApp((s) => s.localeMode);
  const setLocaleMode = useApp((s) => s.setLocaleMode);
  const t = useText();

  // 单选组的方向键：左/右在当前组内循环切换（焦点不动，选中态跟着走）
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    const next = LOCALE_MODES[(LOCALE_MODES.indexOf(localeMode) + dir + LOCALE_MODES.length) % LOCALE_MODES.length];
    setLocaleMode(next);
  };

  /** 档位全称：「跟随系统」走字典，两个具体语言是**自称**（不随界面语言翻译，见 locale.ts）。 */
  const labelOf = (mode: LocaleMode) => (mode === "system" ? t.localeSystem : LOCALE_NAMES[mode]);

  return (
    <div
      role="radiogroup"
      aria-label={t.languageSection}
      title={t.languageHint}
      onKeyDown={onKeyDown}
      className="flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-surface/60 p-0.5"
    >
      {LOCALE_MODES.map((mode) => {
        const selected = localeMode === mode;
        const label = labelOf(mode);
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            onClick={() => setLocaleMode(mode)}
            className={`flex h-[26px] w-6 cursor-pointer items-center justify-center rounded-sm text-[11px] font-medium leading-none transition-colors duration-100 ${
              selected
                ? "bg-active text-accent"
                : "text-muted hover:bg-hover hover:text-foreground"
            }`}
          >
            {mode === "system" ? <Monitor size={14} aria-hidden /> : LOCALE_SHORT[mode]}
          </button>
        );
      })}
    </div>
  );
}
