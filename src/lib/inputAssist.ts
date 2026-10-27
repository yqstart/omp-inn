/**
 * 关掉壳内输入框的系统「输入提示」（V33）。
 *
 * 背景：app 跑在 macOS 的 WKWebView 里，凡是没有显式关掉的 `input` / `textarea` /
 * `[contenteditable]`，系统都会按 macOS 的文本设置施加一套输入辅助——拼写检查（红波浪线 +
 * 建议气泡，候选里常是大写 / 连字符变体）、句首自动大写、智能标点替换、自动填充建议。
 * 壳内全是技术输入（路径 / 命令 / 提交信息），这些提示一律不要（用户实测：
 * 「输入英文字母总是提示我大写、横杠」）。
 *
 * 手段：给每个可编辑元素设置 WebKit 认的四个属性，并同时覆盖「现在就有」与「以后插入」
 * 的元素（MutationObserver；设置页 / 弹层里后挂载的输入框也走这条路）：
 * - `spellcheck=false`：拼写检查（实测还能关掉 WKWebView 的智能引号替换，SO #31455617）；
 * - `autocorrect=off`：自动纠正 / 建议气泡（SO #63926407）；
 * - `autocapitalize=off`：句首自动大写；
 * - `autocomplete=off`：系统自动填充建议。
 *
 * 约定（V33 起）：组件不再各自写 `spellCheck={false}` / `autoComplete="off"`——那套散装属性
 * 已随本模块上线一并删除。`aria-autocomplete` 是无障碍属性（读屏提示），不在管辖范围。
 */

/** 四个属性与值：WebKit 与 Chromium 都认，非 macOS 上同样成立、无害。 */
const ASSIST_ATTRS: ReadonlyArray<readonly [string, string]> = [
 ["spellcheck", "false"],
 ["autocorrect", "off"],
 ["autocapitalize", "off"],
 ["autocomplete", "off"],
];

/** 需要装饰的元素：所有可编辑输入（输入框 / 文本域 / 富文本）。 */
const EDITABLE_SELECTOR = "input, textarea, [contenteditable]";

/** 逐个补齐四个属性；已是目标值就不动（不产生多余的 mutation 记录）。 */
function decorate(el: Element): void {
 for (const [name, value] of ASSIST_ATTRS) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
 }
}

/** 装饰一棵子树里所有可编辑元素（含根自身）。 */
function sweep(root: ParentNode): void {
 if (root instanceof Element && root.matches(EDITABLE_SELECTOR)) decorate(root);
 for (const el of root.querySelectorAll(EDITABLE_SELECTOR)) decorate(el);
}

/**
 * 启动时调用一次；返回卸载函数（测试用）。
 * 除插入外还盯着四个属性本身被清掉的情况——`attributeFilter` 收窄到这四个，
 * 不拖累高频样式变更的元素。
 */
export function installInputAssistOff(doc: Document = document): () => void {
 sweep(doc);
 const observer = new MutationObserver((records) => {
  for (const r of records) {
   if (r.type === "attributes") {
    if (r.target instanceof Element && r.target.matches(EDITABLE_SELECTOR)) decorate(r.target);
    continue;
   }
   for (const node of r.addedNodes) {
    if (node instanceof Element) sweep(node);
   }
  }
 });
 observer.observe(doc.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ASSIST_ATTRS.map(([name]) => name),
 });
 return () => observer.disconnect();
}
