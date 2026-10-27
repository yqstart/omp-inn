// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { OmpUpdate } from "@shared/types";
import { SILENT_MIN_INTERVAL_MS, appendOmpUpdateLine, deriveOmpUpdate, deriveOmpUpdateError, reduceOmpUpdateRun, shouldCheckSilently } from "./ompUpdate";

vi.mock("@shared/api", () => ({ api: { checkOmpUpdate: vi.fn() } }));

const idle: OmpUpdate = { status: "idle", current: null, latest: null, channel: null, message: null, checkedAt: null };
const stale: OmpUpdate = { status: "latest", current: "18.3.5", latest: null, channel: "stable", message: null, checkedAt: 1_000 };

describe("omp 更新检查状态（纯函数）", () => {
  it("有新版本 → available（原样带出当前 / 最新 / 渠道，时间戳由调用方给）", () => {
    const s = deriveOmpUpdate({ current: "18.3.5", latest: "18.4.2", channel: "stable" }, 42);
    expect(s).toEqual({ status: "available", current: "18.3.5", latest: "18.4.2", channel: "stable", message: null, checkedAt: 42 });
  });

  it("没有新版本 → latest（上游的成功输出之二，latest 为 null）", () => {
    const s = deriveOmpUpdate({ current: "18.3.5", latest: null, channel: "canary" }, 7);
    expect(s.status).toBe("latest");
    expect(s.latest).toBeNull();
    expect(s.channel).toBe("canary");
    expect(s.checkedAt).toBe(7);
  });

  it("失败 → error：保留上一轮的当前版本与渠道，清掉旧结论（别把旧结论当现状）", () => {
    const prev: OmpUpdate = { status: "available", current: "18.3.5", latest: "18.4.2", channel: "stable", message: null, checkedAt: 1 };
    const s = deriveOmpUpdateError(prev, "TypeError: Unable to connect.", 9);
    expect(s).toEqual({ status: "error", current: "18.3.5", latest: null, channel: "stable", message: "TypeError: Unable to connect.", checkedAt: 9 });
  });

  it("静默检查的重入门槛：没查过跑、正在查不重入、结果还新就跳过、过期再跑", () => {
    expect(shouldCheckSilently(idle, 0, SILENT_MIN_INTERVAL_MS)).toBe(true);
    expect(shouldCheckSilently({ ...stale, status: "checking" }, 10 ** 9, SILENT_MIN_INTERVAL_MS)).toBe(false);
    expect(shouldCheckSilently({ ...stale, checkedAt: 1_000 }, 1_000 + SILENT_MIN_INTERVAL_MS - 1, SILENT_MIN_INTERVAL_MS)).toBe(false);
    expect(shouldCheckSilently(stale, 1_000 + SILENT_MIN_INTERVAL_MS, SILENT_MIN_INTERVAL_MS)).toBe(true);
    // 失败的轮次也算「查过了」：短间隔内的静默检查不会因为上一次失败就猛打网络
    expect(shouldCheckSilently({ ...stale, status: "error" }, 1_000 + 1, SILENT_MIN_INTERVAL_MS)).toBe(false);
  });
});

describe("执行更新（omp update）的前端状态", () => {
  it("日志追加有上限（丢最老的）且不改原数组", () => {
    const lines = ["a", "b", "c"];
    expect(appendOmpUpdateLine(lines, "d", 3)).toEqual(["b", "c", "d"]);
    expect(lines).toEqual(["a", "b", "c"]);
    expect(appendOmpUpdateLine([], "x", 1)).toEqual(["x"]);
    expect(appendOmpUpdateLine(["x"], "y", 1)).toEqual(["y"]);
  });

  it("事件归约：line 追加日志；exit 落终态并保留日志与「更新前版本」", () => {
    let run = reduceOmpUpdateRun(null, { type: "line", text: "$ omp update" });
    expect(run).toEqual({ phase: "running", lines: ["$ omp update"], from: null, to: null, error: null, startedAt: null });
    run = reduceOmpUpdateRun({ ...run, startedAt: 1_000 }, { type: "line", text: "Downloading…" });
    expect(run.lines).toEqual(["$ omp update", "Downloading…"]);
    run = reduceOmpUpdateRun(run, { type: "exit", outcome: { phase: "failed", from: "18.3.5", error: "boom" } });
    expect(run).toEqual({
      phase: "failed",
      lines: ["$ omp update", "Downloading…"],
      from: "18.3.5",
      to: null,
      error: "boom",
      startedAt: 1_000,
    });
  });

  it("事件归约：成功终态不带错误，更新后版本留空等健康检查回填", () => {
    const run = reduceOmpUpdateRun(null, { type: "exit", outcome: { phase: "done", from: "18.3.5", error: null } });
    expect(run).toEqual({ phase: "done", lines: [], from: "18.3.5", to: null, error: null, startedAt: null });
  });
});
