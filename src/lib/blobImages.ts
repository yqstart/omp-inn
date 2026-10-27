import { api } from "@shared/api";
import type { ImageBlock } from "@shared/types";

/**
 * 历史会话图片的按需加载（omp 把图片外置进 `blobs/<sha256>`，jsonl 只留引用）。
 *
 * 为什么不在 `get_history` 里内联 base64：一次回放可能有几十张图，内联会把整段历史
 * 的图片都以 base64 常驻 WebView 内存；这里按 hash 单飞读取 + 小容量 LRU，
 * 只解析真正渲染出来的图片，切换会话后自然被挤出。
 *
 * 缓存口径：最多 40 张 / 48M 字符（base64 长度）。命中同步返回（首帧不闪占位），
 * 未命中走 `api.readBlobImage`（只读 `blobs` 目录，hash 形状由后端再校验一次）。
 */

const MAX_ENTRIES = 40;
const MAX_CHARS = 48 * 1024 * 1024;

type Loaded = { image: ImageBlock; chars: number };
const cache = new Map<string, Loaded>();
const inflight = new Map<string, Promise<ImageBlock>>();
let totalChars = 0;

function evict() {
 while (cache.size > MAX_ENTRIES || totalChars > MAX_CHARS) {
  const oldest = cache.keys().next().value;
  if (!oldest) break;
  const entry = cache.get(oldest);
  cache.delete(oldest);
  if (entry) totalChars -= entry.chars;
 }
}

function remember(hash: string, image: ImageBlock) {
 if (cache.has(hash)) return;
 const chars = image.data?.length ?? 0;
 cache.set(hash, { image, chars });
 totalChars += chars;
 evict();
}

/** 同步取缓存（命中即挪到 LRU 队尾）。 */
export function cachedBlobImage(hash: string): ImageBlock | undefined {
 const hit = cache.get(hash);
 if (!hit) return undefined;
 cache.delete(hash);
 cache.set(hash, hit);
 return hit.image;
}

export function loadBlobImage(hash: string): Promise<ImageBlock> {
 const hit = cachedBlobImage(hash);
 if (hit) return Promise.resolve(hit);
 const pending = inflight.get(hash);
 if (pending) return pending;
 const p = api
  .readBlobImage(hash)
  .then((r) => {
   const image: ImageBlock = { mimeType: r.mimeType, data: r.dataBase64 };
   remember(hash, image);
   return image;
  })
  .finally(() => {
   inflight.delete(hash);
  });
 inflight.set(hash, p);
 return p;
}

/** 测试用：清空缓存与在飞请求。 */
export function resetBlobImageCache() {
 cache.clear();
 inflight.clear();
 totalChars = 0;
}
