import { iconDataUrl, iconIdFor } from "../../lib/fileIcons";

/**
 * 文件 / 目录的类型图标（Material Icon Theme 口径，见 `lib/fileIcons.ts`）。
 *
 * 用在右栏文件树与搜索行：`name` 是文件名（不是路径），`expanded` 只对目录有意义。
 * 渲染成 `<img>`（SVG 自带配色，不参与 `currentColor`），`alt=""` + `aria-hidden`——
 * 名字就在旁边，读屏不必重复念一遍图标。
 */
export function FileIcon({
 name,
 isDir,
 expanded = false,
 size = 14,
 className = "",
}: {
 name: string;
 isDir: boolean;
 expanded?: boolean;
 size?: number;
 className?: string;
}) {
 return (
  <img
   src={iconDataUrl(iconIdFor(name, isDir, expanded))}
   alt=""
   aria-hidden
   width={size}
   height={size}
   draggable={false}
   className={`shrink-0 select-none ${className}`}
  />
 );
}
