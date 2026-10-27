/**
 * 皮肤（本应用展示层偏好，不写 omp 配置、不写覆盖层）三档：跟随系统 / 深色 / 浅色。
 *
 * 落地方式是 `<html>` 上的一个 `dark` class——浅色 token 是 `:root` 默认值、
 * 深色 token 全挂在 `.dark` 下（`src/index.css`），切换皮肤就是切换这一个 class。
 * 与 `locale` 同模式：localStorage 持久化，坏值回退「跟随系统」。
 *
 * 首屏防闪烁另有一段 `index.html` 里的内联脚本（样式生效前先定好 class）——
 * 键名与本文件必须一致，改键名要两处一起改。
 */
export const THEMES = ["system", "dark", "light"] as const;
export type ThemeMode = (typeof THEMES)[number];
/** 消解后的实际皮肤（`system` 已按系统偏好展开）。 */
export type ResolvedTheme = "dark" | "light";

const KEY = "omp.theme.v1";

/** 坏值一律回退「跟随系统」：未知字符串不是一种皮肤，静默忽略而不是报错。 */
export function normalizeTheme(raw: unknown): ThemeMode {
  return raw === "dark" || raw === "light" ? raw : "system";
}

export function loadTheme(): ThemeMode {
  try {
    if (typeof localStorage === "undefined") return "system";
    return normalizeTheme(localStorage.getItem(KEY));
  } catch {
    return "system"; // 无痕模式等取不到持久化时跟随系统
  }
}

export function saveTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(KEY, normalizeTheme(mode));
  } catch {
    // 写失败不阻断本次切换（与 setSidebarWidth 同口径）
  }
}

/**
 * 把三档模式消解成实际皮肤：`system` 跟随系统偏好，深/浅是显式覆盖。
 * 纯函数（`prefersDark` 由调用方给），三条分支可单测。
 */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === "dark") return "dark";
  if (mode === "light") return "light";
  return prefersDark ? "dark" : "light";
}

/** 系统偏好（取不到媒体查询时按浅色走，不让皮肤卡住启动）。 */
export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

/** 把皮肤写到 `<html>`：幂等，可重复调用（初始化、切档、系统偏好变化各一次）。 */
export function applyTheme(mode: ThemeMode): void {
  try {
    document.documentElement.classList.toggle(
      "dark",
      resolveTheme(mode, systemPrefersDark()) === "dark",
    );
  } catch {
    // 非 DOM 环境（单测）忽略
  }
}
