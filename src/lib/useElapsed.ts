import { useEffect, useRef, useState } from "react";

/**
 * 秒级「走字」计时（V38）：active 期间每 0.5s 刷新一次自挂载起的已用秒数，
 * 停表后冻结在最后一次读数——运行中的工具行 / 思考块 / 「思考中…」指示行
 * 因此有「还在推进」的活体感（Codex 状态行的 Working (0:12) 同款信号）。
 *
 * 口径：start 取组件挂载（第一次进入 active）时刻。从历史打开的已完成行永远
 * 不 active、不会走字；回放中的历史数据也没有可信起点，不假装有。
 */
export function useElapsedSeconds(active: boolean): number {
 const [secs, setSecs] = useState(0);
 const start = useRef<number | null>(null);
 useEffect(() => {
  if (!active) return;
  if (start.current == null) start.current = Date.now();
  const origin = start.current;
  const tick = () => setSecs(Math.floor((Date.now() - origin) / 1000));
  tick();
  const id = window.setInterval(tick, 500);
  return () => window.clearInterval(id);
 }, [active]);
 return secs;
}

/** 秒数 → 紧凑显示：`12s`；满一分钟起 `1:05`（与 Codex 状态行的 `0:12` 同形）。 */
export function formatElapsed(secs: number): string {
 if (secs < 60) return `${secs}s`;
 const m = Math.floor(secs / 60);
 return `${m}:${String(secs % 60).padStart(2, "0")}`;
}
