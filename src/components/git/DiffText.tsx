/**
 * 统一 diff 的逐行着色（工作区改动弹窗 / 提交内文件 diff 共用）。
 *
 * 只按行首前缀分类：`+` 新增 / `-` 删除 / `@@` 区块 / 头部元信息 / 其余上下文。
 * 颜色之外行首符号本身也是信号，不作为唯一信息通道。
 */
export type DiffTextKind = "diff" | "untracked";

function lineClass(line: string, kind: DiffTextKind): string {
 if (kind === "untracked") return "text-ok";
 if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index "))
  return "text-faint";
 if (line.startsWith("@@")) return "text-accent";
 if (line.startsWith("+")) return "text-ok";
 if (line.startsWith("-")) return "text-danger";
 return "text-muted";
}

export function DiffText({ text, kind }: { text: string; kind: DiffTextKind }) {
 return (
  <>
   {text.split("\n").map((line, i) => (
    <div key={i} className={lineClass(line, kind)}>
     {line || " "}
    </div>
   ))}
  </>
 );
}
