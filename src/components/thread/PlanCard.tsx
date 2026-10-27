import { useEffect, useLayoutEffect, useRef } from "react";
import { CheckListSquare, ChevronDown } from "reicon-react";
import { useApp } from "../../stores/app";
import { useText } from "../../lib/useText";
import { TODO_DISPLAY, TODO_PENDING, countTodos, todoStatsText } from "../../lib/todoDisplay";

/**
 * 任务清单浮卡（v3，DeepSeek Harness 形态）：**贴消息列底部、浮在输入卡上方的宽卡**。
 *
 * - 数据 = `plansBySession`（todo 工具帧 `details.phases` 实时写入 + `get_state.todoPhases`
 *   回读）；开合 = `planCardBySession`（**无记录 = 收起**；首次出现默认收起，见 store 的 `applyPlans`）；
 * - **两态都是同一张卡**：折叠 = 只留头部行（图标 + 标题 + 统计 + 折叠箭头），展开 = 头部行 +
 *   清单区（超过 `max-h` 内滚）。头部行整行可点 = 开合开关；
 * - 宽度与左缘对齐消息列正文列（`--measure-content`，同一变量、同一基准），**水平居中**——
 *   卡片是浮层（`pointer-events-none` 外壳 + 卡片自身 `auto`），不参与消息流布局；
 * - 高度经 `onHeightChange` 回报 `Thread`：消息流底部按卡片高度留出等高空白（末尾内容不被
 *   浮卡永久盖住），「回到底部」按钮同步上移让位；
 * - 全部完成自动折成头部行（只在 `allDone` 翻转那一下折——用户手动再展开不再打扰）；
 * - 清单清空（回读发现 `[]` / `todo_auto_clear` 帧）即退场。
 */
export function PlanCard({ onHeightChange }: { onHeightChange?: (height: number) => void }) {
 const t = useText();
 const sid = useApp((s) => s.activeSessionId);
 const phases = useApp((s) => (sid ? s.plansBySession[sid] : undefined));
 const card = useApp((s) => (sid ? s.planCardBySession[sid] : undefined));
 const setPlanCard = useApp((s) => s.setPlanCard);
 const host = useRef<HTMLDivElement>(null);

 const counts = countTodos(phases ?? []);
 const allDone = counts.total > 0 && counts.done === counts.total;
 const visible = !!sid && !!phases && phases.length > 0;
 const expanded = card === "expanded";

 // 全部完成 → 收成头部行：**只在 `allDone` 翻转的那一下折**（deps 只有 allDone）——
 // 用户随后手动再展开不被打扰；开合态从 store 读实时值（多实例 / 重挂载时
 // 不会因为本地 ref 没记录过折叠事件而把用户的展开动作再折回去）。
 useEffect(() => {
  if (!allDone) return;
  const st = useApp.getState();
  if (st.activeSessionId && st.planCardBySession[st.activeSessionId] === "expanded") {
   st.setPlanCard(st.activeSessionId, "collapsed");
  }
 }, [allDone]);

 // 高度上报（退场 / 收起 / 清单增减都算）：`ResizeObserver` 盯卡片自身，视口缩放导致的换行
 // 也在内；jsdom（单测）没有 ResizeObserver，按项目惯例留一次同步上报即可。
 useLayoutEffect(() => {
  const el = host.current;
  if (!el) {
   onHeightChange?.(0);
   return;
  }
  const report = () => onHeightChange?.(el.offsetHeight);
  report();
  if (typeof ResizeObserver === "undefined") return;
  const ro = new ResizeObserver(report);
  ro.observe(el);
  return () => ro.disconnect();
 }, [onHeightChange, visible, expanded]);

 if (!visible || !sid || !phases) return null;

 const tone = allDone ? "text-ok" : "text-accent";
 const stats = todoStatsText(counts, t);
 return (
  // 外壳只负责定位与居中；`pointer-events-none` 让卡外的底部区域照常和消息流交互
  <div ref={host} className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
   <div className="pointer-events-auto w-(--measure-content) overflow-hidden rounded-xl border border-border bg-elevated shadow-pop">
    <button
     type="button"
     onClick={() => setPlanCard(sid, expanded ? "collapsed" : "expanded")}
     aria-expanded={expanded}
     title={expanded ? t.planCollapse : t.planExpand}
     className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors duration-100 hover:bg-hover"
    >
     <CheckListSquare size={13} aria-hidden className={`shrink-0 ${tone}`} />
     <span className="shrink-0 text-[12px] font-medium text-foreground" title={t.planTitle}>
      {t.planTitle}
     </span>
     <span className="truncate text-[11px] text-faint">{stats}</span>
     <ChevronDown
      size={13}
      aria-hidden
      className={`ml-auto shrink-0 text-faint transition-transform duration-150 ${expanded ? "" : "-rotate-90"}`}
     />
    </button>
    {expanded && (
     <div className="max-h-[min(38vh,18rem)] space-y-2 overflow-y-auto border-t border-border-soft px-3 py-2">
      {phases.map((p, pi) => (
       <div key={pi}>
        {p.name && <div className="mb-0.5 text-[11px] font-medium text-muted">{p.name}</div>}
        <ul className="space-y-0.5">
         {p.tasks.map((task, ti) => {
          const d = TODO_DISPLAY[task.status] ?? TODO_PENDING;
          return (
           <li key={ti} className="flex items-start gap-2 text-[12px] leading-5">
            <span aria-hidden className={`w-3 shrink-0 text-center ${d.tone}`}>
             {d.symbol}
            </span>
            <span className={`min-w-0 ${task.status === "in_progress" ? "text-foreground" : "text-muted"}`}>
             {task.content}
             <span className="sr-only">{t[d.label]}</span>
             {task.blocker && <span className="block text-[11px] text-faint">{task.blocker}</span>}
            </span>
           </li>
          );
         })}
        </ul>
       </div>
      ))}
     </div>
    )}
   </div>
  </div>
 );
}
