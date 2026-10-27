import { useApp } from "../stores/app";
import { TEXT, type Text } from "./locale";

/**
 * 当前界面语言的字典（组件内取文案的唯一入口）。
 *
 * 单独成文件是为了避免 `locale.ts` ↔ `stores/app` 的循环依赖：
 * store 需要 locale.ts 的 load/save，而字典本身保持纯数据。
 */
export function useText(): Text {
 return TEXT[useApp((s) => s.locale)];
}
