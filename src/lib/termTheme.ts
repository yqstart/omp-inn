import type { ITheme } from "@xterm/xterm";

/**
 * 终端配色（V42 右栏终端）：xterm 的 `theme` 只吃具体颜色、不吃 CSS 变量，
 * 所以把 `index.css` 里 `--term-*` 的当前值读出来喂给它——
 * 两套皮肤共用同一份 token 的规矩不破（组件与数据层都不写死色值）。
 */

/** hex → rgba；解析不了就原样返回（合法 CSS 颜色字符串 xterm 也能用）。 */
export function withAlpha(color: string, alpha: number): string {
 const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
 if (!m) return color;
 const n = parseInt(m[1], 16);
 return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** 读取当前生效的终端配色（浅 / 深由 `<html class="dark">` 决定，调用时点取现值）。 */
export function readTermTheme(): ITheme {
 const cs = getComputedStyle(document.documentElement);
 const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
 const background = v("--term-background", "#171717");
 return {
  background,
  foreground: v("--term-foreground", "#e9ecee"),
  cursor: v("--term-cursor", "#818cf8"),
  cursorAccent: background,
  // 选区 = accent 稀释 30%：与全局 `::selection`（28%）同源，刻意留一点差异以便终端里更显眼
  selectionBackground: withAlpha(v("--accent", "#818cf8"), 0.3),
  black: v("--term-black", "#333333"),
  red: v("--term-red", "#f87171"),
  green: v("--term-green", "#34d399"),
  yellow: v("--term-yellow", "#fbbf24"),
  blue: v("--term-blue", "#818cf8"),
  magenta: v("--term-magenta", "#c084fc"),
  cyan: v("--term-cyan", "#22d3ee"),
  white: v("--term-white", "#b8b8b8"),
  brightBlack: v("--term-bright-black", "#9e9e9e"),
  brightRed: v("--term-bright-red", "#fca5a5"),
  brightGreen: v("--term-bright-green", "#6ee7b7"),
  brightYellow: v("--term-bright-yellow", "#fcd34d"),
  brightBlue: v("--term-bright-blue", "#a5b4fc"),
  brightMagenta: v("--term-bright-magenta", "#d8b4fe"),
  brightCyan: v("--term-bright-cyan", "#67e8f9"),
  brightWhite: v("--term-bright-white", "#e8e8e8"),
 };
}
