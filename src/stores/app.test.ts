// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { useApp } from "./app";

describe("设置视图（v1 起：覆盖主区的独立视图）", () => {
 it("openSettingsTab / closeSettingsTab：开则两态同时置位，关则同时复位", () => {
  useApp.setState({ settingsTabOpen: false, settingsTabActive: false });
  useApp.getState().openSettingsTab();
  expect(useApp.getState().settingsTabOpen).toBe(true);
  expect(useApp.getState().settingsTabActive).toBe(true);
  useApp.getState().closeSettingsTab();
  expect(useApp.getState().settingsTabOpen).toBe(false);
  expect(useApp.getState().settingsTabActive).toBe(false);
 });
});

/**
 * 队列真值（V40）：omp `queue_update` 帧与回读的落点（`applyQueue` 是唯一写入面）；
 * 会话导航栈（`pushNav` / `navStep`）、挂起重启标记、旁问面板与查找条开关一并在这里锁住。
 */
describe("队列真值与 V40 聊天域动作", () => {
 it("applyQueue / queuedOf：按会话隔离，缺省空队列", () => {
  useApp.setState({ queuedBySession: {} });
  useApp.getState().applyQueue("s1", { steering: ["a"], followUp: ["b", "c"] });
  useApp.getState().applyQueue("s2", { steering: [], followUp: ["x"] });
  expect(useApp.getState().queuedOf("s1")).toEqual({ steering: ["a"], followUp: ["b", "c"] });
  expect(useApp.getState().queuedOf("s2")).toEqual({ steering: [], followUp: ["x"] });
  expect(useApp.getState().queuedOf("nope")).toEqual({ steering: [], followUp: [] });
  expect(useApp.getState().queuedOf(null)).toEqual({ steering: [], followUp: [] });
 });

 it("pushNav / navStep：去重截断 + 前后一步（边界返回 null）", () => {
  useApp.setState({ navStack: [], navIdx: -1 });
  useApp.getState().pushNav("a");
  useApp.getState().pushNav("b");
  useApp.getState().pushNav("c");
  expect(useApp.getState().navStep(-1)).toBe("b");
  expect(useApp.getState().navStep(-1)).toBe("a");
  expect(useApp.getState().navStep(-1)).toBeNull();
  expect(useApp.getState().navStep(1)).toBe("b");
  // 导航后手动打开已存在的会话：截断到当前位置再压栈（前进历史丢弃）
  useApp.getState().pushNav("d");
  expect(useApp.getState().navStep(1)).toBeNull();
  expect(useApp.getState().navStep(-1)).toBe("b");
 });

 it("markApprovalRestart / clearApprovalRestart：按会话标记与清除", () => {
  useApp.setState({ approvalRestartBySession: {} });
  useApp.getState().markApprovalRestart("s1");
  expect(useApp.getState().approvalRestartBySession["s1"]).toBe(true);
  useApp.getState().clearApprovalRestart("s1");
  expect("s1" in useApp.getState().approvalRestartBySession).toBe(false);
  useApp.getState().clearApprovalRestart("ghost"); // no-op 不崩
 });

 it("setBtw：局部合并更新（open / sessionId / records）", () => {
  useApp.setState({ btw: { open: false, sessionId: null, records: [], busyRecordId: null, draft: "", error: null } });
  useApp.getState().setBtw({ open: true, sessionId: "s1" });
  expect(useApp.getState().btw.open).toBe(true);
  expect(useApp.getState().btw.sessionId).toBe("s1");
  expect(useApp.getState().btw.records).toEqual([]);
 });

 it("setFindOpen / setStatsOpen：开关落 store", () => {
  useApp.getState().setFindOpen(true);
  expect(useApp.getState().findOpen).toBe(true);
  useApp.getState().setFindOpen(false);
  expect(useApp.getState().findOpen).toBe(false);
  useApp.getState().setStatsOpen(true);
  expect(useApp.getState().statsOpen).toBe(true);
  useApp.getState().setStatsOpen(false);
 });
});

/**
 * 任务清单（V50）：`applyPlans` 是 `plansBySession` 的唯一写入面（todo 工具帧
 * `details.phases` + `get_state.todoPhases` 回读），`planCardBySession` 是浮卡 UI 状态。
 */
describe("任务清单：applyPlans / setPlanCard", () => {
 const P1 = [{ name: "阶段一", tasks: [{ content: "甲", status: "in_progress" }] }];

 it("首次写入默认收起；同值重写不换引用", () => {
  useApp.setState({ plansBySession: {}, planCardBySession: {} });
  useApp.getState().applyPlans("s1", P1);
  expect(useApp.getState().plansBySession["s1"]).toEqual(P1);
  expect(useApp.getState().planCardBySession["s1"]).toBe("collapsed");
  const before = useApp.getState().plansBySession;
  useApp.getState().applyPlans("s1", P1);
  // 同一个值再写（帧与回读会送两遍）：store 引用不动，不触发重渲
  expect(useApp.getState().plansBySession).toBe(before);
 });

 it("用户展开后，后续清单更新不覆盖开合状态", () => {
  useApp.setState({ plansBySession: {}, planCardBySession: {} });
  useApp.getState().applyPlans("s1", P1);
  useApp.getState().setPlanCard("s1", "expanded");
  useApp.getState().applyPlans("s1", [{ name: "阶段一", tasks: [{ content: "甲", status: "completed" }] }]);
  expect(useApp.getState().planCardBySession["s1"]).toBe("expanded");
 });

 it("空数组 = 清空（数据与浮卡状态一起删；下次计划重新默认收起）", () => {
  useApp.setState({ plansBySession: {}, planCardBySession: {} });
  useApp.getState().applyPlans("s1", P1);
  useApp.getState().applyPlans("s1", []);
  expect("s1" in useApp.getState().plansBySession).toBe(false);
  expect("s1" in useApp.getState().planCardBySession).toBe(false);
  useApp.getState().applyPlans("s1", P1);
  expect(useApp.getState().planCardBySession["s1"]).toBe("collapsed");
 });

 it("setPlanCard：同值不写（引用稳定）", () => {
  useApp.setState({ planCardBySession: {} });
  useApp.getState().setPlanCard("s1", "collapsed");
  const cards = useApp.getState().planCardBySession;
  useApp.getState().setPlanCard("s1", "collapsed");
  expect(useApp.getState().planCardBySession).toBe(cards);
 });

 /**
  * 新回合收起完成清单（2026-10-21 用户实测：上一轮「9 已完成」一直挂在新消息上方）。
  * omp 的 todo 自动清理是它自己的 UI 计时器（`tasks.todoClearDelay`），`get_state` 在窗口内
  * 仍会回读同一份完成清单——收起签名必须挡掉回读，否则浮卡会复活。
  */
 it("dismissCompletedPlans：收起全部完成的清单，挡住同签名回读，不碰未完成的", () => {
  const done = [{ name: "阶段", tasks: [{ content: "甲", status: "completed" }] }];
  const running = [{ name: "阶段", tasks: [{ content: "乙", status: "in_progress" }] }];
  useApp.setState({ plansBySession: {}, planCardBySession: {}, planDismissedBySession: {} });
  useApp.getState().applyPlans("s1", done);
  useApp.getState().dismissCompletedPlans("s1");
  expect("s1" in useApp.getState().plansBySession).toBe(false);
  expect("s1" in useApp.getState().planCardBySession).toBe(false);
  // omp 的 get_state 仍回读同一份完成清单：挡掉，不复活
  useApp.getState().applyPlans("s1", done);
  expect("s1" in useApp.getState().plansBySession).toBe(false);
  // 新清单（不同签名）正常出现，收起签名作废；默认仍是收起档
  useApp.getState().applyPlans("s1", running);
  expect(useApp.getState().plansBySession["s1"]).toEqual(running);
  expect(useApp.getState().planCardBySession["s1"]).toBe("collapsed");
  expect("s1" in useApp.getState().planDismissedBySession).toBe(false);
  // 未完成的清单不会被收起
  useApp.getState().dismissCompletedPlans("s1");
  expect(useApp.getState().plansBySession["s1"]).toEqual(running);
 });

 it("空数组清空时一并丢掉收起签名（否则以后同签名的计划会被误挡）", () => {
  const done = [{ name: "阶段", tasks: [{ content: "甲", status: "completed" }] }];
  useApp.setState({ plansBySession: {}, planCardBySession: {}, planDismissedBySession: {} });
  useApp.getState().applyPlans("s1", done);
  useApp.getState().dismissCompletedPlans("s1");
  expect(useApp.getState().planDismissedBySession["s1"]).toBeDefined();
  useApp.getState().applyPlans("s1", []);
  expect("s1" in useApp.getState().planDismissedBySession).toBe(false);
 });
});
