import { FileIcon } from "../../workbench/FileIcon";

/**
 * `@引用` 芯片的视觉本体（Lexical decorator 的 React 面）——形态照 DeepSeek Harness 的
 * `ReferenceChip`：**类型图标 + 短标签**，蓝色、无边框、与正文同一基线；hover 给一层淡底。
 *
 * 它是纯展示：身份、失效状态、生命周期都在 `ReferenceChipNode` 上；完整相对路径挂在 `title`。
 */
export function ReferenceChip({ label, isDir }: { label: string; isDir: boolean }) {
 return (
  <span
   data-mention-chip=""
   title={isDir ? `${label}/` : label}
   className="mx-px inline-flex max-w-[24rem] cursor-default items-center gap-1 rounded-sm px-1 align-baseline text-accent transition-colors duration-100 hover:bg-accent/10"
  >
   <FileIcon name={label} isDir={isDir} size={13} />
   <span className="truncate">{`@${isDir ? `${label}/` : label}`}</span>
  </span>
 );
}
