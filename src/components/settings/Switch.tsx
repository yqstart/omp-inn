/**
 * 开关（`role="switch"`）：颜色之外还有 `aria-checked`（颜色不作唯一信号）。
 * 设置页内共享（「omp 常用设置」的行内开关与「自定义模型」表单里的模型开关），
 * 提交浮层的「记住选择」也用它——**不许再造第二种开关**。
 */
export function Switch({
 on,
 disabled,
 label,
 onToggle,
}: {
 on: boolean;
 disabled: boolean;
 label: string;
 onToggle: () => void;
}) {
 return (
  <button
   role="switch"
   aria-checked={on}
   aria-label={label}
   disabled={disabled}
   onClick={onToggle}
   className={`relative h-[22px] w-10 shrink-0 cursor-pointer rounded-full transition-colors duration-100 disabled:opacity-40 ${on ? "bg-accent" : "bg-border"
    }`}
  >
   <span
    className={`absolute top-[3px] left-0 h-4 w-4 rounded-full bg-surface transition-transform duration-100 ${on ? "translate-x-[21px]" : "translate-x-[3px]"}`}
   />
  </button>
 );
}
