import { THINKING_ORDER } from "./thinking";

/**
 * 模型 selector（`provider/modelId`）与 **思考档后缀** 的拆合。
 *
 * omp 的 selector 可以带一个思考档后缀（`provider/model:high`），三处用到它：
 * 角色值（`modelRoles`）、失败转移链的条目（`retry.fallbackChains`）、以及会话内
 * `set_model` 之后的思考档。
 *
 * **只在 `:` 后面那段是已知档位时才拆**（`THINKING_ORDER`：off/minimal/low/medium/
 * high/xhigh/max，不含 `auto`——omp 会把 `auto` 解析成具体档，不保留）：
 * 模型 id 本身允许出现别的冒号（`provider/foo:beta`），拿「最后一个冒号」硬切会把 id 切坏。
 * 拆不出来就原样当裸 selector，宁可少认也不误改。
 */

/** 拆出模型部分与思考档后缀（没有后缀时 `level` 为 null，`base` 原样）。 */
export function splitSelector(sel: string): { base: string; level: string | null } {
  const i = sel.lastIndexOf(":");
  // i <= 0：没有冒号，或冒号在开头（`:high` 这种没有模型部分的不是合法 selector）
  if (i <= 0 || i === sel.length - 1) return { base: sel, level: null };
  const tail = sel.slice(i + 1);
  if (!(THINKING_ORDER as readonly string[]).includes(tail)) return { base: sel, level: null };
  return { base: sel.slice(0, i), level: tail };
}

/** 拼回 selector：`level` 为空时写裸 selector（= 交给 omp 自己的默认档）。 */
export function joinSelector(base: string, level: string | null | undefined): string {
  return level ? `${base}:${level}` : base;
}

/** 只换档位、保留模型部分（`level = null` 即摘掉后缀）。 */
export function withLevel(sel: string, level: string | null): string {
 return joinSelector(splitSelector(sel).base, level);
}

/**
 * selector 是否属于某个供应商：比较第一个 `/` 前的供应商段（`provider/model-id`）。
 * 模型 id 本身可以含 `/`（`commandcode/meta/…`），所以不能拿整串前缀当判据；
 * 供应商通配 `provider/*` 同样命中。空 providerId 一律不匹配。
 */
export function selectorBelongsToProvider(selector: string, providerId: string): boolean {
 const id = providerId.trim();
 if (!id) return false;
 return selector.trim().startsWith(`${id}/`);
}
