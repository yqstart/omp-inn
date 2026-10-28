import {
 forwardRef,
 useEffect,
 useImperativeHandle,
 useRef,
 type ClipboardEvent as ReactClipboardEvent,
 type KeyboardEvent as ReactKeyboardEvent,
 type ReactNode,
} from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
 $createLineBreakNode,
 $createParagraphNode,
 $createRangeSelection,
 $createTextNode,
 $getRoot,
 $getSelection,
 $insertNodes,
 $isElementNode,
 $isRangeSelection,
 $isTextNode,
 $setSelection,
 type LexicalNode,
 type ElementNode,
 type RangeSelection,
} from "lexical";
import {
 $createReferenceChipNode,
 $isReferenceChipNode,
 ReferenceChipNode,
 type ReferenceChipPayload,
} from "./ReferenceChipNode";

/**
 * 输入卡的草稿编辑器（Lexical，plain-text 口径）——照 DeepSeek Harness 的
 * `DraftEditor` / `DraftEditorRuntime` 拆法：**编辑器只管草稿这一层**（文本、`@引用`原子节点、
 * 光标、撤销栈），发送语义、补全数据、附件全留在 `Composer` 里。
 *
 * 与旧 textarea 的分工差异：
 * - **不受控**：Lexical 的编辑器状态是权威，外部要改内容走句柄的 `setText` / `insertReference`
 *   （store 里的草稿是它的投影，用于发送、检查与持久化）；
 * - 句柄（`DraftEditorHandle`）就是旧 `textarea` 的那些用法：读全文、读光标前文本、插入文本、
 *   插入引用、聚焦；
 * - 键盘与粘贴走 **capture 阶段**转发给 `Composer`——它的分支（发送 / 插话 / 排队 / Shift+Tab /
 *   历史浏览 / 粘贴转文件）先判，返回 `true` 就不让编辑器再处理这个事件。
 */
/**
 * 更新的来源（`editor.update(fn, { tag })` 打标，消费方据此决定要不要回写草稿）：
 * - `user`：用户敲的 —— 回写草稿、退出历史浏览；
 * - `insert`：壳插进来的文本 / 引用（补全选中、`#N` 占位、粘贴转文件）—— 回写草稿，
 *   但不算「用户编辑」，不该打断历史浏览；
 * - `sync`：外部把 store 的草稿投影进编辑器 —— **不回写**（store 已经是权威；
 *   回写会让迟到的通知覆盖更新的草稿，例如发送失败的回滚）。
 */
export type DraftTextSource = "user" | "insert" | "sync";

const TAG_INSERT = "omp-insert";
const TAG_SYNC = "omp-sync";

export type DraftEditorHandle = {
 /** 全文（`@引用` 序列化成**真路径**，所以这就是发给 omp 的 prompt 形态）。 */
 getText: () => string;
 /** 读取待提交状态，不触发更新通知。 */
 peekText: () => string;
 /** 在草稿末尾追加引用块，与现有内容留空行。 */
 appendQuote: (text: string) => void;
 /** 光标所在文本节点里、光标之前的那一段（`@` 补全取词用）。 */
 getTextBeforeCaret: () => string;
 /** 光标是否在整段草稿的最开头（↑ 调回历史用；多行编辑中不该抢走方向键）。 */
 isCaretAtStart: () => boolean;
 /** 整体替换内容（队列退回 / 历史调回 / 外部草稿同步），光标落到末尾。 */
 setText: (text: string) => void;
 /** 在光标处插入纯文本（支持 `\n`，走 LineBreakNode）。 */
 insertText: (text: string) => void;
 /** 插到整段草稿的最开头（技能命令必须在行首，omp 才认 `/skill:<名>`）。 */
 insertTextAtStart: (text: string) => void;
 /** 插入一个软换行（Shift+Enter）。 */
 insertLineBreak: () => void;
 /** 在光标处插入一枚引用芯片（前后按需补空格）。 */
 insertReference: (payload: ReferenceChipPayload) => void;
 /** 把光标前的 `@token` 换成引用芯片（补全里选中**文件**）。 */
 replaceMention: (token: string, payload: ReferenceChipPayload) => void;
 /** 把光标前的 `@token` 换成一段路径文本（补全里选中**目录** = 往下钻一层）。 */
 replaceMentionWithText: (token: string, text: string) => void;
 focus: () => void;
};

/**
 * 草稿全文 = **Lexical 的权威序列化**（`\n` 由 LineBreakNode 产出，`@引用` 由 chip 产出真路径），
 * 也就是发给 omp 的形态。
 *
 * 为什么不让 Enter / 粘贴造出多个段落：Lexical 对 block 之间的分隔不写进 `getTextContent()`，
 * 而"按段落自己拼 `\n`"会撞上它的规范化中间态（实测：空段落被数成空行 → 与外部草稿来回改写
 * → 段落数指数增长直到 OOM）。所以草稿**恒定只有一个段落**，换行一律是 LineBreakNode。
 */
function $draftText(): string {
 return $getRoot().getTextContent();
}

/**
 * 在 `editorState.read()` / `editor.update()` 里调用：**光标前的那一段取词文本**。
 *
 * 不只是当前文本节点——光标紧跟一枚**目录芯片**时（选中 `dist` 后接着打 `src`），
 * 芯片的 `@dist/` 要接在前面，补全才能继续往下钻（这正是「进入文件夹」的那一步）。
 */
function $textBeforeCaret(): string {
 const selection = $getSelection();
 if (!$isRangeSelection(selection)) return "";
 const { anchor } = selection;
 const node = anchor.getNode();
 let before = "";
 let sibling: LexicalNode | null;
 if ($isTextNode(node)) {
  before = node.getTextContent().slice(0, anchor.offset);
  if (/[@\s]/.test(before)) return before; // 自己这段已经含 token 起点或空白：不用往前找
  sibling = node.getPreviousSibling();
 } else if ($isElementNode(node)) {
  // 光标落在元素边界（紧跟芯片之后就是这种：目录引用不补空格，光标贴在芯片后面）
  sibling = node.getChildAtIndex(anchor.offset - 1);
 } else {
  // 其余节点类型（换行 / 装饰节点）当锚点：直接看它前面是不是芯片
  sibling = (node as LexicalNode).getPreviousSibling();
 }
 while (sibling !== null && $isReferenceChipNode(sibling)) {
  before = sibling.getTextContent() + before;
  if (/[@\s]/.test(before)) break;
  sibling = sibling.getPreviousSibling();
 }
 return before;
}

/** 往前找是否还有任何叶子节点（决定插入引用前要不要补一个空格）。 */
function $hasLeafBefore(node: LexicalNode): boolean {
 let sibling: LexicalNode | null = node.getPreviousSibling();
 let parent: LexicalNode | null = node.getParent();
 while (sibling === null && parent !== null) {
  sibling = parent.getPreviousSibling();
  parent = parent.getParent();
 }
 return sibling !== null;
}

/** 光标在整段草稿的最开头（前面一个叶子都没有）。 */
function $isCaretAtStart(): boolean {
 const selection = $getSelection();
 if (!$isRangeSelection(selection)) return false;
 const node = selection.anchor.getNode();
 if ($isTextNode(node)) return selection.anchor.offset === 0 && !$hasLeafBefore(node);
 return !$hasLeafBefore(node);
}

/** 插入引用时的前导空格规则：行首不补，前面是空白也不补，其余补一个。 */
function $needsLeadingSpace(): boolean {
 const selection = $getSelection();
 if (!$isRangeSelection(selection)) return false;
 const node = selection.anchor.getNode();
 if ($isTextNode(node)) {
  const text = node.getTextContent();
  const offset = Math.min(selection.anchor.offset, text.length);
  if (offset === 0) return $hasLeafBefore(node);
  return !/\s/.test(text[offset - 1] ?? "");
 }
 return $hasLeafBefore(node);
}

/** 把一个段落填成这段文本（`\n` 走 LineBreakNode，保持"一个段落"的口径）。 */
function $fillParagraph(paragraph: ElementNode, text: string): void {
 const lines = text.split("\n");
 lines.forEach((line, index) => {
  if (index > 0) paragraph.append($createLineBreakNode());
  if (line.length > 0) paragraph.append($createTextNode(line));
 });
}

/** 清空并写入整段文本（光标落到末尾）。 */
function $replaceAll(text: string): void {
 const root = $getRoot();
 root.clear();
 const paragraph = $createParagraphNode();
 $fillParagraph(paragraph, text);
 root.append(paragraph);
 paragraph.selectEnd();
}

/** 在光标处插入引用：前导空格按需补，尾部总是留一个空格（提及要在这里收口）。 */
function $insertReferenceAtCaret(payload: ReferenceChipPayload): void {
 let selection = $getSelection();
 if (!$isRangeSelection(selection)) {
  $getRoot().selectEnd();
  selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
 }
 const lead = $needsLeadingSpace();
 selection.insertText(lead ? " " : "");
 // 文件引用在空格处收口；**目录引用不补空格**——接着打就是继续往里钻（`@dist/` + `src`）
 const tail = payload.isDir ? [] : [$createTextNode(" ")];
 $insertNodes([$createReferenceChipNode(payload), ...tail]);
}

/**
 * 光标前提及 token 的选区：从 `@` 起、到光标止。
 *
 * token 可能**跨节点**——`@dist/` 是目录芯片（右栏引用注入）时，`@` 在芯片里、
 * 光标在后面的文本节点里；所以这里从光标往前按字符数凑，凑够 `token` + `@` 就是起点。
 */
function $mentionRange(token: string): RangeSelection | null {
 const selection = $getSelection();
 if (!$isRangeSelection(selection)) return null;
 const anchorNode = selection.anchor.getNode();
 if (!$isTextNode(anchorNode)) return null;
 const caret = Math.min(selection.anchor.offset, anchorNode.getTextContent().length);
 let remaining = token.length + 1; // 连同 `@`
 let node: LexicalNode | null = anchorNode;
 while (node !== null && remaining > 0) {
  const size = node.getTextContent().length;
  if (size >= remaining) {
   const offset = size - remaining;
   const range = selection.clone();
   if ($isTextNode(node)) {
    range.anchor.set(node.getKey(), Math.max(0, offset), "text");
   } else {
    // 起点落在**装饰节点（芯片）**上：point 不能指向芯片内部，改用「父元素 + 子索引」
    const parent = node.getParent();
    if (parent === null) return null;
    range.anchor.set(parent.getKey(), node.getIndexWithinParent() + (offset > 0 ? 1 : 0), "element");
   }
   range.focus.set(anchorNode.getKey(), caret, "text");
   return range;
  }
  remaining -= size;
  node = node.getPreviousSibling();
 }
 return null;
}

/** 把光标前的 `@token` 整段换成一段**文本**（补全里选中目录 = 往下钻一层）。 */
function $replaceMentionWithToken(token: string, text: string): void {
 const range = $mentionRange(token);
 if (range === null) return;
 range.insertText(text); // 替换选区；光标落到插入文本之后，浮层接着取词
}

/** 把光标前的 `@token` 整段换成引用芯片。 */
function $replaceMentionWithReference(token: string, payload: ReferenceChipPayload): void {
 const range = $mentionRange(token);
 if (range === null) return;
 range.removeText(); // 整段（含跨节点的目录芯片）一次删掉，节点回收交给 Lexical
 $insertReferenceAtCaret(payload);
}


/** 跟随 `editable` 切换编辑器只读（等审批回应时输入框不该还能打字）。 */
function EditableToggle({ editable }: { editable: boolean }) {
 const [editor] = useLexicalComposerContext();
 useEffect(() => {
  editor.setEditable(editable);
 }, [editor, editable]);
 return null;
}

/** 把编辑器实例接到句柄上（必须挂在 `LexicalComposer` 内部）。 */
function EditorBridge({
 handleRef,
 initialText,
 onText,
 onCaretText,
}: {
 handleRef: React.RefObject<DraftEditorHandle | null>;
 initialText: string;
 onText: (text: string, source: DraftTextSource) => void;
 onCaretText: ((before: string) => void) | undefined;
}) {
 const [editor] = useLexicalComposerContext();
 // 回调放 ref：Composer 每次渲染都会重建 handler，不该因此重注册 update listener
 const onTextRef = useRef(onText);
 const onCaretRef = useRef(onCaretText);
 useEffect(() => {
  onTextRef.current = onText;
  onCaretRef.current = onCaretText;
 }, [onText, onCaretText]);

 useImperativeHandle(
  handleRef,
  () => ({
   // 提交尚未上报的更新后再读，发送时不能只读上一次已提交的快照。
   getText: () => editor.read(() => $draftText()),
   peekText: () => editor.read("pending", () => $draftText()),
   appendQuote: (text: string) => editor.update(() => {
    const root = $getRoot();
    const current = $draftText();
    const block = `${current.trim() ? "\n\n" : ""}${text}\n\n`;
    const paragraph = root.getFirstChild();
    if ($isElementNode(paragraph)) {
     $fillParagraph(paragraph, block);
     paragraph.selectEnd();
    } else {
     $replaceAll(current + block);
    }
   }, { tag: TAG_INSERT, discrete: true }),
   getTextBeforeCaret: () => editor.getEditorState().read(() => $textBeforeCaret()),
   isCaretAtStart: () => editor.getEditorState().read(() => $isCaretAtStart()),
   setText: (text: string) => editor.update(() => $replaceAll(text), { tag: TAG_SYNC, discrete: true }),
   insertText: (text: string) =>
    editor.update(() => {
     if (text.length === 0) return;
     // 多行文本拆成 LineBreakNode（不让它变成新段落，见 `$draftText` 的口径）
     const selection = $getSelection();
     if (!$isRangeSelection(selection)) $replaceAll($draftText() + text);
     else if (text.includes("\n")) $insertNodes(text.split("\n").flatMap((line, index) => (index > 0 ? [$createLineBreakNode(), $createTextNode(line)] : [$createTextNode(line)])));
     else selection.insertText(text);
    }, { tag: TAG_INSERT }),
   insertTextAtStart: (text: string) =>
    editor.update(() => {
     if (text.length === 0) return;
     const first = $getRoot().getFirstChild();
     const node = $createTextNode(text);
     // 草稿恒定一个段落：插到第一个段落（或首个行内节点）之前，光标停在插入文本末尾——
     // 用户接着写的任务会接在命令后面，而不是接在原文末尾。
     if (!first) {
      $replaceAll(text);
      return;
     }
     const head = $isElementNode(first) ? first.getFirstChild() : first;
     if (head) head.insertBefore(node);
     else if ($isElementNode(first)) first.append(node);
     else first.insertBefore(node);
     const sel = $createRangeSelection();
     sel.anchor.set(node.getKey(), text.length, "text");
     sel.focus.set(node.getKey(), text.length, "text");
     $setSelection(sel);
    }, { tag: TAG_INSERT }),
   insertLineBreak: () =>
    editor.update(() => $insertNodes([$createLineBreakNode()]), { tag: TAG_INSERT }),
   insertReference: (payload: ReferenceChipPayload) =>
    editor.update(() => $insertReferenceAtCaret(payload), { tag: TAG_INSERT }),
   replaceMention: (token: string, payload: ReferenceChipPayload) =>
    editor.update(() => $replaceMentionWithReference(token, payload), { tag: TAG_INSERT }),
   replaceMentionWithText: (token: string, text: string) =>
    editor.update(() => $replaceMentionWithToken(token, text), { tag: TAG_INSERT }),
   focus: () => editor.focus(),
  }),
  [editor],
 );

 // 首次挂载灌入外部草稿（localStorage 恢复 / 切会话）
 const seeded = useRef(false);
 useEffect(() => {
  if (seeded.current) return;
  seeded.current = true;
  if (initialText.length > 0) editor.update(() => $replaceAll(initialText));
 }, [editor, initialText]);

 // 文本与光标变化都从这一处往外报（一次 read 拿两样，避免额外遍历）
 useEffect(
  () =>
   editor.registerUpdateListener(({ editorState, tags }) => {
    let text = "";
    let before = "";
    editorState.read(() => {
     text = $getRoot().getTextContent();
     before = $textBeforeCaret();
    });
    const source: DraftTextSource = tags.has(TAG_SYNC)
     ? "sync"
     : tags.has(TAG_INSERT)
      ? "insert"
      : "user";
    onTextRef.current(text, source);
    onCaretRef.current?.(before);
   }),
  [editor],
 );

 return null;
}

export const DraftEditor = forwardRef<
 DraftEditorHandle,
 {
  ariaLabel: string;
  /** 占位内容：只在草稿为空时出现（空段落上的浮动文案）。 */
  placeholder: ReactNode;
  initialText: string;
  /** 文本变化（含 chip 序列化后的真路径）与它的来源（见 `DraftTextSource`）。 */
  onText: (text: string, source: DraftTextSource) => void;
  /** 光标变化：光标前的文本片段。 */
  onCaretText?: (before: string) => void;
  /** 键盘（capture）：返回 true = 已处理，编辑器不再碰这个按键。 */
  onKeyDown?: (e: ReactKeyboardEvent<HTMLElement>) => boolean;
  /** 粘贴（capture）：返回 true = 已处理。 */
  onPaste?: (e: ReactClipboardEvent<HTMLElement>) => boolean;
  /** 悬停提示（输入框整体）：引用不单独排芯片，完整路径要查就在这里。 */
  title?: string;
  /** 可编辑（false = 只读：等审批回应的那段时间，与原 textarea 的 disabled 同语义）。 */
  editable?: boolean;
 }
>(function DraftEditor(
 { ariaLabel, placeholder, initialText, onText, onCaretText, onKeyDown, onPaste, title, editable = true },
 ref,
) {
 return (
  <LexicalComposer
   initialConfig={{
    namespace: "omp-composer",
    nodes: [ReferenceChipNode],
    onError: (error: Error) => {
     // 编辑器初始化失败不该静默：抛给上层错误边界（开发期也能立刻看到）
     throw error;
    },
    theme: { paragraph: "draft-paragraph" },
   }}
  >
   <div
    className="relative"
    data-draft-editor=""
    title={title}
    onKeyDownCapture={(e) => {
     if (onKeyDown?.(e) === true) {
      e.preventDefault();
      e.stopPropagation();
     }
    }}
    onPasteCapture={(e) => {
     if (onPaste?.(e) === true) {
      e.preventDefault();
      e.stopPropagation();
     }
    }}
   >
    <PlainTextPlugin
     contentEditable={
      <ContentEditable
       aria-label={ariaLabel}
       className="draft-editor max-h-44 min-h-[24px] w-full overflow-y-auto px-3.5 pt-3 pb-1 text-sm leading-6 break-words whitespace-pre-wrap outline-none"
      />
     }
     placeholder={<span className="pointer-events-none absolute top-3 left-3.5 text-sm text-faint">{placeholder}</span>}
     ErrorBoundary={LexicalErrorBoundary}
    />
    <HistoryPlugin />
   <EditableToggle editable={editable} />
   </div>
   <EditorBridge handleRef={ref as React.RefObject<DraftEditorHandle | null>} initialText={initialText} onText={onText} onCaretText={onCaretText} />
  </LexicalComposer>
 );
});
