import { describe, expect, it } from "vitest";
import { groupSessionsByProject } from "./sessions";
import type { ProjectView, SessionView } from "@shared/types";

const proj = (id: string, path: string): ProjectView => ({
  id,
  path,
  name: path.split("/").pop() ?? path,
  missing: false,
  sessionCount: 0,
  workspaceId: null,
});

const sess = (id: string, projectId: string | null, archived: boolean): SessionView => ({
  id,
  projectId,
  title: id,
  cwd: "",
  timestamp: 0,
  archived,
  corrupt: false,
  note: null,
  running: false,
});

describe("groupSessionsByProject", () => {
  it("会话按 projectId 落到各自项目组", () => {
    const { groups, orphanActive } = groupSessionsByProject(
      [proj("p1", "/a"), proj("p2", "/b")],
      [sess("s1", "p1", false), sess("s2", "p2", false)],
    );
    expect(groups[0].active.map((s) => s.id)).toEqual(["s1"]);
    expect(groups[1].active.map((s) => s.id)).toEqual(["s2"]);
    expect(orphanActive).toEqual([]);
  });

  it("归档与进行中在组内分开", () => {
    const { groups } = groupSessionsByProject(
      [proj("p1", "/a")],
      [sess("s1", "p1", false), sess("s2", "p1", true)],
    );
    expect(groups[0].active.map((s) => s.id)).toEqual(["s1"]);
    expect(groups[0].archived.map((s) => s.id)).toEqual(["s2"]);
  });

  it("对不上项目的进未归属组", () => {
    const { groups, orphanActive } = groupSessionsByProject(
      [proj("p1", "/a")],
      [sess("s1", null, false), sess("s2", "px", false)],
    );
    expect(groups[0].active).toEqual([]);
    expect(orphanActive.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  });
});
