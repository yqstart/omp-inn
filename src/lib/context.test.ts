import { describe, expect, it } from "vitest";
import { resolveContext } from "./context";
import type { ProjectView, SessionView } from "@shared/types";

const project = (id: string, path: string): ProjectView => ({
  id,
  path,
  name: id,
  missing: false,
  sessionCount: 0,
  workspaceId: null,
});

const session = (id: string, projectId: string | null, cwd: string): SessionView => ({
  id,
  projectId,
  title: id,
  cwd,
  timestamp: 0,
  archived: false,
  corrupt: false,
  note: null,
  running: false,
});

const projects = [project("a", "/work/a"), project("b", "/work/b")];

describe("resolveContext", () => {
  it("会话归属即上下文（不再有左栏 activeProjectId 兜底）", () => {
    const got = resolveContext(projects, [session("s1", "a", "/work/a")], "s1");
    expect(got.project?.id).toBe("a");
    expect(got.cwd).toBe("/work/a");
  });

  it("会话未归属时显示未归属", () => {
    const got = resolveContext(projects, [session("s1", null, "/tmp/loose")], "s1");
    expect(got.project).toBeNull();
    expect(got.cwd).toBe("/tmp/loose");
  });

  it("没有会话时给空上下文（上下文条据此整条不渲染）", () => {
    const got = resolveContext(projects, [], null);
    expect(got.project).toBeNull();
    expect(got.cwd).toBe("");
  });

  it("会话 cwd 为空才退回项目路径", () => {
    const got = resolveContext(projects, [session("s1", "a", "")], "s1");
    expect(got.cwd).toBe("/work/a");
  });

  it("什么都没有时给空上下文", () => {
    const got = resolveContext([], [], null);
    expect(got.project).toBeNull();
    expect(got.cwd).toBe("");
  });
});
