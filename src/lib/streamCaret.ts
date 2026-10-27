/**
 * 流式光标的落位（V38 重写：从「搬 DOM」改为「测坐标」）。
 *
 * 问题（V37 归因保留）：ReactMarkdown 把正文包进 `<p>` / `<li>` / `<pre>` 等块级元素，
 * 光标若只是 React 的普通末尾子节点，就落在「最后一块的下方新行」。
 *
 * V37 的做法是把光标 DOM **移动到最后一个文本节点之后**（`node.after(caret)`）——
 * 这与 V38 的分块渲染（`MdBlock` 各自管一段子树）冲突：React 插入新块时的锚点会引用
 * 「下一个兄弟节点」，而被搬走的光标不再是 `md-body` 的直接子节点，插入直接抛
 * `NotFoundError: Failed to execute 'insertBefore' ... is not a child of this node`
 * （真实浏览器核对现场：第一个文本 delta 一到，整页崩）。**手工搬动 React 管理的 DOM 是雷。**
 *
 * 现行做法：**一个节点都不搬**。光标仍是 React 渲染在 `md-body` 末尾的普通子节点，
 * 靠 `position: absolute` 覆盖到「最后一个非空白文本节点」末端坐标——每次渲染后在
 * layout effect 里用 Range 量一次、只写 style。跨分块也天然成立：取的是**文档序最后**
 * 的文本节点，永远落在活跃尾块里。
 */

/** 深优先序（从尾到头）找最后一个**非空白**文本节点。 */
function findLastTextNode(host: Node): Text | null {
 let child = host.lastChild;
 while (child) {
  if (child.nodeType === Node.TEXT_NODE) {
   const t = child as Text;
   if ((t.nodeValue ?? "").trim() !== "") return t;
  } else if (child.nodeType === Node.ELEMENT_NODE) {
   const found = findLastTextNode(child);
   if (found) return found;
  }
  child = child.previousSibling;
 }
 return null;
}

/**
 * 把光标覆盖到 `host` 内最后一个非空白文本节点的末端；没有可用文本时 `display:none`。
 * 只写 `style`（left / top / display），不动任何 DOM 结构。
 */
export function positionStreamCaret(host: HTMLElement, caret: HTMLElement): void {
 const node = findLastTextNode(host);
 if (!node) {
  caret.style.display = "none";
  return;
 }
 caret.style.display = "";
 const range = document.createRange();
 range.setStart(node, (node.nodeValue ?? "").length);
 range.collapse(true);
 const rect = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
 const hostRect = host.getBoundingClientRect();
 // host 自身可能有横向滚动（overflow-x-auto）：绝对定位子节点随内容滚动，
 // 补偿 scrollLeft 才是「钉在字符右侧」的坐标。
 caret.style.left = `${Math.round((rect?.left ?? 0) - hostRect.left + host.scrollLeft)}px`;
 const caretH = caret.offsetHeight || 16;
 const lineH = rect && rect.height > 0 ? rect.height : caretH;
 caret.style.top = `${Math.round((rect?.top ?? 0) - hostRect.top + (lineH - caretH) / 2)}px`;
}
