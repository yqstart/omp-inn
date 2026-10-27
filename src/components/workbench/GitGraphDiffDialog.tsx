import { useEffect, useState } from "react";
import { api } from "@shared/api";
import { useText } from "../../lib/useText";
import { DiffText } from "../git/DiffText";
import { DialogShell } from "../settings/DialogShell";

/** 图谱里能打开的 diff：历史提交内的文件，或工作区未提交的文件。 */
export type GitGraphDiffTarget =
 | { kind: "commit"; cwd: string; hash: string; path: string }
 | { kind: "working"; cwd: string; path: string; absPath: string };

type Loaded = {
 /** 请求的稳定键（target 变 = 重新取数；不靠 effect 里清状态避免陈旧内容闪一下）。 */
 key: string;
 text: string;
 truncated: boolean;
 untracked: boolean;
 none: boolean;
 error: string | null;
};

/**
 * 右栏 Git 图谱的 diff 弹窗。
 *
 * - 提交内文件走 `git_commit_diff`（仓库根相对路径；合并提交按第一个父提交）；
 * - 未提交文件走 `git_file_diff`（与消息列「查看改动」同一条通路，含未跟踪全文）。
 *
 * 只读：弹窗不提供编辑 / 暂存 / 回滚。长 diff 有上限（后端截断），界面明说被截断。
 */
export function GitGraphDiffDialog({ target, onClose }: { target: GitGraphDiffTarget; onClose: () => void }) {
 const t = useText();
 const key =
  target.kind === "commit"
   ? `commit\0${target.cwd}\0${target.hash}\0${target.path}`
   : `working\0${target.cwd}\0${target.absPath}`;
 const [loaded, setLoaded] = useState<Loaded | null>(null);

 useEffect(() => {
  let alive = true;
  const fail = (error: unknown) => {
   if (alive) setLoaded({ key, text: "", truncated: false, untracked: false, none: false, error: String(error) });
  };
  void (async () => {
   if (target.kind === "commit") {
    const r = await api.gitCommitDiff(target.cwd, target.hash, target.path);
    if (alive) {
     setLoaded({ key, text: r.text, truncated: r.truncated, untracked: false, none: r.kind === "none", error: null });
    }
    return;
   }
   const r = await api.gitFileDiff(target.absPath);
   if (!alive) return;
   if (r.kind === "error") {
    setLoaded({ key, text: "", truncated: false, untracked: false, none: false, error: r.error ?? r.text });
   } else {
    setLoaded({
     key,
     text: r.text,
     truncated: false,
     untracked: r.kind === "untracked",
     none: r.kind === "none",
     error: null,
    });
   }
  })().catch(fail);
  return () => {
   alive = false;
  };
 // target 的内容全部进了 key；不把 target 对象当依赖（父组件每次渲染都会新建）
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [key]);

 const seen = loaded?.key === key ? loaded : null;
 const loading = !seen;
 const title = target.kind === "commit" ? t.graphDiffTitle : t.diffTitle;

 return (
  <DialogShell title={title} onClose={onClose} width="max-w-5xl">
   <div className="space-y-3">
    <div className="truncate font-mono text-[12px] text-muted" title={target.path}>
     {target.path}
     {target.kind === "commit" && <span className="ml-2 text-faint">{target.hash.slice(0, 7)}</span>}
    </div>
    {loading && <div className="text-[13px] text-muted">{t.diffLoading}</div>}
    {!loading && seen?.error && (
     <div className="space-y-1 text-[13px]">
      <div className="text-danger">{t.diffFailed}</div>
      <div className="font-mono text-[11px] break-words text-muted">{seen.error}</div>
     </div>
    )}
    {!loading && seen && !seen.error && seen.none && (
     <div className="text-[13px] text-muted">
      {target.kind === "commit" ? t.graphDiffEmpty : t.diffNoChange}
     </div>
    )}
    {!loading && seen && !seen.error && !seen.none && (
     <div className="space-y-1">
      {seen.untracked && <div className="text-[12px] text-warn">{t.diffUntracked}</div>}
      <pre className="max-h-[65vh] overflow-auto rounded-md bg-code p-3 font-mono text-xs leading-5 whitespace-pre">
       <DiffText text={seen.text} kind={seen.untracked ? "untracked" : "diff"} />
      </pre>
      {seen.truncated && <div className="text-[11px] text-warn">{t.graphDiffTruncated}</div>}
     </div>
    )}
   </div>
  </DialogShell>
 );
}
