import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "reicon-react";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Components } from "react-markdown";
import { fmt } from "../../lib/locale";
import { isRemoteClient } from "@shared/remote";
import { useText } from "../../lib/useText";
import { positionStreamCaret } from "../../lib/streamCaret";
import { splitMarkdownBlocks, openFenceState } from "../../lib/mdBlocks";
import { useRevealedText } from "../../lib/streamReveal";

/**
 * Assistant 正文渲染（MASTER §8 组件名 `AssistantText`）。
 *
 * - Markdown 走 `react-markdown`：默认不渲染原始 HTML（无 `dangerouslySetInnerHTML`），
 *   内容来自本地 omp 会话文件，仍然按不可信输入处理。
 * - 代码高亮走 `rehype-highlight`（highlight.js 的 lowlight），配色在 `src/index.css`
 *   用项目 token 定义，深浅色各一套，不额外引第三方主题 CSS。
 * - **平滑揭示（V38）**：显示量走 `useRevealedText`——成块到达的文本按帧铺开，
 *   连续小增量零滞后、`complete` 立即全量（口径见 `lib/streamReveal.ts`）。
 * - **分块渲染（V38）**：揭示后的文本按 `splitMarkdownBlocks` 切成「冻结前缀 + 活跃尾块」
 *   （Codex TUI 两段式流式的 GUI 版，见 `lib/mdBlocks.ts`）——块内源码不再变化就 memo，
 *   **每帧只重解析尾块**，长回复不再整篇重跑 Markdown / 高亮（V37 实测最坏单帧 ~86ms 的根因）。
 * - 流式中代码块未闭合（``` 计数为奇数）时给一条 skeleton，避免"半个代码块"跳版（MASTER §5）。
 * - 流式光标（V37 / V38 修正）：光标是 React 渲染在 `md-body` 末尾的普通子节点，
 *   每次渲染后由 `positionStreamCaret` **测出最后一个文本节点的末端坐标、用绝对定位覆盖过去**
 *   （只写 style、不搬节点——V37 的「移到文本节点之后」会破坏分块渲染里 React 的插入锚点，
 *   真实核对时抛 insertBefore 崩溃；见 `lib/streamCaret.ts`）。
 * - 代码块右上角复制按钮：长命令/长 diff 是高频复用内容。
 */
export function AssistantText({ text, complete }: { text: string; complete: boolean }) {
 const t = useText();
 const [pendingUrl, setPendingUrl] = useState<string | null>(null);
 const mdHost = useRef<HTMLDivElement>(null);
 const caret = useRef<HTMLSpanElement>(null);
 // 平滑揭示后的显示量（完整即全量；文本被替换成更短内容时直接收敛）
 const shown = useRevealedText(text, complete);
 // 冻结前缀 + 活跃尾块（尾块每帧重解析，冻结块 memo 一次解析）
 const blocks = useMemo(() => splitMarkdownBlocks(shown), [shown]);
 // 未闭合的围栏代码块：流式中会出现。**只有围栏里还没有内容时**才给骨架——
 // 空代码块没有可贴光标的位置；代码一旦开始落下就撤骨架、把光标贴到代码末尾
 // （此前按「``` 计数奇偶」判断，行内 ``` 会误报骨架，且骨架与代码块并排成两个盒子）。
 const fence = useMemo(() => openFenceState(shown), [shown]);
 const fencePlaceholder = fence.open && !fence.hasContent;
 // 组件映射只建一次：`MdBlock` 的 memo 要求 `components` 引用稳定，
 // 每次渲染新建对象会让所有冻结块全部重渲染（等于白分块）。
 const components = useMemo<Components>(
  () => ({
   // 代码块：横滚不撑破布局（MASTER §7），并挂复制按钮
   pre: ({ children, ...props }) => <CodeBlock {...props}>{children}</CodeBlock>,
   a: ({ children, ...props }) => (
    <a
     {...props}
     target="_blank"
     rel="noreferrer noopener"
     onClick={(e) => {
      const href = String(props.href ?? "");
      if (/^https?:\/\//i.test(href)) {
       e.preventDefault();
       setPendingUrl(href);
      }
     }}
    >
     {children}
    </a>
   ),
  }),
  [],
 );
 // 光标落位（每次渲染后；本组件只在 text / complete 变化时重渲染，见 Thread 的行级 memo）
 useLayoutEffect(() => {
  const host = mdHost.current;
  const el = caret.current;
  if (host && el) positionStreamCaret(host, el);
 });
 return (
  <div ref={mdHost} className="md-body relative max-w-full overflow-x-auto">
   {blocks.map((source, i) => (
    <MdBlock key={i} source={source} components={components} />
   ))}
   {pendingUrl && (
    <span className="mx-1 inline-flex items-center gap-1 rounded-md border border-border bg-elevated px-1.5 py-0.5 text-[13px]">
     {fmt(t.openLinkConfirm, pendingUrl.length > 40 ? `${pendingUrl.slice(0, 40)}…` : pendingUrl)}
     <button
      className="cursor-pointer text-accent hover:opacity-80"
      onClick={() => {
       const url = pendingUrl;
       setPendingUrl(null);
       if (isRemoteClient()) {
        window.open(url, "_blank", "noopener,noreferrer");
       } else {
        void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url).catch(() => undefined));
       }
      }}
     >
      {t.openLink}
     </button>
     <button className="cursor-pointer text-muted hover:text-foreground" onClick={() => setPendingUrl(null)}>
      {t.cancel}
     </button>
    </span>
   )}
   {fencePlaceholder && (
    // 围栏已开、代码还没到：骨架占位（代码块自己在长的时候不画它）
    <div className="mt-1.5 space-y-1.5 rounded-md bg-code p-3" aria-label={t.codeBlockGenerating} role="status">
     <div className="h-3 w-2/3 animate-pulse rounded bg-border/70" />
     <div className="h-3 w-1/2 animate-pulse rounded bg-border/70" />
    </div>
   )}
   {!complete && !fencePlaceholder && (
    // 流式光标（V37 形态 / V38 定位）：细竖线 + 平滑呼吸（形态在 index.css 的 .stream-caret）。
    // 绝对定位覆盖到最后一个字符右侧（`positionStreamCaret` 只写 style、不搬节点）。
    <span
     ref={caret}
     className="stream-caret pointer-events-none absolute w-[3px] rounded-full bg-accent/80"
     aria-hidden
    />
   )}
  </div>
 );
}

/**
 * 单个 Markdown 块（V38）：`source` 不变就不重渲染——冻结前缀因此只解析一次。
 * （流式期间每帧真正重走的只有最后一个「活跃尾块」。）
 */
const MdBlock = memo(function MdBlock({ source, components }: { source: string; components: Components }) {
 return (
  <ReactMarkdown
   remarkPlugins={[remarkGfm]}
   rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
   components={components}
  >
   {source}
  </ReactMarkdown>
 );
});

/** 代码块容器：自带复制（纯前端剪贴板，不落盘、不联网）。 */
function CodeBlock({ children, ...props }: React.ComponentProps<"pre">) {
 const t = useText();
 const [copied, setCopied] = useState(false);
 const copy = async () => {
  const el = document.activeElement as HTMLElement | null;
  void el;
  const text = extractText(children);
  try {
   if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
   } else {
    // HTTP 局域网不是安全上下文，Clipboard API 不可用；退回 execCommand。
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
   }
   setCopied(true);
   window.setTimeout(() => setCopied(false), 1500);
  } catch {
   // 复制失败不阻断阅读
  }
 };
 return (
  <div className="group/code relative">
   <pre {...props} className="overflow-x-auto rounded-md bg-code p-3 font-mono text-xs leading-5">
    {children}
   </pre>
   <button
    onClick={() => void copy()}
    className={`absolute top-1.5 right-1.5 flex cursor-pointer items-center gap-1 rounded-md border border-border bg-elevated px-1.5 py-0.5 text-[11px] text-muted transition-opacity duration-150 focus-visible:opacity-100 ${isRemoteClient() ? "opacity-100" : "opacity-0 group-hover/code:opacity-100"}`}
    aria-label={t.copy}
    title={t.copy}
   >
    {copied ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
    {copied ? t.copied : t.copy}
   </button>
  </div>
 );
}

/** 从 React 子树里抽纯文本（复制用；highlight.js 产出的是嵌套 span）。 */
function extractText(node: React.ReactNode): string {
 if (node == null || typeof node === "boolean") return "";
 if (typeof node === "string" || typeof node === "number") return String(node);
 if (Array.isArray(node)) return node.map(extractText).join("");
 if (typeof node === "object" && "props" in node) {
  const props = node.props as { children?: React.ReactNode } | null | undefined;
  return extractText(props?.children);
 }
 return "";
}
