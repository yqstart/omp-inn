import type { ImageAttachment, ImageBlock } from "@shared/types";
import { fmt, type Text } from "./locale";

/**
 * 图片附件的纯逻辑（不碰 DOM/tauri，便于单测）：
 * 类型白名单、单张体积上限、bytes → base64、`data:` URL 组装。
 *
 * 口径：附件只在内存里存在到发送那一刻，随 `prompt.images` 交给 omp；
 * 应用不落盘、不写覆盖层，历史回放读的是 omp 自己写进 jsonl 的 image 块。
 */

/** 单张上限：超过就在本地拒绝（提示用户先压缩），不把几十 MB base64 塞进 RPC 帧。 */
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024;

/** 允许的图片类型（omp 侧支持 png/jpeg/webp/gif）。 */
export const ATTACH_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const EXT_MIME: Record<string, string> = {
 png: "image/png",
 jpg: "image/jpeg",
 jpeg: "image/jpeg",
 webp: "image/webp",
 gif: "image/gif",
};

/** 由文件名推 mime；不认识的扩展名返回 null（调用方给中文提示）。 */
export function mimeFromName(name: string): string | null {
 const ext = name.split(".").pop()?.toLowerCase() ?? "";
 return EXT_MIME[ext] ?? null;
}

/** mime → 保存文件名用的扩展名（未知按 png 兜底：预览与另存为都只认这四种格式）。 */
export function extFromMime(mime: string): string {
 if (mime === "image/jpeg") return "jpg";
 if (mime === "image/webp") return "webp";
 if (mime === "image/gif") return "gif";
 return "png";
}

export function isAllowedMime(mime: string): boolean {
 return (ATTACH_MIME as readonly string[]).includes(mime);
}

/** 体积/类型校验：返回当前语言的错误文案，null = 通过。 */
export function checkImage(name: string, mime: string, bytes: number, t: Text): string | null {
 if (!isAllowedMime(mime)) return fmt(t.attachBadType, name);
 if (bytes > ATTACH_MAX_BYTES) return fmt(t.attachTooLarge, name);
 return null;
}

/** Uint8Array → base64（分块，避免 String.fromCharCode 参数过多爆栈）。 */
export function bytesToBase64(bytes: Uint8Array): string {
 let bin = "";
 const chunk = 0x8000;
 for (let i = 0; i < bytes.length; i += chunk) {
  bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
 }
 return btoa(bin);
}

/** data: URL（缩略图渲染用；只在本地 WebView 内显示，不外发）。 */
export function dataUrl(img: { mimeType: string; data?: string; dataBase64?: string }): string {
 return `data:${img.mimeType};base64,${img.data ?? img.dataBase64 ?? ""}`;
}

/**
 * 给新附件分配稳定编号（`slot`）：从当前最大编号往后递增——删除图片**不重排、不重编号**，
 * 文字里的 `#N` 永远指同一张图（编号只在附件清空后从 1 重开）。已带编号的项原样保留
 * （发送失败回滚会把整批带编号的附件放回来，不该被二次分配）。
 */
export function withSlots(existing: ImageAttachment[], items: ImageAttachment[]): ImageAttachment[] {
 let next = 0;
 for (const a of existing) next = Math.max(next, a.slot ?? 0);
 for (const a of items) if (a.slot) next = Math.max(next, a.slot);
 return items.map((it) => {
  if (it.slot) return it;
  next += 1;
  return { ...it, slot: next };
 });
}

/**
 * omp 队列撤回返回的图片块（`{type:"image", data, mimeType}`）→ 本地附件（V40）：
 * 「编辑排队消息 / 中断还原」把图片放回输入框时用。文件名为占位（omp 不保留原名），
 * 体积按 base64 长度估算（仅用于展示）。
 */
export function attachmentFromOmpImage(img: { data?: string; mimeType?: string }): ImageAttachment {
 const mimeType = img.mimeType || "image/png";
 const dataBase64 = img.data ?? "";
 const ext = mimeType.split("/")[1] ?? "png";
 return { name: `image.${ext}`, mimeType, dataBase64, bytes: Math.floor((dataBase64.length * 3) / 4) };
}

/**
 * File → 附件。用 `arrayBuffer()` 而不是 FileReader：Node/vitest 与 WebView 都能跑。
 * 校验不过时抛当前语言的 Error（调用方直接展示 message）。
 */
export async function attachmentFromFile(file: File, t: Text): Promise<ImageAttachment> {
 const mime = file.type || mimeFromName(file.name) || "";
 const err = checkImage(file.name, mime, file.size, t);
 if (err) throw new Error(err);
 const buf = new Uint8Array(await file.arrayBuffer());
 return { name: file.name, mimeType: mime, dataBase64: bytesToBase64(buf), bytes: buf.byteLength };
}

/** omp 历史 jsonl 的图片外置引用：`blob:sha256:<64 位小写十六进制>` → hash；其余返回 null。 */
const BLOB_REF = /^blob:sha256:([a-f0-9]{64})$/;

export function blobRefOf(data: unknown): string | null {
 if (typeof data !== "string") return null;
 return BLOB_REF.exec(data)?.[1] ?? null;
}

/**
 * 从消息内容块里取图片（实时帧与 jsonl 同构）。
 *
 * 两种实体形态：
 * - `data` = base64（实时帧 / `prompt.images`）；
 * - `data` = `blob:sha256:<hash>`（omp 落盘时的外置引用）→ 只留 `blob` 哈希，
 *   由渲染层按需读 `blobs` 目录。**不许**把它当 base64 拼 data URL（会得到坏图）。
 *
 * base64 超过 `maxChars` 的块跳过并计数——历史回放不做无上限 base64 常驻。
 */
export function imagesFromContent(
 content: unknown,
 maxChars = 512 * 1024,
): { images: ImageBlock[]; omitted: number } {
 if (!Array.isArray(content)) return { images: [], omitted: 0 };
 const images: ImageBlock[] = [];
 let omitted = 0;
 for (const raw of content) {
  if (!raw || typeof raw !== "object") continue;
  const b = raw as { type?: string; data?: unknown; mimeType?: unknown; source?: { data?: unknown; media_type?: unknown } };
  if (b.type !== "image") continue;
  const data = typeof b.data === "string" ? b.data : typeof b.source?.data === "string" ? b.source.data : "";
  const mimeType =
   typeof b.mimeType === "string"
    ? b.mimeType
    : typeof b.source?.media_type === "string"
     ? b.source.media_type
     : "image/png";
  const blob = blobRefOf(data);
  if (blob) {
   images.push({ mimeType, blob });
   continue;
  }
  // `blob:` 前缀只可能是 omp 的外置引用（base64 字符集不含 `:`）；形状不对就没法还原，
  // 记成省略——**不许**当 base64 落到 data URL（那是坏图）。
  if (data.startsWith("blob:")) {
   omitted += 1;
   continue;
  }
  if (!data || data.length > maxChars) {
   omitted += 1;
   continue;
  }
  images.push({ mimeType, data });
 }
 return { images, omitted };
}
