import { useEffect, useRef } from "react";

/**
 * 窗口重新获得焦点 / 从后台转回可见时跑一次 `run`。
 *
 * 2026-10-19 用户口径：设置页页头的刷新钮退场，外部改动（别的终端改了 `config.yml`、
 * 跑了 `omp config set` / `omp plugin install`）没有事件可等——这条路径补上它；切走设置
 * 页签再回来本来就会重挂重读，那是另一条。
 *
 * `run` 走 ref 取最新引用（调用方不必 memo）；只在挂载时挂监听、卸载时摘掉。
 * **只给「本地读、开销可控」的面板用**：模型目录 / 插件清单这类要跑 `omp` 子进程的页面
 * 不挂它（一次 alt-tab 就是一次秒级子进程，代价不值得）。
 */
export function useVisibleRefresh(run: () => void) {
 const latest = useRef(run);
 useEffect(() => {
  latest.current = run;
 });
 useEffect(() => {
  const onVisible = () => {
   if (!document.hidden) latest.current();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
  return () => {
   document.removeEventListener("visibilitychange", onVisible);
   window.removeEventListener("focus", onVisible);
  };
 }, []);
}
