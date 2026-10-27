import { useState } from "react";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useApp } from "../stores/app";
import { fmt } from "./locale";
import { joinPath } from "./paths";
import { useText } from "./useText";

/**
 * 路径点击：ToolCard 参数摘要 / @ 芯片里的本地路径可点。
 * - 文件/目录存在 → 系统默认应用打开（目录则在 Finder 中显示）；
 * - 不存在 → 内联提示，不弹错；
 * - 外链（http/https）→ 二次确认后用系统浏览器打开。
 */

export function useOpenPath(cwd: string) {
 const t = useText();
 const [notice, setNotice] = useState<string | null>(null);
 const open = async (raw: string) => {
  const p = raw.trim();
  if (!p) return;
  if (/^https?:\/\//i.test(p)) {
   setNotice(fmt(t.openInBrowserNotice, p));
   return;
  }
  // 相对路径按会话 cwd 解析；Windows 盘符 / UNC 本身就是绝对路径
  const full = joinPath(cwd, p);
  try {
   await openPath(full);
   setNotice(null);
  } catch {
   try {
    await revealItemInDir(full);
    setNotice(null);
   } catch {
    setNotice(fmt(t.pathOpenFailed, p));
   }
  }
 };
 const confirmOpenUrl = async (url: string) => {
  try {
   await openUrl(url);
  } catch {
   // 打开失败不打扰
  } finally {
   setNotice(null);
  }
 };
 return { notice, setNotice, open, confirmOpenUrl };
}

/**
 * 在访达 / 文件管理器里显示一个路径（右栏文件树的行尾动作）。
 * 失败静默：调用点是助手动作，不该为「显示不出来」弹错。
 */
export async function revealPath(path: string): Promise<void> {
 try {
  await revealItemInDir(path);
 } catch {
  // 忽略：路径已不存在等情况
 }
}

export function hydrateDrafts() {
 try {
  const raw = localStorage.getItem("omp.drafts.v1");
  if (!raw) return;
  const all = JSON.parse(raw) as Record<string, string>;
  const cur = useApp.getState().drafts;
  useApp.setState({ drafts: { ...all, ...cur } });
 } catch {
  // 解析失败就丢弃旧草稿
 }
}
