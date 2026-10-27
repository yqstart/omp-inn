import { Settings } from "reicon-react";
import { useApp } from "../../stores/app";
import { useText } from "../../lib/useText";
import { LanguageToggle } from "../LanguageToggle";
import { ThemeToggle } from "../ThemeToggle";

/**
 * 左栏底栏：设置入口 + 语言 + 皮肤。
 *
 * 「设置」是覆盖主区的视图：打开即切过去；已经开着时再点一次 = 返回聊天
 * （`closeSettingsTab`；页内「返回聊天」与 ⌘W 是同一动作的另外两个入口）。
 */
export function SidebarBottom() {
 const t = useText();
 return (
  <div className="flex shrink-0 items-center gap-1.5 border-t border-border px-3 py-3">
   <button
    onClick={() => {
     const st = useApp.getState();
     // 再点一次「设置」= 返回聊天
     if (st.settingsTabActive) st.closeSettingsTab();
     else st.openSettingsTab();
     st.set({ sidebarOpen: false });
    }}
    className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[13px] text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
    aria-label={t.settingsOpenAria}
    title={t.settingsOpenAria}
   >
    <Settings size={15} aria-hidden className="shrink-0" />
    <span className="whitespace-nowrap">{t.settingsOpenAria}</span>
   </button>
   <LanguageToggle />
   <ThemeToggle />
  </div>
 );
}
