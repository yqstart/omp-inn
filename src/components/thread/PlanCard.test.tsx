// @vitest-environment jsdom
/**
 * 任务清单浮卡（v3，贴底宽卡）渲染与开合回归：
 * - 无清单不渲染；**首次出现默认收起**（代码刚建好清单时不铺满消息列）；
 * - 展开态列出阶段与任务（状态符号 + 阻塞说明）；
 * - 头部行 = 开合开关（折叠态只留头部行：标题 + 统计；点它展开）；
 * - 统计文案为「未完成档位」口径（进行中 / 待处理 / 受阻；全完成给完成计数）；
 * - 全部完成自动折成头部行（同一份清单只折一次——手动再展开不被再次折叠）；
 * - 高度上报（Thread 靠它给消息流底部留白）：挂载即上报一次，退场回报 0。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TodoPhase } from "@shared/types";
import { useApp } from "../../stores/app";
import { PlanCard } from "./PlanCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];
afterEach(() => {
 act(() => {
  roots.splice(0).forEach((r) => r.unmount());
 });
 document.body.innerHTML = "";
});

const PHASES: TodoPhase[] = [
 {
  name: "实现",
  tasks: [
   { content: "已完成的项", status: "completed" },
   { content: "进行中的项", status: "in_progress" },
   { content: "待办项", status: "pending" },
  ],
 },
];

function mount(onHeightChange?: (h: number) => void) {
 const container = document.createElement("div");
 document.body.appendChild(container);
 const root = createRoot(container);
 roots.push(root);
 act(() => {
  root.render(onHeightChange ? createElement(PlanCard, { onHeightChange }) : createElement(PlanCard));
 });
 return container;
}

function seed(plans: Record<string, TodoPhase[]>, card: Record<string, "expanded" | "collapsed">) {
 act(() => {
  useApp.setState({ activeSessionId: "s1", locale: "zh-CN", plansBySession: plans, planCardBySession: card, planDismissedBySession: {} });
 });
}

describe("任务清单浮卡（PlanCard）", () => {
 it("无清单不渲染", () => {
  seed({}, {});
  expect(mount().textContent).toBe("");
 });

 it("首次出现默认收起：只留头部行，点头部行才展开", () => {
  seed({}, {});
  const c = mount();
  // 走真实写入面（applyPlans 首次出现写默认档）
  act(() => {
   useApp.getState().applyPlans("s1", PHASES);
  });
  expect(useApp.getState().planCardBySession["s1"]).toBe("collapsed");
  expect(c.textContent).toContain("任务");
  expect(c.textContent).toContain("1 进行中 · 1 待处理");
  expect(c.textContent).not.toContain("已完成的项");
  const head = c.querySelector<HTMLButtonElement>('button[title="展开任务清单"]')!;
  act(() => {
   head.click();
  });
  expect(useApp.getState().planCardBySession["s1"]).toBe("expanded");
  expect(c.textContent).toContain("已完成的项");
 });

 it("展开态列出阶段、任务、阻塞说明与统计", () => {
  seed(
   {
    s1: [{ name: "阶段", tasks: [{ content: "卡住项", status: "blocked", blocker: "等上游修复" }] }],
   },
   { s1: "expanded" },
  );
  const c = mount();
  expect(c.textContent).toContain("任务");
  expect(c.textContent).toContain("1 受阻");
  expect(c.textContent).toContain("阶段");
  expect(c.textContent).toContain("卡住项");
  expect(c.textContent).toContain("等上游修复");
  expect(c.textContent).toContain("⊘");
 });

 it("折叠态只留头部行（标题 + 未完成档位统计），点头部行展开", () => {
  seed({ s1: PHASES }, { s1: "collapsed" });
  const c = mount();
  expect(c.textContent).toContain("任务");
  expect(c.textContent).toContain("1 进行中 · 1 待处理");
  expect(c.textContent).not.toContain("已完成的项");
  const head = c.querySelector<HTMLButtonElement>('button[title="展开任务清单"]')!;
  act(() => {
   head.click();
  });
  expect(useApp.getState().planCardBySession["s1"]).toBe("expanded");
  expect(c.textContent).toContain("已完成的项");
  // 展开后头部行仍是同一个开合开关：再点回去
  const head2 = c.querySelector<HTMLButtonElement>('button[title="收起"]')!;
  act(() => {
   head2.click();
  });
  expect(useApp.getState().planCardBySession["s1"]).toBe("collapsed");
 });

 it("全部完成自动折成头部行；手动再展开不被再次折叠", () => {
  seed(
   {
    s1: [{ name: "阶段", tasks: [{ content: "甲", status: "completed" }, { content: "乙", status: "completed" }] }],
   },
   { s1: "expanded" },
  );
  const c = mount();
  expect(useApp.getState().planCardBySession["s1"]).toBe("collapsed");
  expect(c.textContent).toContain("2 已完成");
  expect(c.textContent).not.toContain("甲");
  // 用户手动再展开看完成清单：不再被自动折叠打扰
  const head = c.querySelector("button")!;
  act(() => {
   head.click();
  });
  expect(useApp.getState().planCardBySession["s1"]).toBe("expanded");
  expect(c.textContent).toContain("甲");
 });

 it("高度上报：挂载上报、退场回报 0", () => {
  const onHeightChange = vi.fn();
  seed({}, {});
  mount(onHeightChange);
  expect(onHeightChange).toHaveBeenCalledWith(0);
  onHeightChange.mockClear();
  seed({ s1: PHASES }, { s1: "expanded" });
  expect(onHeightChange).toHaveBeenCalled();
 });
});
