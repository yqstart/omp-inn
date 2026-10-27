import { open } from "@tauri-apps/plugin-dialog";
import { api } from "@shared/api";
import { useApp } from "../stores/app";
import { autoCheckOmpUpdate } from "./ompUpdate";
import { TEXT } from "./locale";

/**
 * omp 自检与手动指定路径（omp 更新弹窗的「omp 诊断」块 + 顶部引导横幅共用一份实现）。
 *
 * 为什么需要：GUI 启动的进程 PATH 只有 launchd 默认值，homebrew / ~/.local/bin
 * 常常不在其中——用户装了 omp 也会被判"未找到"。所以引导横幅不能只报错，
 * 必须给出「重新检测」和「指定路径」两个动作。
 *
 * 两者都只写应用自己的覆盖层（`ompPath`），不写 omp 的配置文件。
 */
export type DiagResult = { ok: true } | { ok: false; message: string };

export async function refreshOmpHealth(): Promise<DiagResult> {
 try {
  const health = await api.getHealth();
  useApp.getState().set({ health });
  // 「重新检测 omp」也在意它是不是新版：顺手静默查一次（单飞 + 冷却见 lib/ompUpdate.ts）
  if (health.omp.ompPath) void autoCheckOmpUpdate();
  return { ok: true };
 } catch (e) {
  return { ok: false, message: e instanceof Error ? e.message : TEXT[useApp.getState().locale].diagFailed };
 }
}

/** `null` = 用户取消选择。 */
export async function pickOmpExecutable(): Promise<DiagResult | null> {
 const t = TEXT[useApp.getState().locale];
 const picked = await open({ multiple: false, directory: false, title: t.pickOmpTitle });
 if (typeof picked !== "string" || !picked) return null;
 try {
  await api.setOmpPath(picked);
 } catch (e) {
  return { ok: false, message: e instanceof Error ? e.message : t.setOmpPathFailed };
 }
 return refreshOmpHealth();
}
