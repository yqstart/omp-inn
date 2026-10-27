import { describe, expect, it } from "vitest";
import { TEXT } from "./locale";
import { sessionRowStatus, sessionRowStatusLabel } from "./sessionRowStatus";

describe("会话行状态档（DeepSeek Harness 口径：待处理 > 运行中 > 已完成 > 空闲）", () => {
  const st = (input: { live?: "running" | "idle" | "awaiting-approval" | "error" | "exited"; running?: boolean; unread?: boolean }) =>
    sessionRowStatus({ live: input.live, running: input.running ?? false, unread: input.unread ?? false });

  it("优先级：待处理压运行中，运行中压已完成，都不忙才算已完成", () => {
    expect(st({ live: "awaiting-approval", unread: true }), "等审批时不再标运行中 / 完成").toBe("awaiting");
    expect(st({ live: "running", unread: true }), "在跑就不标完成标").toBe("running");
    expect(st({ live: "idle", unread: true })).toBe("done");
    expect(st({ live: "idle", unread: false })).toBe("idle");
  });

  it("没有实时状态记录（没打开过的会话）：退回扫描快照的 running", () => {
    expect(st({ running: true })).toBe("running");
    expect(st({ running: true, unread: true })).toBe("running");
    expect(st({ running: false, unread: true })).toBe("done");
    expect(st({ running: false })).toBe("idle");
  });

  it("有实时状态记录时以实时状态为准，不被打开那一刻的 running 快照钉死", () => {
    expect(st({ live: "idle", running: true }), "跑完收敛 idle：不再转圈").toBe("idle");
    expect(st({ live: "idle", running: true, unread: true })).toBe("done");
  });

  it("error / exited（进程没了）不算忙，也不冒充完成", () => {
    expect(st({ live: "error" })).toBe("idle");
    expect(st({ live: "exited" })).toBe("idle");
    expect(st({ live: "exited", unread: true })).toBe("done");
  });

  it("文案：三档状态给中文 / 英文标签，空闲档不给（不渲染状态点）", () => {
    const zh = TEXT["zh-CN"];
    const en = TEXT.en;
    expect(sessionRowStatusLabel("awaiting", zh)).toBe(zh.statusAwaiting);
    expect(sessionRowStatusLabel("running", zh)).toBe(zh.statusRunning);
    expect(sessionRowStatusLabel("done", zh)).toBe(zh.statusDone);
    expect(sessionRowStatusLabel("idle", zh)).toBeNull();
    expect(sessionRowStatusLabel("awaiting", en)).toBe(en.statusAwaiting);
    expect(sessionRowStatusLabel("idle", en)).toBeNull();
  });
});
