/**
 * 测试环境补齐（`vite.config.ts` 的 `test.setupFiles`）。
 *
 * jsdom 缺几个浏览器 API，而运行时代码（Lexical）会真的调用它们——缺了就是
 * 「Unhandled Error」，测试看着全绿但 `pnpm check` 会挂。
 */

// jsdom 没有 `ClipboardEvent`：Lexical 的 plain-text 粘贴处理会 `new ClipboardEvent(...)`
// （`@lexical/plain-text` 的 PASTE_COMMAND），一粘贴就 ReferenceError。
if (typeof globalThis.ClipboardEvent === "undefined") {
 class ClipboardEventPolyfill extends Event {
  readonly clipboardData: DataTransfer | null;

  constructor(type: string, init?: { clipboardData?: DataTransfer | null } & EventInit) {
   super(type, init);
   this.clipboardData = init?.clipboardData ?? null;
  }
 }

 globalThis.ClipboardEvent = ClipboardEventPolyfill as unknown as typeof ClipboardEvent;
}
