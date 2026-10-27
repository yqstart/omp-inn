// @vitest-environment jsdom
/**
 * AssistantText 的分块渲染契约（V38）：mock 掉 react-markdown 记录每个块被渲染的次数——
 * 冻结前缀（source 不变）不许因尾块增长而重渲染，尾块才允许重走。
 * 光标 / 未闭合围栏骨架的显隐一并钉住。
 */
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const { sources } = vi.hoisted(() => ({ sources: [] as string[] }));
vi.mock("react-markdown", () => ({
 default: (props: { children?: unknown }) => {
  const src = String(props.children ?? "");
  sources.push(src);
  // 返回一个可查询的容器（不解析 Markdown，本测试只关心"块组件被调用几次"）
  return createElement("div", { "data-src": src });
 },
}));

import { AssistantText } from "./AssistantText";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("AssistantText 分块渲染（V38）", () => {
 it("尾块增长不重渲染冻结前缀；只有尾块重走", async () => {
  sources.length = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
   root.render(createElement(AssistantText, { text: "块一\n\n块二\n", complete: true }));
  });
  expect(sources).toEqual(["块一\n\n", "块二\n"]);
  // 尾块继续增长：冻结块（"块一\n\n"）不再被调用，只新增一次尾块渲染
  await act(async () => {
   root.render(createElement(AssistantText, { text: "块一\n\n块二\n继续", complete: true }));
  });
  expect(sources).toEqual(["块一\n\n", "块二\n", "块二\n继续"]);
  await act(async () => root.unmount());
 });

 it("文内出现链接引用定义时不分块（整段单块渲染）", async () => {
  sources.length = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const text = "看 [文档][d] 的说明\n\n[d]: https://example.com\n";
  await act(async () => {
   root.render(createElement(AssistantText, { text, complete: true }));
  });
  expect(sources).toEqual([text]);
  await act(async () => root.unmount());
 });

 it("流式光标：仅未完成且不在围栏内时渲染；未闭合围栏给骨架", async () => {
  /** 挂载一个 AssistantText（挂载即显示全量，不依赖 rAF 排帧）。
   *  本文件 mock 了 react-markdown（内容不解析），骨架 / 光标断言走容器结构。 */
  const mount = async (text: string, complete: boolean) => {
   const container = document.createElement("div");
   document.body.appendChild(container);
   const root = createRoot(container);
   await act(async () => {
    root.render(createElement(AssistantText, { text, complete }));
   });
   return { container, root };
  };
  const plain = await mount("半句", false);
  expect(plain.container.querySelector(".stream-caret")).not.toBeNull();
  expect(plain.container.querySelector('[role="status"]')).toBeNull();
  await act(async () => plain.root.unmount());
  // 围栏已开、代码还没到：骨架在、光标退场（空代码块没有可贴的位置）
  const empty = await mount("```ts\n", false);
  expect(empty.container.querySelector(".stream-caret")).toBeNull();
  expect(empty.container.querySelector('[role="status"]')).not.toBeNull();
  await act(async () => empty.root.unmount());
  // 代码开始落下：撤骨架、光标贴到最后一行代码（一个代码块不许长两个盒子）
  const open = await mount("```ts\nconst a = 1;\n", false);
  expect(open.container.querySelector(".stream-caret")).not.toBeNull();
  expect(open.container.querySelector('[role="status"]')).toBeNull();
  await act(async () => open.root.unmount());
  // 行内三个反引号不是围栏：不该出骨架（旧的「计数奇偶」会误报）
  const inline = await mount("用 ``` 包住代码", false);
  expect(inline.container.querySelector('[role="status"]')).toBeNull();
  expect(inline.container.querySelector(".stream-caret")).not.toBeNull();
  await act(async () => inline.root.unmount());
  // 完成：光标与骨架都不再渲染
  const done = await mount("```ts\nconst a = 1;\n```\n", true);
  expect(done.container.querySelector(".stream-caret")).toBeNull();
  expect(done.container.querySelector('[role="status"]')).toBeNull();
  await act(async () => done.root.unmount());
 });
});
