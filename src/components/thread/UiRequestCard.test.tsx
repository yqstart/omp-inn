// @vitest-environment jsdom
/**
 * UiRequestCard 的 `ask` 多问题卡（V40，对齐 zcode 提问卡 + 超时自动继续）：
 * - 多问题各成一区（header 小标题 + question 正文），选项按单选 radio / 多选 checkbox 语义，
 *   推荐下标项带角标；
 * - 单选时自定义输入与选项互斥（输入即清掉已选项），多选时二者并存；
 * - 提交组装 `answers = questions.map(...)`（空 customInput 不发该字段）后调 respondUi(kind:"answers")，
 *   成功进已答态（收起表单）；
 * - timeout 倒计时 mm:ss，每秒刷新（到 0 只停表，omp 侧自行按推荐项继续）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewMsg } from "@shared/types";
import { useApp } from "../../stores/app";
import { UiRequestCard } from "./UiRequestCard";

const mock = vi.hoisted(() => ({ respondUi: vi.fn(async () => undefined) }));
vi.mock("@shared/api", () => ({ api: { respondUi: mock.respondUi } }));

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnv.IS_REACT_ACT_ENVIRONMENT = true;

type UiMsg = Extract<ViewMsg, { kind: "ui" }>;

let container: HTMLDivElement;
let root: Root;

/** jsdom 没有 scrollIntoView（组件挂载即调用），补一个空实现。 */
beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};
  mock.respondUi.mockClear();
  useApp.setState({ locale: "zh-CN", statusBySession: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const mount = async (m: UiMsg) => {
  await act(async () => {
    root.render(<UiRequestCard m={m} sessionId="s1" />);
  });
};

const askMsg = (over: Partial<UiMsg> = {}): UiMsg =>
  ({
    kind: "ui",
    id: "e1",
    uiId: "u1",
    method: "ask",
    title: "需要你的选择",
    questions: [],
    ...over,
  }) as UiMsg;

const btnByText = (text: string) =>
 [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(text))!;

const TWO_Q: UiMsg = askMsg({
  questions: [
    {
      id: "q1",
      header: "运行环境",
      question: "部署到哪个环境？",
      options: [{ label: "生产" }, { label: "预发" }, { label: "本地" }],
      recommended: 0,
    },
    {
      id: "q2",
      question: "要跑哪些检查？",
      options: [{ label: "lint" }, { label: "typecheck" }],
      multi: true,
    },
  ],
});

describe("UiRequestCard · ask", () => {
  it("多问题各成一区，推荐项带角标、多选带提示", async () => {
    await mount(TWO_Q);
    const html = container.innerHTML;
    expect(html).toContain("运行环境");
    expect(html).toContain("部署到哪个环境？");
    expect(html).toContain("要跑哪些检查？");
    expect(html).toContain("推荐");
    expect(html).toContain("可多选");
    // 第二题是复选语义
    expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(2);
    expect(container.querySelectorAll('[role="radio"]')).toHaveLength(3);
  });

  it("单选提交：answers 形状正确（selectedOptions 数组、无 customInput）", async () => {
    await mount(TWO_Q);
    await act(async () => {
      btnByText("预发").click();
      btnByText("typecheck").click();
    });
    await act(async () => {
      btnByText("提交").click();
    });
    expect(mock.respondUi).toHaveBeenCalledTimes(1);
    expect(mock.respondUi).toHaveBeenCalledWith("s1", "u1", "answers", {
      answers: [
        { id: "q1", selectedOptions: ["预发"] },
        { id: "q2", selectedOptions: ["typecheck"] },
      ],
    });
    expect(container.innerHTML).toContain("已回答");
  });

  it("多选 + 自定义文本并存（selectedOptions 与 customInput 同时带上）", async () => {
    await mount(
      askMsg({
        questions: [
          {
            id: "q1",
            question: "要跑哪些检查？",
            options: [{ label: "lint" }, { label: "typecheck" }],
            multi: true,
          },
        ],
      }),
    );
    await act(async () => {
      btnByText("lint").click();
      btnByText("typecheck").click();
    });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="要跑哪些检查？"]')!;
    await act(async () => {
      // 受控 input：用 native setter 触发 React 的 onChange
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "  再加一条  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      btnByText("提交").click();
    });
    expect(mock.respondUi).toHaveBeenCalledWith("s1", "u1", "answers", {
      answers: [{ id: "q1", selectedOptions: ["lint", "typecheck"], customInput: "再加一条" }],
    });
  });

  it("单选时自定义输入清掉已选选项（互斥）", async () => {
    await mount(TWO_Q);
    await act(async () => {
      btnByText("生产").click();
    });
    const input = container.querySelectorAll("input")[0];
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "灰度环境");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      btnByText("提交").click();
    });
    expect(mock.respondUi).toHaveBeenCalledWith("s1", "u1", "answers", {
      answers: [
        { id: "q1", selectedOptions: [], customInput: "灰度环境" },
        { id: "q2", selectedOptions: [] },
      ],
    });
  });

  it("timeout 显示 mm:ss 倒计时并每秒刷新", async () => {
    vi.useFakeTimers();
    await mount(askMsg({ questions: TWO_Q.questions, timeout: 65_000 }));
    expect(container.innerHTML).toContain("剩余 01:05 后自动继续");
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.innerHTML).toContain("剩余 01:04 后自动继续");
    // 逐秒推进到 0：只停表（倒计时消失），不自行回包
    for (let i = 0; i < 64; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(container.innerHTML).not.toContain("后自动继续");
    expect(mock.respondUi).not.toHaveBeenCalled();
  });

  it("提交失败保留表单可重试", async () => {
    mock.respondUi.mockRejectedValueOnce(new Error("boom"));
    await mount(TWO_Q);
    await act(async () => {
      btnByText("提交").click();
    });
    expect(container.innerHTML).toContain("boom");
    expect(container.innerHTML).not.toContain("已回答");
    // 再次提交成功 → 进已答态
    await act(async () => {
      btnByText("提交").click();
    });
    expect(container.innerHTML).toContain("已回答");
  });
});
