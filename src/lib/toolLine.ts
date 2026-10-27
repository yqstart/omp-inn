import type { ViewMsg } from "@shared/types";
import type { Text } from "./locale";

/**
 * 工具调用行的取词与切分（`ToolRow` 的展示层数据，纯函数，便于单测）。
 *
 * 流里的工具调用是**一行**而不是一张卡：图标 + 本地化动词 + 主片段（文件名 / 命令 /
 * 模式）+ 次要片段（目录）+ 行数增量。`argsSummary` 是数据层的原始摘要串
 * （`read`/`write`/`edit` 为 `path:行号`、`bash` 为命令、`grep`/`glob` 为 `模式 · 路径`），
 * 这里把它拆成"该加粗的"和"该退到背景的"两段。
 *
 * 这里是**纯展示**：拆不开就原样透传（上游数据不进字典，未知工具显示原始工具名）。
 */

export type ToolLineIcon = "read" | "write" | "edit" | "bash" | "search" | "other";

export type ToolLine = {
 icon: ToolLineIcon;
 /** 本地化动词；未知工具退回原始工具名（上游数据不翻译）。 */
 verb: string;
 /** 主片段：文件基名 / 命令 / 搜索模式；空 = 参数还没到（streaming 占位）。 */
 main: string;
 /** 次要片段：目录（保留结尾斜杠）/ 搜索路径；无则空串。 */
 sub: string;
 /** 主片段是文件基名（不截断，宁可整行换行）还是长文本（命令 / 未知参数，超出截断）。 */
 pathLike: boolean;
};

/**
 * `path:1-120` → `{ path, range }`；没有后缀时 range 为空串。
 *
 * omp 的 read 路径语法是 `path[:起-止][:模式]`（实测 `…/ModelsPanel.tsx:295-351:raw`），
 * 后缀是**读法**不是文件名的一部分——不剥掉的话行上会顶着 `ModelsPanel.tsx:295-351:raw`。
 * 两段后缀都可选，所以整体匹配不上时原样当路径（宁可显示原貌，不许切坏 Windows 盘符）。
 */
export function splitRange(summary: string): { path: string; range: string } {
 const m = /^(.*?)(?::(\d+(?:-\d*)?))?(?::([A-Za-z][\w-]*))?$/.exec(summary);
 if (!m || (m[2] === undefined && m[3] === undefined)) return { path: summary, range: "" };
 return { path: m[1], range: summary.slice(m[1].length + 1) };
}

/** 路径 → 基名 + 目录；目录保留结尾分隔符（`src-tauri/src/`），无目录时目录为空串。 */
export function splitPath(path: string): { base: string; dir: string } {
 const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
 return i < 0 ? { base: path, dir: "" } : { base: path.slice(i + 1), dir: path.slice(0, i + 1) };
}

const FILE_TOOLS: Record<string, { icon: ToolLineIcon; key: keyof Text }> = {
 read: { icon: "read", key: "toolVerbRead" },
 write: { icon: "write", key: "toolVerbWrite" },
 edit: { icon: "edit", key: "toolVerbEdit" },
};

export function toolLineParts(
 m: Extract<ViewMsg, { kind: "tool" }>,
 t: Text,
): ToolLine {
 const file = FILE_TOOLS[m.name];
 if (file) {
  // 行号后缀（`:1-120`）不进行内：行上只留文件名与目录，行号在展开面板的完整摘要里
  const { path } = splitRange(m.argsSummary);
  const { base, dir } = splitPath(path);
  return { icon: file.icon, verb: t[file.key], main: base, sub: dir, pathLike: true };
 }
 if (m.name === "bash") {
  return { icon: "bash", verb: t.toolVerbBash, main: m.argsSummary, sub: "", pathLike: false };
 }
 if (m.name === "grep" || m.name === "glob") {
  // `summarizeArgs` 的空格点分隔：`模式 · 路径`
  const [pattern, path = ""] = m.argsSummary.split(" · ");
  return { icon: "search", verb: t.toolVerbSearch, main: pattern ?? "", sub: path, pathLike: false };
 }
 // 未知工具没有可拆的参数规则：优先用 omp 给的意图（人话），没有才退回原始参数串。
 // 否则 omp 内部工具（如 `hub`）会把一坨 `{"i":"…","op":"ps"}` 原样糊在行上。
 return { icon: "other", verb: m.name, main: m.intent || m.argsSummary, sub: "", pathLike: false };
}
