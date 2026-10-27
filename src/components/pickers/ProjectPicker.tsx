import { useCallback, useState } from "react";
import { Check, ChevronDown } from "reicon-react";
import { useApp } from "../../stores/app";
import { fmt } from "../../lib/locale";
import { useDropdown } from "../../lib/useDropdown";
import { startChatInProject } from "../../lib/projects";
import { useText } from "../../lib/useText";
import { wslDistroOf } from "../../lib/wsl";
import type { ProjectView } from "@shared/types";

/**
 * 输入卡内顶行的项目选择器（截图左侧那个）：显示这条消息落到哪个项目。
 * 点开列全部项目，选中即**在该项目下新建一个对话**并切过去（`switchProject` 的
 * `newSession`）——切项目是「换到那个项目干活」，不该把上一个对话的上下文带进来。
 * 切换后输入框上方显示的项目，一定就是消息发去的项目。
 *
 * 当前会话不属于任何项目时显示「未归属」（目录被解绑过），此时仍可切到某个项目；
 * 点当前项目只收起下拉、不重复新建（同一项目下再开新对话走左栏分组里的入口）。
 */
export function ProjectPicker({ project }: { project: ProjectView | null }) {
 const { projects, activeSessionId, composerMenu } = useApp();
 const t = useText();
 const [error, setError] = useState<string | null>(null);
 const open = composerMenu === "project";
 const setOpen = useCallback(
  (v: boolean) => useApp.setState({ composerMenu: v ? "project" : null }),
  [],
 );
 const ref = useDropdown(open, () => setOpen(false));
 const label = project?.name ?? (activeSessionId ? t.unassigned : t.selectProject);
 // WSL 项目：入口处就把边界说清楚（终端能进发行版，聊天会话不跨发行版启动 omp）
 const wsl = wslDistroOf(project?.path);

 return (
  <div className="relative" ref={ref}>
   <button
    onClick={() => {
     setError(null);
     setOpen(!open);
    }}
    className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 py-1 whitespace-nowrap text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
    aria-label={fmt(t.projectAria, label)}
    aria-expanded={open}
    title={project?.path ?? t.notInProject}
   >
    <span className="whitespace-nowrap">{label}</span>
    {wsl && (
     <span
      className="shrink-0 rounded bg-active px-1 py-px text-[10px] text-muted"
      title={fmt(t.wslProjectHint, wsl)}
     >
      {t.wslBadge}
     </span>
    )}
    <ChevronDown size={14} aria-hidden className="shrink-0 opacity-60" />
   </button>
   {error && (
    <span role="alert" className="ml-1 max-w-72 truncate align-middle text-[12px] text-danger" title={error}>
     {error}
    </span>
   )}
   {open && (
    <div className="absolute bottom-full left-0 z-10 mb-1 max-h-72 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-border bg-elevated p-1 shadow-pop">
     {projects.map((p) => {
      const current = p.id === project?.id;
      return (
       <button
        key={p.id}
        onClick={() => {
         setOpen(false);
         setError(null);
         // 已在该项目里：只收下拉，不再新建（避免每次点都造一个空会话）
         if (current) return;
         void startChatInProject(p.id, { projectName: p.name }).then((res) => {
          if (!res.ok) {
           setError(res.message);
          }
         });
        }}
        disabled={p.missing}
        className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-100 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40 ${current ? "text-foreground" : "text-muted"
         }`}
        aria-label={fmt(t.switchToProjectAria, p.name)}
       >
        <Check size={13} aria-hidden className={`shrink-0 ${current ? "opacity-100" : "opacity-0"}`} />
        <span className="min-w-0 flex-1 truncate">{p.name}</span>
        {p.missing ? (
         <span className="shrink-0 rounded bg-warn/15 px-1 py-px text-[11px] text-warn">{t.missingFolder}</span>
        ) : (
         <span className="max-w-28 shrink-0 truncate font-mono text-[11px] text-faint">{p.path}</span>
        )}
       </button>
      );
     })}
     {projects.length === 0 && (
      <div className="px-2 py-1.5 text-[13px] text-muted">{t.noProjectsSidebar}</div>
     )}
    </div>
   )}
  </div>
 );
}
