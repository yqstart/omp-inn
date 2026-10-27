// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DraftEditor, type DraftEditorHandle } from "./DraftEditor";

/**
 * 草稿编辑器（Lexical）：文本读写、`@引用`原子节点、光标前取词。
 * jsdom 没有布局，但 Lexical 的模型层（节点树 / selection / 序列化）是可测的——
 * 这里守的是「编辑器全文 = 发给 omp 的形态」这条口径。
 */
let container: HTMLDivElement;
let root: Root;
let ref: React.RefObject<DraftEditorHandle | null>;
let texts: string[];

beforeEach(() => {
 // jsdom 没实现 scrollIntoView（Lexical 的 selection 同步会用到）
 if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
 }
 ref = createRef<DraftEditorHandle>();
 texts = [];
 container = document.createElement("div");
 document.body.append(container);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
});

async function render(initial = "") {
 await act(async () => {
  root.render(
   <DraftEditor
    ref={ref}
    ariaLabel="输入"
    placeholder="说点什么"
    initialText={initial}
    onText={(text) => texts.push(text)}
   />,
  );
 });
}

describe("DraftEditor", () => {
 it("初始文本进得来、读得出去", async () => {
  await render("你好，世界");
  expect(ref.current?.getText()).toBe("你好，世界");
  expect(container.querySelector('[contenteditable="true"]')).not.toBeNull();
 });

 it("setText 整体替换（多行保留）", async () => {
  await render("");
  await act(async () => {
   ref.current?.setText("第一行\n第二行");
  });
  expect(ref.current?.getText()).toBe("第一行\n第二行");
 });

 it("插入引用：序列化成真路径，显示成短标签", async () => {
  await render("");
  await act(async () => {
   ref.current?.insertReference({ path: "src/views/components", label: "components", isDir: true });
  });
  // 全文 = 发给 omp 的形态（真路径 + 尾部空格）
  expect(ref.current?.getText()).toBe("@src/views/components/");
  // 屏幕上是短标签 + 图标
  const chip = container.querySelector("[data-mention-chip]");
  expect(chip?.textContent).toBe("@components/");
  expect(chip?.querySelector("img")).not.toBeNull();
 });

 it("插入引用：前面是文字时补空格，行首不补", async () => {
  await render("看看");
  await act(async () => {
   ref.current?.setText("看看");
   ref.current?.insertReference({ path: "a.ts", label: "a.ts", isDir: false });
  });
  expect(ref.current?.getText()).toBe("看看 @a.ts ");
 });

 it("replaceMention：把 `@token` 换成芯片", async () => {
  await render("");
  await act(async () => {
   ref.current?.setText("@components/");
  });
  // 光标默认落到末尾（setText 的语义）
  await act(async () => {
   ref.current?.replaceMention("components/", { path: "src/views/components", label: "components", isDir: true });
  });
  expect(ref.current?.getText()).toBe("@src/views/components/");
  expect(container.querySelector("[data-mention-chip]")?.textContent).toBe("@components/");
 });

 it("选中目录后接着打：取词把芯片的 `@dist/` 接在前面（继续往里钻）", async () => {
  await render("");
  await act(async () => {
   ref.current?.insertReference({ path: "dist", label: "dist", isDir: true });
  });
  // 目录引用不补尾空格：光标就贴在芯片后面
  expect(ref.current?.getText()).toBe("@dist/");
  await act(async () => {
   ref.current?.insertText("src");
  });
  expect(ref.current?.getText()).toBe("@dist/src");
  // 取词带上芯片那一截，补全才能列出 dist/src 下的东西
  expect(ref.current?.getTextBeforeCaret()).toBe("@dist/src");
 });

 it("目录芯片后继续打，再选中文件：连芯片一起换掉（跨节点兜底）", async () => {
  await render("");
  await act(async () => {
   // 右栏文件树注入的目录引用是芯片（补全里的目录走纯文本下钻）
   ref.current?.insertReference({ path: "dist", label: "dist", isDir: true });
  });
  await act(async () => {
   ref.current?.insertText("app");
  });
  expect(ref.current?.getTextBeforeCaret()).toBe("@dist/app");
  await act(async () => {
   ref.current?.replaceMention("dist/app", { path: "dist/app.js", label: "app.js", isDir: false });
  });
  expect(ref.current?.getText()).toBe("@dist/app.js ");
  expect(container.querySelector("[data-mention-chip]")?.textContent).toBe("@app.js");
 });

 it("文件引用仍然在空格处收口", async () => {
  await render("");
  await act(async () => {
   ref.current?.insertReference({ path: "dist/a.ts", label: "a.ts", isDir: false });
  });
  expect(ref.current?.getText()).toBe("@dist/a.ts ");
 });

 it("insertText 在光标处插入（`#N` 占位口径）", async () => {
  await render("看看");
  await act(async () => {
   ref.current?.insertText("#1");
  });
  expect(ref.current?.getText()).toBe("看看#1");
 });

 it("getTextBeforeCaret 给的是光标前那一段（补全取词）", async () => {
  await render("@baselin");
  // setText 之后光标在末尾
  expect(ref.current?.getTextBeforeCaret()).toBe("@baselin");
 });
});
