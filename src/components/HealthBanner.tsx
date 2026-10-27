import { FolderError, Refresh, TriangleWarning } from "reicon-react";
import { useApp } from "../stores/app";
import { useText } from "../lib/useText";
import { pickOmpExecutable, refreshOmpHealth } from "../lib/ompDiag";

export function HealthBanner() {
  const { health } = useApp();
  const t = useText();
  if (!health || health.ok) return null;
  // 标题按真实原因分：omp 找到了但模型目录拉不到，不该说"未找到可用的 omp"
  const missingOmp = !health.omp.ompPath;
  return (
    <div
      role="alert"
      className="mx-3 mt-2 flex shrink-0 flex-wrap items-start gap-2 rounded-lg border border-warn/40 bg-surface px-3.5 py-2.5 text-[13px]"
    >
      <TriangleWarning size={15} className="mt-0.5 shrink-0 text-warn" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{missingOmp ? t.healthNoOmp : t.healthModelsFailed}</div>
        <div className="text-muted">
          {(health.omp.errors[0] ?? t.healthInstallHint) +
            (health.modelsError ? `（${health.modelsError}）` : "")}
        </div>
      </div>
      {/* 引导横幅必须能修：GUI 的 PATH 常不含 homebrew 目录，只报错等于让用户去猜 */}
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          onClick={() => void refreshOmpHealth()}
          className="flex cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[13px] transition-colors duration-100 hover:bg-hover"
          aria-label={t.healthRecheckAria}
        >
          <Refresh size={12} aria-hidden />
          {t.recheck}
        </button>
        <button
          onClick={() => void pickOmpExecutable()}
          className="flex cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[13px] transition-colors duration-100 hover:bg-hover"
          aria-label={t.healthPickPathAria}
        >
          <FolderError size={12} aria-hidden />
          {t.pickPath}
        </button>
      </div>
    </div>
  );
}
