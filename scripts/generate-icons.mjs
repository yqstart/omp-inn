// 从矢量源重新生成桌面端应用图标（macOS .icns / Windows .ico / 各尺寸 .png）
//
// 用法：pnpm icon
// 真相：design-system/icon/omp-inn-icon.svg —— 改图标只改这个文件，再跑一次本脚本。
// 说明：Tauri CLI 的 icon 命令会顺带产出 Android / iOS / Windows Store 资产，
//       本项目 V1 只发桌面端，故只回填 src-tauri/icons/ 下真正被 tauri.conf.json 引用（及原有）的那几件。
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'design-system/icon/omp-inn-icon.svg');
const DEST = join(ROOT, 'src-tauri/icons');
const KEEP = ['icon.icns', 'icon.ico', 'icon.png', '32x32.png', '64x64.png', '128x128.png', '128x128@2x.png'];

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const tmp = mkdtempSync(join(tmpdir(), 'omp-icons-'));

try {
  execFileSync(pnpm, ['tauri', 'icon', SRC, '-o', tmp], { cwd: ROOT, stdio: 'inherit' });

  const missing = KEEP.filter((f) => !existsSync(join(tmp, f)));
  if (missing.length) throw new Error(`Tauri 未产出预期图标：${missing.join('、')}`);

  for (const f of KEEP) cpSync(join(tmp, f), join(DEST, f));
  console.log(`\n已更新 src-tauri/icons/：${KEEP.join('、')}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
