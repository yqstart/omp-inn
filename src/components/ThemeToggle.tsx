import type { KeyboardEvent } from "react";
import { Monitor, Moon, Sun } from "reicon-react";
import { useApp } from "../stores/app";
import { useText } from "../lib/useText";
import { THEMES, type ThemeMode } from "../lib/theme";

/**
 * 皮肤切换（跟随系统 / 深色 / 浅色）：三档分段控件，挂在左栏底部「设置」行右侧。
 *
 * - 档位顺序与 `THEMES` 一致，选中态走全局同一套 `bg-active` 底（MASTER §2），
 *   未选中项 hover 用全局唯一悬浮色 `hover`；当前档同时由底色与图标色表达（颜色不作唯一信号）。
 * - 只管本应用展示层（`<html class="dark">`，见 src/lib/theme.ts），不写 omp 配置。
 */
const ITEMS: { mode: ThemeMode; Icon: typeof Sun }[] = [
  { mode: "system", Icon: Monitor },
  { mode: "dark", Icon: Moon },
  { mode: "light", Icon: Sun },
];

export function ThemeToggle() {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const t = useText();
  const label: Record<ThemeMode, string> = {
    system: t.themeSystem,
    dark: t.themeDark,
    light: t.themeLight,
  };

  // 单选组的方向键：左/右在当前组内循环切换（焦点不动，选中态跟着走）
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    const next = THEMES[(THEMES.indexOf(theme) + dir + THEMES.length) % THEMES.length];
    setTheme(next);
  };

  return (
    <div
      role="radiogroup"
      aria-label={t.themeSection}
      onKeyDown={onKeyDown}
      className="flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-surface/60 p-0.5"
    >
      {ITEMS.map(({ mode, Icon }) => {
        const selected = theme === mode;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label[mode]}
            title={label[mode]}
            onClick={() => setTheme(mode)}
            className={`flex h-[26px] w-6 cursor-pointer items-center justify-center rounded-sm transition-colors duration-100 ${
              selected
                ? "bg-active text-accent"
                : "text-muted hover:bg-hover hover:text-foreground"
            }`}
          >
            <Icon size={14} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
