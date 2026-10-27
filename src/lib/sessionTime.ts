import { fmt } from "./locale";

/**
 * 会话行的时间展示（2026-10-13）：行内 = 紧凑相对时间，悬停 = 完整绝对时间。
 *
 * 取证：
 * - **ZCode**（`zai-org/ZCode` 桌面端 `packages/ui/src/lib/taskListItemPresentation.ts` 直读）：
 *   任务 / 会话列表行 = `now / {n}m / {n}h / {n}d`（中文「刚刚 / {n}分 / {n}小时 / {n}天」）——
 *   恒定 ≤3 字符，行尾永不截断；
 * - **Codex app**（本机 ChatGPT.app asar 直读）：列表行同样是恒定短格式（<24h 给时刻、
 *   ≥24h 给「月 日」），完整信息不进行内。
 *
 * 本壳侧栏更窄（292px），取两家的共同口径 = **行内恒定短格式 + 悬停给全量**。
 * 此前行内是「固定 68px + `truncate`」的 `10/13 09:12`——11 个半角字符 ≈73px，中文 / 英文界面
 * 都会截成「10/13 09:…」（用户实测），格式本身不变，只是不再塞进行内。
 */
export type SessionTimeBucket =
 | { unit: "now" }
 | { unit: "minutes"; n: number }
 | { unit: "hours"; n: number }
 | { unit: "days"; n: number };

/** 时间档（与 ZCode 的档位逐档一致）：<1 分钟 = now；<60 分钟 = minutes；<24 小时 = hours；其余 = days。 */
export function sessionTimeBucket(ts: number, now: number): SessionTimeBucket {
 const minutes = Math.floor((now - ts) / 60_000);
 if (minutes < 1) return { unit: "now" };
 if (minutes < 60) return { unit: "minutes", n: minutes };
 const hours = Math.floor(minutes / 60);
 if (hours < 24) return { unit: "hours", n: hours };
 return { unit: "days", n: Math.floor(hours / 24) };
}

/** 行内时间需要的四个字典键（`TEXT[locale]` 的子集形状；组件把 `useText()` 的 t 直接传进来）。 */
export type SessionTimeText = {
 sessTimeNow: string;
 sessTimeMinutes: string;
 sessTimeHours: string;
 sessTimeDays: string;
};

/** 行内时间文案（ZCode 口径）：刚刚 / 5分 / 3小时 / 2天（en: now / 5m / 3h / 2d）。 */
export function formatSessionTime(ts: number, t: SessionTimeText, now = Date.now()): string {
 const bucket = sessionTimeBucket(ts, now);
 switch (bucket.unit) {
  case "now":
   return t.sessTimeNow;
  case "minutes":
   return fmt(t.sessTimeMinutes, bucket.n);
  case "hours":
   return fmt(t.sessTimeHours, bucket.n);
  case "days":
   return fmt(t.sessTimeDays, bucket.n);
 }
}

/** 悬停 title 的完整时间：`2026年10月13日 09:12` / `Oct 13, 2026, 9:12 AM`（Intl 语义化短日期 + 时刻）。 */
export function formatSessionFullTime(ts: number, locale: string): string {
 return new Date(ts).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}
