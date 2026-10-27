import { createElement, type ReactElement } from "react";
import { DecoratorNode, type EditorConfig, type LexicalNode, type NodeKey, type SerializedLexicalNode } from "lexical";
import { ReferenceChip } from "./ReferenceChip";

/**
 * 输入框里的一次 `@引用`：**原子装饰节点**（照 DeepSeek Harness 的 `ReferenceChipNode`）。
 *
 * 为什么是 decorator 而不是一段文本：引用要作为一个整体存在——方向键一步跨过、Backspace 整块删除、
 * 显示的是短标签（`@components/`）而**序列化出去的是完整相对路径**（`@src/views/…/components/`），
 * 两者宽度不同也不会错位（渲染归 React，文本归 Lexical，各管各的）。
 *
 * 序列化口径：`getTextContent()` 返回 `@<真路径>`（不带尾斜杠之外的修饰），chip 前后的空格由
 * 普通文本节点承载——所以「编辑器全文」就等于「发给 omp 的 prompt」，不需要再走一遍改写。
 */
export type ReferenceChipPayload = {
 /** 会话目录内的相对路径（跨项目时是绝对路径）：发给 omp 的形态。 */
 path: string;
 /** 显示用的短标签（最短唯一后缀）。 */
 label: string;
 isDir: boolean;
};

type SerializedReferenceChip = SerializedLexicalNode & ReferenceChipPayload;

export class ReferenceChipNode extends DecoratorNode<ReactElement> {
 __path: string;
 __label: string;
 __isDir: boolean;

 static getType(): string {
  return "omp-reference-chip";
 }

 static clone(node: ReferenceChipNode): ReferenceChipNode {
  return new ReferenceChipNode(
   { path: node.__path, label: node.__label, isDir: node.__isDir },
   node.__key,
  );
 }

 static importJSON(json: SerializedReferenceChip): ReferenceChipNode {
  return new ReferenceChipNode({ path: json.path, label: json.label, isDir: json.isDir });
 }

 constructor(payload: ReferenceChipPayload, key?: NodeKey) {
  super(key);
  this.__path = payload.path;
  this.__label = payload.label;
  this.__isDir = payload.isDir;
 }

 exportJSON(): SerializedReferenceChip {
  return {
   ...super.exportJSON(),
   type: ReferenceChipNode.getType(),
   version: 1,
   path: this.__path,
   label: this.__label,
   isDir: this.__isDir,
  };
 }

 /** 宿主元素：一段内联、不可编辑的空壳，React 面由 decorator portal 挂进来。 */
 createDOM(_config: EditorConfig): HTMLElement {
  const el = document.createElement("span");
  el.setAttribute("contenteditable", "false");
  return el;
 }

 updateDOM(): false {
  return false;
 }

 isInline(): true {
  return true;
 }

 /** 不做「选中态中间站」：方向键一步跨过、Backspace 整块删掉（旧 textarea 的占位语义）。 */
 isKeyboardSelectable(): false {
  return false;
 }

 /** 序列化形态 = 发给 omp 的形态（真路径，不是短标签）；目录补尾斜杠，读作「这是个目录」。 */
 getTextContent(): string {
  return this.__isDir ? `@${this.__path}/` : `@${this.__path}`;
 }

 payload(): ReferenceChipPayload {
  const latest = this.getLatest();
  return { path: latest.__path, label: latest.__label, isDir: latest.__isDir };
 }

 decorate(): ReactElement {
  const latest = this.getLatest();
  return createElement(ReferenceChip, { label: latest.__label, isDir: latest.__isDir });
 }
}

/** 新建一枚 chip（只在 `editor.update()` 里调用）。 */
export function $createReferenceChipNode(payload: ReferenceChipPayload): ReferenceChipNode {
 return new ReferenceChipNode(payload);
}

/** chip 类型守卫。 */
export function $isReferenceChipNode(node: LexicalNode | null | undefined): node is ReferenceChipNode {
 return node instanceof ReferenceChipNode;
}
