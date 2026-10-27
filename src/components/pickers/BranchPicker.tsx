import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, DiagramTree, Loader, Refresh } from "reicon-react";
import { api } from "@shared/api";
import { useApp } from "../../stores/app";
import { fmt } from "../../lib/locale";
import { refreshWorkspaceGitState } from "../../lib/commitTasks";
import { useDropdown } from "../../lib/useDropdown";
import { useText } from "../../lib/useText";
import type { GitInfo } from "@shared/types";

/**
 * 输入卡内顶行的 git 分支指示器（截图右侧那个）：指示 + **切换**。
 *
 * - 收起态：分支名（detached HEAD 显示短 sha + 「游离」角标）；有未提交改动时带一个
 *   warn 圆点，切分支前能一眼看到。
 * - 展开态：本地分支清单（当前分支置顶并打勾）+ 手动刷新；**点分支即切换**
 *   （`git switch <branch>`）——脏工作区交给 git 裁决：不冲突就带着走，冲突整条拒绝，
 *   错误原文就地显示在浮层里；壳侧不做 stash / force 代劳。
 * - 切换成功：走 `refreshWorkspaceGitState([cwd])`（统一刷新入口——它自增 `gitInfoSeq`，
 *   同目录的全部 git 查询一起重读，ahead / behind 快照同步刷新）。
 */
export function BranchPicker({
  git,
  cwd,
  loading,
  onReload,
}: {
  git: GitInfo;
  cwd: string;
  loading: boolean;
  onReload: () => void;
}) {
  const { composerMenu } = useApp();
  const t = useText();
  const open = composerMenu === "branch";
  const setOpen = useCallback(
    (v: boolean) => useApp.setState({ composerMenu: v ? "branch" : null }),
    [],
  );
  const ref = useDropdown(open, () => setOpen(false));
  const label = git.branch ?? (git.detached ? t.detachedHead : t.unknownBranch);
  /** 正在切换的目标分支；非 null 时清单整体锁住（防连点）。 */
  const [switching, setSwitching] = useState<string | null>(null);
  /** 上一次切换失败的 git 原文（就地显示在浮层顶部）。 */
  const [error, setError] = useState<string | null>(null);

  // 打开即取最新：用户多半刚在终端里切完分支
  useEffect(() => {
    if (open) onReload();
  }, [open, onReload]);

  const switchTo = async (b: string) => {
    if (switching) return;
    // 点当前分支 = 收起浮层（与项目选择器同口径，不重复动作）
    if (b === git.branch) {
      setOpen(false);
      return;
    }
    setSwitching(b);
    setError(null);
    try {
      await api.switchBranch(cwd, b);
      // 统一刷新入口：它同时自增 `gitInfoSeq`（同目录的 `useGitInfo` 一起重读，分支名与
      // 脏点立刻跟上）并刷新 ahead / behind 快照。
      void refreshWorkspaceGitState([cwd]);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSwitching(null);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => {
          setError(null);
          setOpen(!open);
        }}
        className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 py-1 whitespace-nowrap text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground"
        aria-label={fmt(t.branchAria, label)}
        aria-expanded={open}
        title={`${label}${git.dirty ? t.dirtySuffix : ""}`}
      >
        <DiagramTree size={13} aria-hidden className="shrink-0 opacity-70" />
        <span className="whitespace-nowrap font-mono">{label}</span>
        {git.detached && (
          <span className="shrink-0 rounded bg-warn/15 px-1 text-[10px] text-warn">{t.detachedBadge}</span>
        )}
        {git.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden />}
        <ChevronDown size={14} aria-hidden className="shrink-0 opacity-60" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-10 mb-1 max-h-72 w-64 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-border bg-elevated p-2 shadow-pop">
          <div className="flex items-center gap-2 px-1 pb-1.5">
            <span className="flex-1 text-[11px] text-muted">{t.localBranches}</span>
            <button
              onClick={onReload}
              disabled={loading || switching !== null}
              className="cursor-pointer rounded p-1 text-muted transition-colors duration-100 hover:bg-hover hover:text-foreground disabled:opacity-50"
              aria-label={t.refreshGit}
              title={t.refreshGit}
            >
              <Refresh size={12} className={loading ? "animate-spin" : ""} aria-hidden />
            </button>
          </div>
          {error && (
            <div
              role="alert"
              className="mb-1 max-h-24 overflow-y-auto rounded bg-danger/10 px-2 py-1 font-mono text-[11px] whitespace-pre-wrap text-danger"
            >
              {error}
            </div>
          )}
          {git.dirty && (
            <div className="mb-1 rounded bg-warn/10 px-2 py-1 text-[11px] text-warn">
              {t.dirtyWarning}
            </div>
          )}
          {git.branches.map((b) => {
            const current = b === git.branch;
            const busy = switching === b;
            return (
              <button
                key={b}
                onClick={() => void switchTo(b)}
                disabled={!current && switching !== null}
                className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left transition-colors duration-100 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40 ${
                  current ? "text-foreground" : "text-muted"
                }`}
                aria-label={current ? undefined : fmt(t.switchToBranchAria, b)}
                aria-current={current ? "true" : undefined}
              >
                {busy ? (
                  <Loader size={12} aria-hidden className="shrink-0 animate-spin" />
                ) : (
                  <Check size={12} aria-hidden className={`shrink-0 ${current ? "opacity-100" : "opacity-0"}`} />
                )}
                <span className="truncate font-mono text-xs">{b}</span>
              </button>
            );
          })}
          {git.branches.length === 0 && (
            <div className="px-2 py-1 text-[13px] text-muted">{t.noBranches}</div>
          )}
          <div className="px-1 pt-1.5 text-[11px] text-faint">{t.branchFoot}</div>
        </div>
      )}
    </div>
  );
}
