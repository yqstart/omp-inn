/**
 * 文件 / 目录 → Material Icon（Material Icon Theme 的 `material-icon-theme`，生成产物见
 * `materialIcons.generated.ts`）。
 *
 * 规则与上游一致，逐级回退：
 * 1. 完整文件名（`package.json`、`dockerfile`、`.gitignore`）；
 * 2. 多段扩展名（`x.d.ts` → `d.ts`，再退 `ts`）；
 * 3. 单段扩展名（`ts`）；
 * 4. 认不出 → 默认 `file` / `folder`（展开态 `folder-open`）。
 *
 * 纯函数（不碰 DOM），便于单测；`iconDataUrl` 带模块级缓存——SVG 文本 1KB 上下，
 * 树里上百行每帧重编码是白花开销。
 */
import {
 DEFAULT_FILE_ICON,
 DEFAULT_FOLDER_ICON,
 DEFAULT_FOLDER_OPEN_ICON,
 ICON_BY_EXT,
 ICON_BY_FOLDER,
 ICON_BY_FOLDER_OPEN,
 ICON_BY_NAME,
 MATERIAL_ICON_SVG,
} from "./materialIcons.generated";

/** 图标 id（一定存在于生成表里：回退链的终点是默认图标）。 */
export function iconIdFor(name: string, isDir: boolean, expanded = false): string {
 if (isDir) {
  const key = name.toLowerCase();
  const map = expanded ? ICON_BY_FOLDER_OPEN : ICON_BY_FOLDER;
  const hit = map[key] ?? map[name];
  if (hit) return hit;
  return expanded ? DEFAULT_FOLDER_OPEN_ICON : DEFAULT_FOLDER_ICON;
 }
 const byName = ICON_BY_NAME[name] ?? ICON_BY_NAME[name.toLowerCase()];
 if (byName) return byName;
 const lower = name.toLowerCase();
 // 前导点开头的隐藏文件没有扩展名（`.gitignore` 的 `.` 不算分隔符），交给上面的文件名表
 const firstDot = lower.indexOf(".");
 if (firstDot > 0) {
  const parts = lower.slice(firstDot + 1).split(".");
  for (let i = 0; i < parts.length; i += 1) {
   const hit = ICON_BY_EXT[parts.slice(i).join(".")];
   if (hit) return hit;
  }
 }
 return DEFAULT_FILE_ICON;
}

const URL_CACHE = new Map<string, string>();

/** 图标 id → `data:` URL（`<img>` 直接用；查不到回退默认文件图标）。 */
export function iconDataUrl(id: string): string {
 const cached = URL_CACHE.get(id);
 if (cached !== undefined) return cached;
 const svg = MATERIAL_ICON_SVG[id] ?? MATERIAL_ICON_SVG[DEFAULT_FILE_ICON] ?? "";
 const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
 URL_CACHE.set(id, url);
 return url;
}
