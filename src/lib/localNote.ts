import type { ViewMsg } from "@shared/types";
import { useApp } from "../stores/app";

/**
 * 会话内反馈：往消息流尾追加一条本地 `command` 行（灰字代码区，与 omp 命令输出同款）。
 * 单次调用 = 一条消息；id 带时间戳与随机后缀，避免同一毫秒内多次调用撞 id。
 * （原 `Composer` 内的 `localNote` 与顶栏导出回执共用这一份。）
 */
export function appendLocalNote(sid: string, text: string) {
 useApp.getState().appendEvents(sid, [
  { kind: "command", id: `lc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, output: text } as ViewMsg,
 ]);
}
