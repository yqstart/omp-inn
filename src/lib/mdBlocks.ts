/**
 * 流式 Markdown 的「冻结前缀 + 活跃尾块」切分（V38，纯函数）。
 *
 * 背景：`AssistantText` 此前每帧对**整条文本**重跑 react-markdown + rehype-highlight，
 * 长回复的单帧成本随文本长度二次方级累积（V37 实测 3000 字符最坏 ~86ms/帧）。
 * 成熟产品的做法是两段式（Codex TUI 的 `streaming/controller.rs`：committed 区进
 * scrollback、只有 mutable tail 每帧重渲染）——本函数就是它的 GUI 版：
 *
 * - 输入当前**已在显示的**文本（平滑揭示后的子串，见 `streamReveal.ts`）；
 * - 输出若干连续性切片 `blocks`，且 `blocks.join("") === text`；
 * - 除**最后一个**之外都是「已冻结」块：之后到达的任何文本都不可能改变它们的渲染
 *   （可以 memo，不再重解析）；最后一个 = 活跃尾块，每帧重渲染。
 *
 * 冻结点 = **空行段之后的完整非空行起点**，且该空行段确实终结了前面的块。判定规则
 * （保守优先：宁可多留尾块，绝不冻结会被后续文本改写的块）：
 *
 * - 围栏代码块内一律不冻结（闭合围栏会改变后续行的解释；且围栏内容仍在增长）；
 * - 空行段若被**引用**（下一个非空行仍是 `>` 或以惰性续行形态接上）或**列表**
 *   （下一个非空行是列表项 / 缩进 ≥2 的续行）延续，则不冻结——否则松列表会被切成
 *   两个列表、引用会裂成两个引用框；缩进代码块（≥4 空格）同理；
 * - 锚行必须是**已换行结尾的完整行**（半截行下一帧可能变样，不能当锚）；
 * - 文内出现链接引用定义（`[标签]: …` / 脚注 `[^x]: …`）一律整段不分块——
 *   定义可以回溯解释更早的引用，冻结前缀会渲染错。
 *
 * 已知取舍（罕见、可接受）：跨空行的 HTML 注释块（`<!-- … -->`）可能在空行处被切开，
 * 两半各自按转义文本渲染（react-markdown 默认不解析原始 HTML），视觉影响可忽略。
 */
/** 围栏开栏行（可带 info string）与闭合行（只有围栏字符）。 */
const FENCE = /^( {0,3})(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * 文本结尾是否停在**未闭合的围栏**里，以及围栏里是否已有内容（AssistantText 的
 * 骨架 / 光标策略用）。与 `splitMarkdownBlocks` 同一套行扫描口径：行内代码里的
 * ``` 不算围栏（此前按「``` 出现次数奇偶」判断，`用 ``` 包起来` 这样的行内写法
 * 会误报）、`~~~` 围栏同样成对、缩进 ≥4 的一行不是围栏。
 *
 * - `open` = 扫描到结尾时围栏未闭合；
 * - `hasContent` = 开栏行之后已有非空白内容（有内容就不需要骨架：代码块自己在长，
 *   光标能贴到最后一行代码上；没有内容时代码块是空的，光标无处可贴）。
 */
export function openFenceState(text: string): { open: boolean; hasContent: boolean } {
 if (!text) return { open: false, hasContent: false };
 let fence: { ch: string; len: number } | null = null;
 let bodyStart = -1; // 开栏行结束（含换行）之后的位置
 let pos = 0;
 for (; ;) {
  const nl = text.indexOf("\n", pos);
  const end = nl === -1 ? text.length : nl + 1;
  const content = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
  if (fence) {
   if (nl !== -1) {
    const close = content.match(FENCE_CLOSE);
    if (close && close[1][0] === fence.ch && close[1].length >= fence.len) {
     fence = null;
     bodyStart = -1;
    }
   }
  } else {
   const open = content.match(FENCE);
   if (open) {
    fence = { ch: open[2][0], len: open[2].length };
    bodyStart = end;
   }
  }
  if (nl === -1) break;
  pos = end;
 }
 return { open: fence !== null, hasContent: fence !== null && bodyStart >= 0 && text.slice(bodyStart).trim() !== "" };
}

export function splitMarkdownBlocks(text: string): string[] {
 if (!text) return [text];

 /** 当前打开的顶层容器（跨空行可能延续的块类型）。段落 / 标题等 = `none`。 */
 type Container = "none" | "list" | "quote" | "indented" | "html";

 const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
 const QUOTE = /^ {0,3}>/;
 const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
 const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
 const HTMLISH = /^ {0,3}</;
 // 链接引用定义 / 脚注定义：可以回溯解释更早的块，出现即放弃冻结。
 const DEF_LINE = /^ {0,3}\[[^\]]+\]:/;

 const indentOf = (s: string): number => {
  let i = 0;
  while (s[i] === " " || s[i] === "\t") i++;
  return i;
 };

 /** 空行段之后的新块是否仍属当前容器（true = 不冻结，继续留在尾块里）。 */
 const continues = (container: Container, line: string): boolean => {
  switch (container) {
   case "list":
    // 列表项之间可以隔空行（松列表）；缩进 ≥2 视作上一项的续行段落 / 子块。
    return LIST_ITEM.test(line) || indentOf(line) >= 2;
   case "quote":
    // 空行之后只有带 `>` 的行才仍在引用里（惰性续行不能跨空行）。
    return QUOTE.test(line);
   case "indented":
    return indentOf(line) >= 4;
   case "html":
    return HTMLISH.test(line);
   default:
    return false;
  }
 };

 const bounds: number[] = []; // 冻结边界（每个 = 一个新块起点，恒 > 0 且递增）
 let fence: { ch: string; len: number } | null = null;
 let fenceHost: Container = "none"; // 围栏所在容器（列表项里的围栏，闭合后恢复）
 let container: Container = "none";
 let blankStart: number | null = null; // 挂起的空行段起点（出现非空行时结算）
 let sawDef = false;

 let pos = 0;
 for (; ;) {
  const nl = text.indexOf("\n", pos);
  const end = nl === -1 ? text.length : nl + 1;
  const raw = text.slice(pos, end);
  const content = nl === -1 ? raw : raw.slice(0, -1);
  const terminated = nl !== -1;
  const isBlank = content.trim() === "";

  if (fence) {
   // 围栏内：只认闭合围栏行（必须完整行才能判断长度）；其余（含空行）一概不结算。
   if (terminated) {
    const close = content.match(FENCE_CLOSE);
    if (close && close[1][0] === fence.ch && close[1].length >= fence.len) {
     fence = null;
     container = fenceHost;
    }
   }
  } else if (isBlank) {
   if (blankStart == null) blankStart = pos;
  } else {
   // 非空行：先结算挂起的空行段。锚行必须已换行结尾，半截行不作数。
   if (blankStart != null) {
    if (terminated && !continues(container, content)) {
     bounds.push(pos);
     container = "none";
    }
    blankStart = null;
   }
   if (DEF_LINE.test(content)) sawDef = true;
   // 分类当前行，更新容器 / 围栏状态。
   if (QUOTE.test(content)) {
    container = "quote";
   } else if (LIST_ITEM.test(content)) {
    container = "list";
   } else {
    const fm = content.match(FENCE);
    if (fm) {
     fence = { ch: fm[2][0], len: fm[2].length };
     fenceHost = container;
    } else if (indentOf(content) >= 4) {
     container = "indented";
    } else if (HTMLISH.test(content)) {
     container = "html";
    } else if (HEADING.test(content) || HR.test(content)) {
     container = "none";
    } else if (container !== "list" && container !== "quote") {
     // 普通段落：列表 / 引用里的普通文本行是惰性续行，留在原容器。
     container = "none";
    }
   }
  }
  if (nl === -1) break;
  pos = end;
 }

 if (sawDef || bounds.length === 0) return [text];
 const out: string[] = [];
 let prev = 0;
 for (const b of bounds) {
  if (b > prev) {
   out.push(text.slice(prev, b));
   prev = b;
  }
 }
 if (prev < text.length) out.push(text.slice(prev));
 return out.length > 0 ? out : [text];
}
