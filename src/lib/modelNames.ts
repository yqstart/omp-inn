import type { ModelInfo } from "@shared/types";

/** 模型短名：去掉厂商前缀与版本尾巴，列表里省地方（显示名，不影响 selector）。 */
export function shortModelName(m: ModelInfo): string {
  return m.name.replace(/^Claude\s+/i, "").replace(/\s+\d\.\d+$/, "");
}

/** 上下文窗口的紧凑写法（1000000 → `1M`、200000 → `200K`）；无值时给空串。 */
export function fmtContextWindow(n: number | null): string {
  if (!n) return "";
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  return `${Math.round(n / 1000)}K`;
}
