import { useState } from "react";
import { Folder } from "reicon-react";
import { pickAndAddProject } from "../../lib/projects";
import { useText } from "../../lib/useText";
import type { Text } from "../../lib/locale";
// 空态用**应用自己的图标**（π 字标）：直接引矢量源，不复制第二份——
// `design-system/icon/omp-inn-icon.svg` 是唯一真相，`pnpm icon` 由它生成各平台图标。
import appIcon from "../../../design-system/icon/omp-inn-icon.svg";

/**
 * 聊天形态的空态（V32）。
 *
 * - `no-project`：一个项目都没有——与左栏主入口同一份逻辑（`pickAndAddProject`），空态即入口；
 * - `no-session + hasSession`：会话已建好但还没有消息——提示去输入框发第一条；
 * - `no-session + !hasSession`：聊天视图没有打开任何会话——提示去左栏的会话侧栏（`ChatSidebar`）
 *   选一个会话，或在项目分组头上点 ＋ 新建。
 */
export function ChatEmptyState({
 kind,
 hasSession = false,
}: {
 kind: "no-project" | "no-session";
 hasSession?: boolean;
}) {
 const t = useText();
 const [error, setError] = useState<string | null>(null);
 if (kind === "no-project") {
  return (
   <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
    <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-surface text-muted" aria-hidden>
     <Folder size={20} />
    </div>
    <h1 className="text-base font-semibold tracking-tight">{t.emptyNoProjectTitle}</h1>
    <p className="max-w-xs text-[13px] leading-6 text-muted">{t.emptyNoProjectBody}</p>
    {/* 与左栏主入口同一份逻辑（pickAndAddProject），空态即入口，不用回头找按钮。 */}
    <button
     onClick={async () => {
      const res = await pickAndAddProject();
      setError(res && !res.ok ? res.message : null);
     }}
     className="mt-1 cursor-pointer rounded-md bg-primary px-4 py-1.5 text-[13px] font-medium text-primary-foreground transition-opacity duration-100 hover:opacity-90"
    >
     {t.emptyPickFolder}
    </button>
    {error && (
     <p role="alert" className="text-[13px] text-danger">
      {error}
     </p>
    )}
   </div>
  );
 }
 return (
  <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
   {/* 应用图标（π 字标）自带石墨底与圆角，不再包图标盒 */}
   <img src={appIcon} alt="" aria-hidden className="h-11 w-11 rounded-lg" />
   {/* 问候语（v2 §4：按时间变化，对齐 ZCode 的问候式空态） */}
   <h1 className="text-xl font-semibold tracking-tight">{greetingOf(t)}</h1>
   <p className="max-w-xs text-[13px] leading-6 text-muted">
    {hasSession ? t.chatEmptyReadyBody : t.chatEmptyStart}
   </p>
   <p className="max-w-xs font-mono text-xs leading-6 text-faint">{t.emptyShortcuts}</p>
  </div>
 );
}

/**
 * 空态问候语（v2 §4）：按本地时刻取「早上好 / 中午好 / 下午好 / 晚上好」。
 * 取整点边界；文案走字典，随界面语言切换。（只在空态渲染用，不做导出。）
 */
function greetingOf(t: Text, now: Date = new Date()): string {
 const h = now.getHours();
 if (h >= 5 && h < 11) return t.greetMorning;
 if (h >= 11 && h < 13) return t.greetNoon;
 if (h >= 13 && h < 18) return t.greetAfternoon;
 return t.greetEvening;
}
