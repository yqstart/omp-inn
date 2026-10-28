import type { ImageAttachment } from "@shared/types";

/**
 * 图片附件的 `#N` 编号 → 实际图片位置的**发送侧注记**（2026-10-21 用户口径，方案 A）。
 *
 * 背景：`#N` 是壳写进正文的普通文本，omp 不解析；图片是独立的 `images[]` 数组，
 * 模型只能按数组顺序看到图，正文里的 `#N` 与图之间**没有协议层映射**。删过图后编号
 * 还有空洞（#1 #3 但只剩两张图），模型更容易对错。
 *
 * 口径：
 * - 只在正文**确实引用了某个已附带附件的 `#N`** 时补一行（没有引用 / 没图不补，省 token）；
 * - 注记按**图片在数组里的顺序**列出（也就是模型看到的顺序），不按正文出现顺序；
 * - 行格式固定为 `\n\n[omp image order: #1=image 1, #3=image 2]`，`stripImageOrderNote`
 *   按同一条格式从展示层剥掉（输入框 / 回显 / 历史 / 队列行都不显示这行）；
 * - 这是**发给模型的 wire text**，不是界面文案（界面语言无关，英文更稳）。
 */
const NOTE_HEAD = "\n\n[omp image order: ";
const NOTE_RE = /\n\n\[omp image order: #\d+=image \d+(?:, #\d+=image \d+)*\]$/;

/** `#N` 里 N 所属的附件（`slot`）→ 它在 `images` 数组里的 1-based 位置。 */
type Ref = { slot: number; index: number };

/** 按发送侧的边界规则处理正文里的独立图片编号。 */
function rewriteImageRefs(text: string, rewrite: (slot: number) => number | null): string {
 let out = "";
 let copied = 0;
 for (let i = 0; i < text.length; i += 1) {
  if (text[i] !== "#") continue;
  const prev = i > 0 ? text[i - 1] : "";
  if (prev && /[A-Za-z0-9_#]/.test(prev)) continue;
  let j = i + 1;
  while (j < text.length && text[j] >= "0" && text[j] <= "9") j += 1;
  if (j === i + 1) continue;
  const next = j < text.length ? text[j] : "";
  if (next && /[A-Za-z_]/.test(next)) continue;
  const digits = text.slice(i + 1, j);
  if (digits.length > 1 && digits[0] === "0") continue;
  const replacement = rewrite(Number(digits));
  if (replacement !== null) {
   out += `${text.slice(copied, i)}#${replacement}`;
   copied = j;
  }
  i = j - 1;
 }
 return out + text.slice(copied);
}

/**
 * 正文里实际引用的附件（按图片数组顺序返回）。
 *
 * 只认**独立写法**的 `#数字`（前面不是字母 / 数字 / 下划线 / `#`）：
 * `如图#1`、`#1 和 #2` 算；`@foo#1.png`、`v2#3` 这种路径 / 标识里的 `#` 不算。
 * 并且 N 必须是当前附件的 `slot`——`#123456`（色值）、正文里的 issue 号不会误伤。
 */
function referencedImages(text: string, images: ImageAttachment[]): Ref[] {
 const bySlot = new Map<number, number>();
 images.forEach((img, i) => {
  if (typeof img.slot === "number") bySlot.set(img.slot, i + 1);
 });
 if (bySlot.size === 0) return [];
 const hits = new Set<number>();
 rewriteImageRefs(text, (slot) => {
  if (bySlot.has(slot)) hits.add(slot);
  return null;
 });
 // 按图片顺序列，不按正文出现顺序：注记描述的是「模型看到的第几张图」
 return images.flatMap((img, i) =>
  typeof img.slot === "number" && hits.has(img.slot) ? [{ slot: img.slot, index: i + 1 }] : [],
 );
}

/** 要追加的注记（没有需要映射的引用 → 空串）。 */
export function imageOrderNote(text: string, images: ImageAttachment[]): string {
 const refs = referencedImages(text, images);
 if (refs.length === 0) return "";
 return `${NOTE_HEAD}${refs.map((r) => `#${r.slot}=image ${r.index}`).join(", ")}]`;
}

/** 发送用的 wire text：正文 + 附件顺序注记（无引用时原样返回）。 */
export function withImageOrderNote(text: string, images: ImageAttachment[]): string {
 const note = imageOrderNote(text, images);
 return note ? `${text}${note}` : text;
}

/** 展示 / 队列回退用：剥掉发送时补的附件顺序注记（用户自己写的同款行极少，按整行精确匹配）。 */
export function stripImageOrderNote(text: string): string {
 return text.replace(NOTE_RE, "");
}

/** 队列图片重新分配编号后，用注记把正文中的旧编号同步为新编号。 */
export function restoreImageOrder(text: string, images: ImageAttachment[]): string {
 const note = text.match(NOTE_RE)?.[0];
 const slots = new Map<number, number>();
 if (note) {
  for (const match of note.matchAll(/#(\d+)=image (\d+)/g)) {
   const slot = images[Number(match[2]) - 1]?.slot;
   if (slot !== undefined) slots.set(Number(match[1]), slot);
  }
 }
 return rewriteImageRefs(stripImageOrderNote(text), (slot) => slots.get(slot) ?? null);
}
