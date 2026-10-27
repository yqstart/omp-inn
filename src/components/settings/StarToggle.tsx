import { Star } from "reicon-react";
import { fmt } from "../../lib/locale";
import { useText } from "../../lib/useText";

/**
 * 挑选星标：可用模型目录、供应商的挑选面板与「我的模型」列表共用一份
 * （`on` = 已在我的模型里；再点一次即移出）。设置页内不许各写一份。
 */
export function StarToggle({ on, name, onClick }: { on: boolean; name: string; onClick: () => void }) {
 const t = useText();
 return (
  <button
   onClick={onClick}
   aria-pressed={on}
   aria-label={fmt(on ? t.myModelsRemoveAria : t.myModelsAddAria, name)}
   className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors duration-100 hover:bg-hover"
  >
   <Star size={13} weight={on ? "Filled" : "Outline"} aria-hidden className={on ? "text-accent" : "text-muted"} />
  </button>
 );
}
