/**
 * WSL 项目路径（纯逻辑，可单测）。
 *
 * Windows 把 WSL 里的目录暴露成 `\\wsl$\<distro>\...`（新版本也写
 * `\\wsl.localhost\<distro>\...`）。壳用它判断“这个项目在 WSL 里”：
 * 终端要进该发行版，聊天会话则明确拒绝（Windows 壳不跨发行版启动 omp）。
 */
export function wslDistroOf(path: string | null | undefined): string | null {
  if (!path) return null;
  const m = /^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]([^\\/]+)/i.exec(path);
  return m ? m[1] : null;
}
