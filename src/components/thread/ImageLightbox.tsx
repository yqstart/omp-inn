import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Copy, Download, Loader, X } from "reicon-react";
import { api } from "@shared/api";
import { isRemoteClient } from "@shared/remote";
import { extFromMime } from "../../lib/attachments";
import { fmt } from "../../lib/locale";
import { useText } from "../../lib/useText";
import type { ImagePreview } from "./MessageImage";

/**
 * 图片预览浮层（2026-10-22）：点消息气泡 / 历史回放里的图片打开——
 * 大图 + 「复制图片」「保存图片」两个动作。
 *
 * 动作口径：
 * - 复制走后端（`copy_image`）解码后写系统剪贴板：WebView 的 ClipboardItem 在
 *   WKWebView / 远程 PWA 上支持不一致，后端 arboard 是唯一跨平台可靠路径；
 * - 保存走系统「另存为」对话框 + 后端写字节（`save_image_file`），不经过浏览器下载；
 * - 手机端（远程 PWA）没有这两条白名单 RPC，只保留预览与关闭，工具栏给一句说明。
 *
 * Esc / 点背景关闭；浮层比设置弹窗（z-30）高一层，避免从其他浮层里打开时被压住。
 */
export function ImageLightbox({ preview, onClose }: { preview: ImagePreview | null; onClose: () => void }) {
 const t = useText();
 const [busy, setBusy] = useState<"copy" | "save" | null>(null);
 const [notice, setNotice] = useState<string | null>(null);
 const remote = isRemoteClient();

 useEffect(() => {
  if (!preview) return;
  const onKey = (e: KeyboardEvent) => {
   if (e.key === "Escape") onClose();
  };
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
 }, [preview, onClose]);

 // 结果提示 2.6s 自动消失；卸载 / 切换图片时清掉计时器
 useEffect(() => {
  if (!notice) return;
  const id = window.setTimeout(() => setNotice(null), 2600);
  return () => window.clearTimeout(id);
 }, [notice]);

 if (!preview) return null;

 const copy = async () => {
  setBusy("copy");
  setNotice(null);
  try {
   await api.copyImage(preview.base64);
   setNotice(t.imageCopied);
  } catch (e: unknown) {
   setNotice(fmt(t.imageCopyFailed, e instanceof Error ? e.message : String(e)));
  } finally {
   setBusy(null);
  }
 };

 const saveAs = async () => {
  setBusy("save");
  setNotice(null);
  try {
   const ext = extFromMime(preview.mimeType);
   // 手机 PWA 不渲染这个按钮（远程模式只保留预览），这里的 import 不会在那边被调用
   const path = await save({
    defaultPath: preview.name,
    filters: [{ name: "Image", extensions: [ext] }],
   });
   if (!path) return;
   await api.saveImageFile(path, preview.base64);
   setNotice(t.imageSaved);
  } catch (e: unknown) {
   setNotice(fmt(t.imageSaveFailed, e instanceof Error ? e.message : String(e)));
  } finally {
   setBusy(null);
  }
 };

 const action =
  "inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-white/10 px-2.5 py-1 text-xs text-white/90 transition-colors enabled:cursor-pointer enabled:hover:bg-white/20 disabled:opacity-50";
 return (
  <div
   role="dialog"
   aria-modal="true"
   aria-label={t.imagePreview}
   className="fixed inset-0 z-40 flex flex-col bg-black/80 backdrop-blur-sm"
   onClick={onClose}
  >
   <div className="flex items-center gap-2 px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
    <span className="min-w-0 flex-1 truncate text-xs text-white/60">{preview.name}</span>
    {remote ? (
     <span className="text-[11px] text-white/50">{t.imageDesktopOnly}</span>
    ) : (
     <>
      <button type="button" onClick={copy} disabled={busy != null} className={action} title={t.imageCopy}>
       {busy === "copy" ? <Loader size={13} aria-hidden className="animate-spin" /> : <Copy size={13} aria-hidden />}
       {t.imageCopy}
      </button>
      <button type="button" onClick={saveAs} disabled={busy != null} className={action} title={t.imageDownload}>
       {busy === "save" ? <Loader size={13} aria-hidden className="animate-spin" /> : <Download size={13} aria-hidden />}
       {t.imageDownload}
      </button>
     </>
    )}
    <button
     type="button"
     onClick={onClose}
     aria-label={t.imageClose}
     title={t.imageClose}
     className="inline-flex size-7 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
    >
     <X size={15} aria-hidden />
    </button>
   </div>
   <div className="flex min-h-0 flex-1 items-center justify-center p-3" onClick={onClose}>
    <img
     src={preview.src}
     alt={preview.name}
     className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
     onClick={(e) => e.stopPropagation()}
    />
   </div>
   <div className="min-h-8 px-3 pb-3 text-center text-xs text-white/80" aria-live="polite">
    {notice}
   </div>
  </div>
 );
}
