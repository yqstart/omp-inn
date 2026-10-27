// @vitest-environment jsdom
/**
 * Thread 渲染冒烟（jsdom + createRoot，与浏览器同路径）：
 * 内联一组真实形状的 jsonl 行 → viewMsgsFromJsonlLines → 渲染整棵 Thread，
 * 断言不崩、且用户消息与工具行的关键内容出现。
 *
 * 为什么要有这条：`打开已有会话 → 历史落库 → 渲染` 是"右侧不显示"类问题的
 * 唯一端到端覆盖（jsdom 是这两条测试的测试环境依赖，见 THIRD-PARTY-NOTICES）。
 */
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ViewMsg } from "@shared/types";
import { THREAD_PAGE, useApp } from "../../stores/app";
import { viewMsgsFromJsonlLines } from "../../lib/viewmsg";
import { TEXT } from "../../lib/locale";
import { Thread } from "./Thread";

/**
 * 渲染树的任何 IPC 调用都不该真发命令：`@shared/api` 一律换成兜底替身
 * （未登记的键返回 null，够组件走完渲染分支）。
 */
const { apiMock } = vi.hoisted(() => ({ apiMock: {} as Record<string, unknown> }));
vi.mock("@shared/api", () => ({
 api: new Proxy(apiMock, { get: (t, k) => (k in t ? (t as Record<string, unknown>)[k as string] : async () => null) }),
}));

// 让 React 的 act(...) 在 jsdom 下进入"测试环境"模式（消除 "not configured" 警告）
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// jsdom 没实现 Range.getBoundingClientRect（划选浮条靠它定位），补一个全 0 矩形：
// 组件的坐标有「越界往回收」的钳制，全 0 也能算出合法位置（左上角附近的浮条）。
if (!("getBoundingClientRect" in Range.prototype)) {
 Object.assign(Range.prototype, {
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 }),
 });
}

/** 真实形状的 jsonl 行（与 omp 会话文件同构的裁剪：user 正文 / 思考 / 工具调用 / 工具结果 / 标题）。 */
const JSONL_LINES = [
 { type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "你好" }] } },
 {
  type: "message",
  id: "m2",
  message: {
   role: "assistant",
   content: [
    { type: "thinking", thinking: "先看看目录" },
    { type: "text", text: "我来跑一下" },
    { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" }, intent: "列出目录" },
   ],
  },
 },
 { type: "message", id: "m3", message: { role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text: "a.txt" }] } },
 { type: "title_change", id: "t1", title: "冒烟会话" },
];

describe("Thread 渲染", () => {
 it("历史行转 ViewMsg 后整树渲染不崩，关键内容出现", async () => {
  const msgs = viewMsgsFromJsonlLines(JSONL_LINES, TEXT["zh-CN"]);
  useApp.setState({
   eventsBySession: { "s-render": msgs },
   activeSessionId: "s-render",
   sessions: [
    { id: "s-render", projectId: "p1", title: "t", cwd: "/tmp", updatedAt: 0, archived: false, missing: false } as never,
   ],
   projects: [{ id: "p1", name: "p", path: "/tmp" } as never],
   threadLimitSid: "s-render",
   threadLimit: THREAD_PAGE,
  });
  const errors: unknown[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: (e) => errors.push(e) });
  await act(async () => {
   root.render(createElement(Thread));
  });
  const html = container.innerHTML;
  expect(errors).toHaveLength(0);
  expect(html).toContain("你好");
  expect(html).toContain("bash");
  await act(async () => {
   root.unmount();
  });
 });
});

/**
 * 流式「思考中…」指示行：状态是 running 且流尾**没有**「正在输出」的行时补一条
 * （慢模型从发送到首个 delta 可能几十秒到几分钟，此前那段时间消息列里什么都没有
 * ——用户看到的就是「发送文字后无任何反应」）。
 */
describe("流式「思考中…」指示", () => {
 /** 挂载 Thread（与冒烟测试同一套 store 装置），返回容器与根。 */
 const mount = async (msgs: ViewMsg[], state?: "running" | "idle") => {
  useApp.setState({
   eventsBySession: { "s-ind": msgs },
   activeSessionId: "s-ind",
   statusBySession: state ? { "s-ind": { state } } : {},
   sessions: [
    { id: "s-ind", projectId: "p1", title: "t", cwd: "/tmp", updatedAt: 0, archived: false, missing: false } as never,
   ],
   projects: [{ id: "p1", name: "p", path: "/tmp" } as never],
   threadLimitSid: "s-ind",
   threadLimit: THREAD_PAGE,
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
   root.render(createElement(Thread));
  });
  return { container, root };
 };
 const indicator = TEXT[useApp.getState().locale].thinking;

 it("运行中且流尾没有活行时补一条（工具跑完在等模型的间隙也补）——但要等一小段才露面", async () => {
  const base = viewMsgsFromJsonlLines(JSONL_LINES, TEXT["zh-CN"]);
  const { container, root } = await mount(base, "running");
  // 防闪（V46）：刚进入空窗的一两帧不挂指示行（段与段之间的短暂间隙不该闪一下）
  expect(container.innerHTML).not.toContain(indicator);
  await act(async () => {
   await new Promise((r) => setTimeout(r, 400));
  });
  expect(container.innerHTML).toContain(indicator);
  await act(async () => {
   root.unmount();
  });
 });

 it("流尾是流式文本 / 运行中的工具卡时不补（界面本来就在动）", async () => {
  const streaming: ViewMsg[] = [{ kind: "text", id: "t1", seq: 0, text: "半句", complete: false }];
  const a = await mount(streaming, "running");
  expect(a.container.innerHTML).not.toContain(indicator);
  await act(async () => {
   a.root.unmount();
  });

  const runningTool: ViewMsg[] = [
   { kind: "tool", id: "tool:tc9", toolCallId: "tc9", name: "bash", intent: "", argsSummary: "ls", state: "running", output: "", streamIndex: 0 },
  ];
  const b = await mount(runningTool, "running");
  expect(b.container.innerHTML).not.toContain(indicator);
  await act(async () => {
   b.root.unmount();
  });
 });

 it("不在运行（idle / 未知状态）时不渲染指示", async () => {
  const base = viewMsgsFromJsonlLines(JSONL_LINES, TEXT["zh-CN"]);
  const a = await mount(base, "idle");
  expect(a.container.innerHTML).not.toContain(indicator);
  await act(async () => {
   a.root.unmount();
  });
  const b = await mount(base);
  expect(b.container.innerHTML).not.toContain(indicator);
  await act(async () => {
   b.root.unmount();
  });
 });
});

/**
 * 消息行锚点（⌘F 会话内查找靠它把命中定位回消息行）。
 */
describe("消息行 data-msg-id", () => {
 const SID = "s-msgid";

 const mountMsgIds = async (msgs: ViewMsg[]) => {
  useApp.setState({
   eventsBySession: { [SID]: msgs },
   activeSessionId: SID,
   statusBySession: {},
   sessions: [
    { id: SID, projectId: "p1", title: "t", cwd: "/tmp", updatedAt: 0, archived: false, missing: false } as never,
   ],
   projects: [{ id: "p1", name: "p", path: "/tmp" } as never],
   threadLimitSid: SID,
   threadLimit: THREAD_PAGE,
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
   root.render(createElement(Thread));
  });
  return { container, root };
 };

 it("每条消息行带 data-msg-id（⌘F 定位挂钩）", async () => {
  const { container, root } = await mountMsgIds([
   { kind: "user", id: "m1", text: "你好", mentions: [] },
   { kind: "text", id: "a1", seq: 0, text: "答", complete: true },
  ]);
  expect(container.querySelector('[data-msg-id="m1"]')).not.toBeNull();
  expect(container.querySelector('[data-msg-id="a1"]')).not.toBeNull();
  await act(async () => {
   root.unmount();
  });
 });
});

/** 一条 user 正文行（划选用例的最小消息）。 */
const userMsg = (id: string, text: string): ViewMsg => ({ kind: "user", id, text, mentions: [] });

/**
 * V40 划选浮条：划中消息列里的正文 → 选区上方浮出「引用到输入框 / 旁问」。
 * 「引用」把选中文本转成 `> ` 引用块追加进草稿（旧草稿非空时空一行隔开）。
 */
describe("划选浮条", () => {
 const SID = "s-sel";

 const mountWithSelection = async (draft: string) => {
  useApp.setState({
   eventsBySession: { [SID]: [userMsg("m1", "你好世界")] },
   activeSessionId: SID,
   statusBySession: {},
   sessions: [
    { id: SID, projectId: "p1", title: "t", cwd: "/tmp", updatedAt: 0, archived: false, missing: false } as never,
   ],
   projects: [{ id: "p1", name: "p", path: "/tmp" } as never],
   threadLimitSid: SID,
   threadLimit: THREAD_PAGE,
   drafts: { [SID]: draft },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
   root.render(createElement(Thread));
  });
  return { container, root };
 };

 /** 在容器内的气泡正文上造一个真实选区，再派发 mouseup（与浏览器同路径）。 */
 const select = async (container: HTMLElement) => {
  const bubble = container.querySelector('[data-msg-id="m1"] .whitespace-pre-wrap');
  expect(bubble).not.toBeNull();
  const range = document.createRange();
  range.selectNodeContents(bubble!);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  await act(async () => {
   container.querySelector('[role="log"]')?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
 };

 it("引用到输入框：选中文本转成 `> ` 引用块追加进草稿", async () => {
  const { container, root } = await mountWithSelection("旧草稿");
  await select(container);
  const quote = container.querySelector(`button[aria-label="${TEXT[useApp.getState().locale].selQuote}"]`);
  expect(quote).not.toBeNull();
  await act(async () => {
   quote?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(useApp.getState().draftOf(SID)).toBe("旧草稿\n\n> 你好世界\n\n");
  // 动作执行后浮条关闭
  expect(container.querySelector(`button[aria-label="${TEXT[useApp.getState().locale].selQuote}"]`)).toBeNull();
  await act(async () => {
   root.unmount();
  });
 });

 it("无选区不显示浮条", async () => {
  const { container, root } = await mountWithSelection("");
  window.getSelection()?.removeAllRanges();
  await act(async () => {
   container.querySelector('[role="log"]')?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  expect(container.querySelector(`button[aria-label="${TEXT[useApp.getState().locale].selQuote}"]`)).toBeNull();
  await act(async () => {
   root.unmount();
  });
 });
});

/**
 * 摘要式表达（v2 §2.1）的端到端：`jsonl → ViewMsg → buildThreadLayout → 渲染`。
 * 单测（`lib/threadLayout.test.ts`）覆盖纯函数，这里盖「真的进了 DOM」这一段。
 */
describe("Thread 摘要式表达（v2）", () => {
 const SID2 = "s-v2";

 const mountV2 = async (lines: unknown[]) => {
  const msgs = viewMsgsFromJsonlLines(lines, TEXT["zh-CN"]);
  useApp.setState({
   locale: "zh-CN",
   eventsBySession: { [SID2]: msgs },
   activeSessionId: SID2,
   statusBySession: {},
   sessions: [{ id: SID2, projectId: "p1", title: "t", cwd: "/tmp", timestamp: 0, archived: false, corrupt: false, note: null, running: false }],
   projects: [{ id: "p1", name: "p", path: "/tmp" } as never],
   threadLimitSid: SID2,
   threadLimit: THREAD_PAGE,
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
   root.render(createElement(Thread));
  });
  return { container, root };
 };

 const BASH_ROUND = [
  { type: "message", id: "u1", timestamp: "2026-10-14T03:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "跑两条命令" }] } },
  { type: "message", id: "m1", timestamp: "2026-10-14T03:00:05.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] } },
  { type: "message", id: "r1", timestamp: "2026-10-14T03:00:06.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "a.txt" }] } },
  { type: "message", id: "m2", timestamp: "2026-10-14T03:00:07.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "pwd" } }] } },
  { type: "message", id: "r2", timestamp: "2026-10-14T03:00:08.000Z", message: { role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "/tmp" }] } },
  { type: "message", id: "m3", timestamp: "2026-10-14T03:02:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "跑完了" }] } },
 ];

 it("相邻两条 bash 折叠成「运行了 2 条命令」，展开才逐条显示；轮时长行收在轮末", async () => {
  const { container, root } = await mountV2(BASH_ROUND);
  // 折叠行在：摘要文案出现
  expect(container.textContent).toContain("运行了 2 条命令");
  // 折叠态不出现逐条命令
  expect(container.textContent).not.toContain("ls");
  expect(container.textContent).not.toContain("pwd");
  // 轮时长行（03:00:00 → 03:02:00 = 120s）
  expect(container.textContent).toContain("用时 2:00");

  const runBtn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("运行了 2 条命令"));
  expect(runBtn?.getAttribute("aria-expanded")).toBe("false");
  await act(async () => {
   runBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  // 展开后逐条工具行出现
  expect(container.textContent).toContain("ls");
  expect(container.textContent).toContain("pwd");
  await act(async () => {
   root.unmount();
  });
 });

 it("相邻两条写 / 改折叠成编辑卡：文件行 + 行级增量", async () => {
  const { container, root } = await mountV2([
   { type: "message", id: "u1", timestamp: "2026-10-14T03:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "改两个文件" }] } },
   { type: "message", id: "m1", timestamp: "2026-10-14T03:00:01.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "w1", name: "write", arguments: { path: "/tmp/a.ts", content: "1\n2\n3" } }] } },
   { type: "message", id: "m2", timestamp: "2026-10-14T03:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "/tmp/b.ts", old_string: "x", new_string: "y\nz" } }] } },
  ]);
  expect(container.textContent).toContain("编辑了 2 个文件");
  expect(container.textContent).toContain("a.ts");
  expect(container.textContent).toContain("b.ts");
  // 行级增量：write 3 行 + edit 2 行 = +5；edit 移除 1 行
  expect(container.textContent).toContain("+5");
  expect(container.textContent).toContain("−1");
  await act(async () => {
   root.unmount();
  });
 });

 it("单条 bash 不聚合（避免「运行了 1 条命令」的假摘要），保持原样一行", async () => {
  const { container, root } = await mountV2([
   { type: "message", id: "u1", timestamp: "2026-10-14T03:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "跑一条" }] } },
   { type: "message", id: "m1", timestamp: "2026-10-14T03:00:01.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls -la" } }] } },
   { type: "message", id: "r1", timestamp: "2026-10-14T03:00:02.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "ok" }] } },
  ]);
  expect(container.textContent).not.toContain("运行了 1 条命令");
  expect(container.textContent).toContain("ls -la");
  await act(async () => {
   root.unmount();
  });
 });
});

/**
 * V47 回底按钮 / V49 贴底判定：消息列滚离底部（> NEAR_BOTTOM_PX）时，在视口底部中央浮出
 * 向下箭头；点击 = 瞬时读底 + 恢复跟随（按钮收起）；切会话重置离底状态。
 * jsdom 没有真实布局：`scrollHeight` / `clientHeight` / `scrollTop` 用 defineProperty 摆成
 * 可控值（scrollTop 的 setter 按浏览器口径钳到底），滚动位置靠手工派发的 scroll 事件驱动；
 * 三个高度都可继续改（`grow` / `shrinkView`）——「内容长高」与「视口变矮」是两回事。
 */
describe("回到底部按钮与贴底跟随（V47 / V49）", () => {
 const SID = "s-bottom";
 /** 视口 / 内容高（测试里的假布局）：贴底线 = scrollTop 600，离底 80px = scrollTop 520。 */
 const VIEW = 400;
 const CONTENT = 1000;

 const mount = async () => {
  const msgs = viewMsgsFromJsonlLines(JSONL_LINES, TEXT["zh-CN"]);
  useApp.setState({
   locale: "zh-CN",
   eventsBySession: { [SID]: msgs },
   activeSessionId: SID,
   statusBySession: { [SID]: { state: "idle" } },
   sessions: [
    { id: SID, projectId: "p1", title: "t", cwd: "/tmp", updatedAt: 0, archived: false, missing: false } as never,
   ],
   projects: [{ id: "p1", name: "p", path: "/tmp" } as never],
   threadLimitSid: SID,
   threadLimit: THREAD_PAGE,
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
   root.render(createElement(Thread));
  });
  // 挂载 effect 会排双 rAF 读底；CI 慢时它会晚于下面的假布局 / 用户上翻执行，
  // 把位置重新拽回底部，表现为偶发「expected 1000 to be 300」。等它跑完再摆布局。
  await act(async () => {
   await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
   });
  });
  const scroller = container.querySelector(".thread-scroll") as HTMLElement;
  let high = CONTENT;
  let view = VIEW;
  let top = CONTENT - VIEW;
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => view });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => high });
  Object.defineProperty(scroller, "scrollTop", {
   configurable: true,
   get: () => top,
   set: (v: number) => {
    top = Math.max(0, Math.min(v, high - view));
   },
  });
  // 摆好假布局后先对齐一次真实基线：开会话本来就滚到底（挂载时的双 rAF 读底用的是
  // jsdom 的真实 0 值，不补这一下，后面的「用户上翻」会比在一个陈旧基线之上）。
  scroller.scrollTop = CONTENT - VIEW;
  await act(async () => {
   scroller.dispatchEvent(new Event("scroll"));
  });
  return {
   container,
   root,
   scroller,
   /** 内容长高（流式追加 / 新行落下）：scrollTop 不动，距底随之变大。 */
   grow: (by: number) => {
    high += by;
   },
   /** 视口变矮（输入框长高 / 查找条 / 健康横幅 / 窗口缩放）：**不派发 scroll 事件**（与浏览器一致）。 */
   shrinkView: (by: number) => {
    view -= by;
   },
  };
 };
 /** 追加一条消息（与真实帧落 store 同路径：`events` 换引用 → 跟随 effect 跑一次）。 */
 const append = async (id: string) => {
  await act(async () => {
   useApp.getState().appendEvents(SID, [{ kind: "text", id, seq: 0, text: "继续输出", complete: false }]);
  });
 };

 const byLabel = (container: HTMLElement, label: string) => container.querySelector(`button[aria-label="${label}"]`);

 /** 滚到指定位置并派发 scroll（与浏览器同路径：onScroll 里做粘性判定）。 */
 const scrollTo = async (scroller: HTMLElement, top: number) => {
  scroller.scrollTop = top;
  await act(async () => {
   scroller.dispatchEvent(new Event("scroll"));
  });
 };

 it("离底露面、点击读底并收起（阈值与粘性判定同源：79px 内仍算贴底）", async () => {
  const { container, root, scroller } = await mount();
  const label = TEXT[useApp.getState().locale].scrollToBottom;

  await scrollTo(scroller, CONTENT - VIEW - 79);
  expect(byLabel(container, label)).toBeNull();
  await scrollTo(scroller, CONTENT - VIEW - 80);
  expect(byLabel(container, label)).not.toBeNull();

  await act(async () => {
   byLabel(container, label)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(scroller.scrollTop).toBe(CONTENT - VIEW); // 读到底
  expect(byLabel(container, label)).toBeNull(); // 贴底即收起

  await act(async () => {
   root.unmount();
  });
 });

 it("视口变矮（输入框长高 / 查找条 / 窗口缩放）不释放跟随（V49）", async () => {
  const { container, root, scroller, shrinkView } = await mount();
  const label = TEXT[useApp.getState().locale].scrollToBottom;
  // 先在贴底状态下走一帧（真实会话里基线总被上一条消息 / RO 对上）
  await append("a-warm");
  expect(scroller.scrollTop).toBe(CONTENT - VIEW);
  expect(byLabel(container, label)).toBeNull();

  // 视口变矮 100px：旧口径按「距底 > 本次长高 + 8px」对账，这里距底凭空多出 100px 就被判成
  // 「用户滚开了」，跟随当场死亡；且视口变矮不派发 scroll 事件，onScroll 也救不回来。
  shrinkView(100);
  await append("a-more");

  expect(scroller.scrollTop).toBe(CONTENT - (VIEW - 100)); // 仍贴底
  expect(byLabel(container, label)).toBeNull();
  await act(async () => {
   root.unmount();
  });
 });

 it("用户上翻后内容继续长高，不把视口拽回底部（释放仍然成立）", async () => {
  const { container, root, scroller, grow } = await mount();
  const label = TEXT[useApp.getState().locale].scrollToBottom;
  await scrollTo(scroller, CONTENT - VIEW - 300);
  const parked = scroller.scrollTop;
  expect(byLabel(container, label)).not.toBeNull();

  grow(400);
  await append("a-more");

  expect(scroller.scrollTop).toBe(parked); // 停在用户看的位置
  expect(byLabel(container, label)).not.toBeNull();
  await act(async () => {
   root.unmount();
  });
 });

 it("切会话重置离底状态：新会话贴底，按钮不残留", async () => {
  const { container, root, scroller } = await mount();
  const label = TEXT[useApp.getState().locale].scrollToBottom;
  await scrollTo(scroller, 0);
  expect(byLabel(container, label)).not.toBeNull();

  // Thread 常驻挂载（只切 store 里的会话），按钮必须跟着会话重置
  const other = viewMsgsFromJsonlLines(JSONL_LINES, TEXT["zh-CN"]);
  await act(async () => {
   useApp.setState({
    eventsBySession: { [SID]: [], "s-bottom-2": other },
    activeSessionId: "s-bottom-2",
    sessions: [
     { id: "s-bottom-2", projectId: "p1", title: "t2", cwd: "/tmp", updatedAt: 0, archived: false, missing: false } as never,
    ],
    threadLimitSid: "s-bottom-2",
    threadLimit: THREAD_PAGE,
   });
  });
  expect(byLabel(container, label)).toBeNull();

  await act(async () => {
   root.unmount();
  });
 });
});

/**
 * 轮次定位轨（2026-10-21，DeepSeek Harness 的 TurnNavigator 形态）：
 * 每个用户消息一道刻度、当前读到的那一轮带 `aria-current`、点击未加载轮次先放历史页。
 * jsdom 没有真实布局（scrollHeight / clientHeight 恒 0）——按组件口径这就是「贴底」，
 * 所以默认高亮落在最新一轮；阅读线的几何口径由 `lib/turnRail.test` 覆盖。
 */
describe("轮次定位轨", () => {
 const SID = "s-turn-rail";
 const TURNS: ViewMsg[] = [
  { kind: "user", id: "u1", text: "第一个问题", mentions: [] },
  { kind: "text", id: "t1", seq: 0, text: "第一轮回答", complete: true },
  { kind: "user", id: "u2", text: "第二个问题", mentions: [] },
  { kind: "text", id: "t2", seq: 0, text: "第二轮回答", complete: true },
 ];

 const mount = async (msgs: ViewMsg[], limit = THREAD_PAGE) => {
  useApp.setState({
   locale: "zh-CN",
   eventsBySession: { [SID]: msgs },
   activeSessionId: SID,
   statusBySession: { [SID]: { state: "idle" } },
   sessions: [
    { id: SID, projectId: "p1", title: "t", cwd: "/tmp", updatedAt: 0, archived: false, missing: false } as never,
   ],
   projects: [{ id: "p1", name: "p", path: "/tmp" } as never],
   threadLimitSid: SID,
   threadLimit: limit,
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
   root.render(createElement(Thread));
  });
  return { container, root };
 };

 const railOf = (container: HTMLElement) => container.querySelector(`nav[aria-label="${TEXT["zh-CN"].turnRailLabel}"]`);

 it("每条用户消息一道刻度：用户行带 data-turn，贴底时高亮最新一轮", async () => {
  const { container, root } = await mount(TURNS);
  const rail = railOf(container);
  expect(rail).not.toBeNull();
  const marks = rail!.querySelectorAll("button[data-turn]");
  expect([...marks].map((m) => m.getAttribute("data-turn"))).toEqual(["1", "2"]);
  expect(marks[0].getAttribute("aria-label")).toBe("跳转到第 1 轮");
  expect(marks[1].getAttribute("aria-current")).toBe("true");
  // 锚点在消息列里（不是轨上的按钮）：跳轮 / 阅读线都靠它
  const anchors = container.querySelectorAll(".thread-scroll [data-turn]");
  expect([...anchors].map((a) => a.getAttribute("data-turn"))).toEqual(["1", "2"]);
  await act(async () => {
   root.unmount();
  });
 });

 it("只有一轮时整条轨不出现（没有可跳的目标，也不占右缘点击面积）", async () => {
  const { container, root } = await mount([TURNS[0], TURNS[1]]);
  expect(railOf(container)).toBeNull();
  await act(async () => {
   root.unmount();
  });
 });

 it("更早的历史页还没展开时：刻度仍可见（标为「加载并跳转」），点击先放页再出锚点", async () => {
  // limit = 2 → 渲染窗口只含第二轮；第一轮是 unloaded 刻度
  const { container, root } = await mount(TURNS, 2);
  expect(container.querySelector('.thread-scroll [data-msg-id="u1"]')).toBeNull();
  const mark = container.querySelector(`button[aria-label="加载并跳转到第 1 轮"]`) as HTMLButtonElement | null;
  expect(mark).not.toBeNull();
  await act(async () => {
   mark!.click();
  });
  // 放页后第一轮的行真的进了 DOM（跳转由 Thread 的 layout effect 紧接着落地）
  expect(container.querySelector('.thread-scroll [data-turn="1"]')).not.toBeNull();
  expect(container.querySelector(`button[aria-label="跳转到第 1 轮"]`)).not.toBeNull();
  await act(async () => {
   root.unmount();
  });
 });
});
