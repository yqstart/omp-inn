// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ViewMsg } from "@shared/types";
import { useApp } from "../../stores/app";
import { ToolRow } from "./ToolRow";

/**
 * 工具行展开面板的「查看改动」：仅在有 `path` 且非 streaming 时出现；
 * 点击把 `path` 写入 store 的 `diffPath`。
 */
const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

type ToolMsg = Extract<ViewMsg, { kind: "tool" }>;

const tool = (over: Partial<ToolMsg> = {}): ToolMsg => ({
 kind: "tool",
 id: "t1",
 toolCallId: "t1",
 name: "edit",
 intent: "改文件",
 argsSummary: "src/a.ts",
 state: "ok",
 output: "",
 streamIndex: 0,
 ...over,
});

beforeEach(() => {
 useApp.setState({ diffPath: null, locale: "zh-CN" });
 container = document.createElement("div");
 document.body.append(container);
 root = createRoot(container);
});

afterEach(() => {
 act(() => root.unmount());
 container.remove();
});

function render(m: ToolMsg) {
 act(() => root.render(<ToolRow m={m} />));
}

function expand() {
 act(() => container.querySelector<HTMLButtonElement>('[aria-expanded="false"]')?.click());
}

describe("ToolRow 查看改动", () => {
 it("有 path 时出现按钮，点击写入 diffPath", () => {
  render(tool({ path: "src/a.ts" }));
  expand();
  const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "查看改动");
  expect(btn).toBeTruthy();
  act(() => btn?.click());
  expect(useApp.getState().diffPath).toBe("src/a.ts");
 });

 it("无 path 时不出现按钮", () => {
  render(tool());
  expand();
  expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "查看改动")).toBe(false);
 });

 it("streaming 时即便有 path 也不出现", () => {
  render(tool({ path: "src/a.ts", state: "streaming" }));
  expand();
  expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "查看改动")).toBe(false);
 });
});
