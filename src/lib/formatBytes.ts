/** 字节数 → 可读文本（1024 进制；设置 ›「存储维护」的读数与预览共用）。 */
export function fmtBytes(bytes: number): string {
 if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
 const units = ["B", "KB", "MB", "GB", "TB"] as const;
 let n = bytes;
 let i = 0;
 while (n >= 1024 && i < units.length - 1) {
  n /= 1024;
  i += 1;
 }
 return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}
