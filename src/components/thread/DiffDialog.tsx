import { useEffect, useState } from "react";
import { api } from "@shared/api";
import { useText } from "../../lib/useText";
import { useApp } from "../../stores/app";
import { DiffText } from "../git/DiffText";
import { DialogShell } from "../settings/DialogShell";

type DiffResult =
 | { kind: "diff"; text: string }
 | { kind: "untracked"; text: string }
 | { kind: "none"; text: string }
 | { kind: "error"; text: string; error?: string };

/**
 * 工具卡「查看改动」弹窗（DiffDialog）。
 *
 * 数据来自后端 `git_file_diff`（相对 HEAD 的该文件统一 diff，或未跟踪文件全文）。
 * 开关是 store 的 `diffPath`（null = 关闭），`diffPath` 变化时重取。
 * 着色只按行首前缀：`+` 新增 / `-` 删除 / `@@` 区块 / 头部元信息 / 其余上下文——
 * 逐行 `<pre>` 等宽，颜色之外行首符号本身就是信号，不作唯一信号。
 */
export function DiffDialog() {
 const t = useText();
 const path = useApp((s) => s.diffPath);
 const setDiffPath = useApp((s) => s.setDiffPath);

 const [loaded, setLoaded] = useState<{ path: string; result: DiffResult } | null>(null);
 // 与 ContextMeter / 统计弹窗同一模式：`seen` / `loading` 派生，effect 里只异步 setState。
 const seen = loaded?.path === path;
 const result = seen ? loaded.result : null;
 const loading = !!path && !seen;

 useEffect(() => {
  if (!path) return;
  let alive = true;
  const p = path;
  void api
   .gitFileDiff(p)
   .then((r) => {
    if (alive) setLoaded({ path: p, result: r });
   })
   .catch((e: unknown) => {
    if (alive) setLoaded({ path: p, result: { kind: "error", text: "", error: e instanceof Error ? e.message : String(e) } });
   });
  return () => {
   alive = false;
  };
 }, [path]);

 if (!path) return null;

 let shown: { kind: "diff" | "untracked"; text: string } | null = null;
 if (result && (result.kind === "diff" || result.kind === "untracked")) shown = result;

 return (
  <DialogShell title={t.diffTitle} onClose={() => setDiffPath(null)} width="max-w-3xl">
   <div className="space-y-3">
    <div className="truncate font-mono text-[12px] text-muted" title={path}>
     {path}
    </div>
    {loading && <div className="text-[13px] text-muted">{t.diffLoading}</div>}
    {!loading && result?.kind === "none" && <div className="text-[13px] text-muted">{t.diffNoChange}</div>}
    {!loading && result?.kind === "error" && (
     <div className="space-y-1 text-[13px]">
      <div className="text-danger">{t.diffFailed}</div>
      {result.error && <div className="font-mono text-[11px] text-muted">{result.error}</div>}
     </div>
    )}
    {!loading && shown && (
     <div className="space-y-1">
      {shown.kind === "untracked" && <div className="text-[12px] text-warn">{t.diffUntracked}</div>}
      <pre className="max-h-[60vh] overflow-auto rounded-md bg-code p-3 font-mono text-xs leading-5 whitespace-pre">
       <DiffText text={shown.text} kind={shown.kind} />
      </pre>
     </div>
    )}
   </div>
  </DialogShell>
 );
}
