import { api } from "@shared/api";
import { useApp } from "../stores/app";

/** 在途的默认档读取（单飞：App 启动与思考档菜单共用同一次）。 */
let inflight: Promise<string | null> | null = null;

/**
 * 读 omp 的「默认思考等级」（`get_default_thinking_level` → `omp config get defaultThinkingLevel --json`）。
 *
 * 壳侧思考档兜底的唯一来源：真值缺失 / 对新模型非法时显示与下发的都是它（夹到模型支持集）。
 * 已有值直接命中（`force` 强制重读）；读失败返回 `null` 且**不写 store**——显示层退回最高档兜底，
 * 下一次调用（打开菜单等）自然重试。`null` 既可能是「配置未设置」也可能是「还没读到」，
 * 两者在显示层的处理一致（最高档）。
 */
export function ensureOmpDefaultThinking(force = false): Promise<string | null> {
  const cur = useApp.getState().ompDefaultThinking;
  if (cur && !force) return Promise.resolve(cur);
  if (!inflight) {
    inflight = api
      .getDefaultThinkingLevel()
      .then((level) => {
        useApp.setState({ ompDefaultThinking: level });
        return level;
      })
      .catch(() => null)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
