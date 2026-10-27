import { useEffect, useMemo, useState } from "react";
import { Image as ImageIcon, Loader } from "reicon-react";
import type { ImageBlock } from "@shared/types";
import { dataUrl, extFromMime } from "../../lib/attachments";
import { cachedBlobImage, loadBlobImage } from "../../lib/blobImages";
import { useText } from "../../lib/useText";

/** 预览浮层需要的最小图片数据（已解析成 data URL 与原始 base64）。 */
export type ImagePreview = {
 src: string;
 base64: string;
 mimeType: string;
 name: string;
 index: number;
};

type Resolved = { src: string; base64: string; mimeType: string };

const keyOf = (img: ImageBlock): string =>
 img.blob ?? `d:${img.data?.length ?? 0}:${img.data?.slice(0, 24) ?? ""}`;

/**
 * 消息气泡里的一张图（V2 M6 / 2026-10-22 图片交互）。
 *
 * 两种实体来源在这里统一：
 * - 实时帧是 base64 → 直接拼 data URL；
 * - 历史回放是 `blob:sha256:<hash>` → 按需读 omp 的 `blobs` 目录（`lib/blobImages.ts`，
 *   带 LRU 与单飞去重）。**绝不能**把 blob 引用当 base64 拼 data URL——那是坏图的根因。
 *
 * 点击交给父层开预览（`onOpen`），复制 / 保存挂在预览浮层里（`ImageLightbox`）。
 */
export function MessageImage({
 img,
 index,
 alt,
 onOpen,
}: {
 img: ImageBlock;
 index: number;
 alt: string;
 onOpen: (p: ImagePreview) => void;
}) {
 const t = useText();
 const key = keyOf(img);
 const direct = useMemo<Resolved | null>(() => {
  if (img.data) return { src: dataUrl({ mimeType: img.mimeType, data: img.data }), base64: img.data, mimeType: img.mimeType };
  const hit = img.blob ? cachedBlobImage(img.blob) : undefined;
  return hit?.data ? { src: dataUrl(hit), base64: hit.data, mimeType: hit.mimeType } : null;
 }, [img.data, img.blob, img.mimeType]);
 // 异步结果按「图片键」记账：props 换成另一张图时旧结果自然失效，不在 effect 里同步清状态
 const [loaded, setLoaded] = useState<{ key: string; view: Resolved } | null>(null);
 const [failedKey, setFailedKey] = useState<string | null>(null);

 useEffect(() => {
  if (direct || !img.blob) return;
  let alive = true;
  const hash = img.blob;
  loadBlobImage(hash)
   .then((r) => {
    if (!alive || !r.data) return;
    setLoaded({ key, view: { src: dataUrl(r), base64: r.data, mimeType: r.mimeType } });
   })
   .catch(() => {
    if (alive) setFailedKey(key);
   });
  return () => {
   alive = false;
  };
 }, [direct, img.blob, key]);

 const view = direct ?? (loaded?.key === key ? loaded.view : null);
 const failed = failedKey === key || (!img.data && !img.blob);
 const name = `image-${index + 1}.${extFromMime(view?.mimeType ?? img.mimeType)}`;

 return (
  <button
   type="button"
   disabled={!view}
   onClick={() => view && onOpen({ ...view, name, index })}
   aria-label={t.imagePreview}
   title={view ? t.imagePreview : failed ? t.imageUnavailable : t.imageLoading}
   className="group relative inline-flex max-w-full overflow-hidden rounded-lg border border-border bg-surface align-top transition-colors enabled:hover:border-accent/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default"
  >
   {view ? (
    <img src={view.src} alt={alt} loading="lazy" className="max-h-64 max-w-[240px] object-contain" />
   ) : failed ? (
    <span className="flex h-24 w-40 flex-col items-center justify-center gap-1.5 px-3 text-center text-[11px] leading-4 text-faint">
     <ImageIcon size={16} aria-hidden />
     {t.imageUnavailable}
    </span>
   ) : (
    <span className="flex h-24 w-40 items-center justify-center gap-1.5 text-[11px] text-faint">
     <Loader size={14} aria-hidden className="animate-spin" />
     {t.imageLoading}
    </span>
   )}
  </button>
 );
}
