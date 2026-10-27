/**
 * 跨平台路径判断（纯逻辑，可单测）。
 *
 * 前端拿到的是 omp / git / 文件树给的原样路径：macOS 是 `/a/b`，Windows 可能是
 * `C:\a\b`、`C:/a/b` 或 WSL 的 `\\wsl$\Ubuntu\home\...`。只认 `/` 开头会把 Windows
 * 盘符路径当成相对路径，拼成 `cwd/C:\...`（打开必定失败）。
 */

/** 是否绝对路径：POSIX `/`、Windows 盘符 `C:\` / `C:/`、UNC `\\server\share`。 */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || p.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * 相对路径拼到 base 上；绝对路径原样返回。
 *
 * 刻意用 `/` 连接：Windows 的 Win32 API / Explorer 都接受正斜杠，而混用 `\` 在
 * 前端字符串里更容易出转义问题。base 末尾的 `/` 或 `\` 先去掉，避免双分隔符。
 */
export function joinPath(base: string, p: string): string {
  if (!p) return base;
  if (isAbsolutePath(p)) return p;
  if (!base) return p;
  return `${base.replace(/[\\/]+$/, "")}/${p}`;
}
