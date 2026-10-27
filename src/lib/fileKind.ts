/**
 * 路径 → 图标类别（补全列表的取词，纯函数，便于单测）。
 *
 * 判据只有扩展名与少数无扩展名的惯用文件名，**不读文件内容、不看权限**——
 * 分类错了顶多图标不好看，不影响补全行为。认不出的一律 `file`。
 *
 * 类别只决定**图标形状**，不决定颜色：全项目的单强调色约束对这里同样有效
 * （目录 `accent`、文件一律灰阶）。
 */

import { splitPath } from "./toolLine";

export type FileKind = "dir" | "code" | "doc" | "image" | "archive" | "file";

const CODE = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "vue", "svelte", "astro",
  "py", "pyi", "ipynb", "rs", "go", "java", "kt", "kts", "scala", "swift", "dart", "zig",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "rb", "php", "lua", "pl", "pm",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "r", "jl", "ex", "exs", "erl", "hrl",
  "hs", "ml", "clj", "cljs", "groovy", "gradle", "elm", "nim", "v", "vim", "sql", "graphql", "gql", "proto",
  "css", "scss", "less", "html", "htm",
  // 配置也是"要交给机器读的文本"，与代码同档：库里没有单独的 config 图标
  "json", "jsonc", "json5", "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "properties", "xml", "plist", "lock",
]);

const DOC = new Set([
  "md", "markdown", "mdx", "txt", "text", "rst", "adoc", "asciidoc", "org", "tex", "bib",
  "pdf", "doc", "docx", "odt", "rtf", "csv", "tsv", "log",
]);

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "svgz", "ico", "bmp", "avif", "tif", "tiff", "heic", "heif"]);

const ARCHIVE = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "jar", "war"]);

/** 没有扩展名的惯用文件（按全名小写判定）。 */
const NO_EXT: Record<string, FileKind> = {
  makefile: "code",
  dockerfile: "code",
  justfile: "code",
  procfile: "code",
  gemfile: "code",
  rakefile: "code",
  readme: "doc",
  license: "doc",
  licence: "doc",
  changelog: "doc",
};

/** 判断路径该用哪个图标。`isDir` 由调用方给（后端列举时已知道，不重复 stat）。 */
export function fileKindOf(path: string, isDir: boolean): FileKind {
  if (isDir) return "dir";
  const { base } = splitPath(path);
  const dot = base.lastIndexOf(".");
  // `dot > 0`：前导点开头的隐藏文件没有扩展名（`.` 本身不算），交给全名表
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (ext) {
    if (CODE.has(ext)) return "code";
    if (DOC.has(ext)) return "doc";
    if (IMAGE.has(ext)) return "image";
    if (ARCHIVE.has(ext)) return "archive";
    return "file";
  }
  return NO_EXT[base.toLowerCase()] ?? "file";
}
