// 从矢量源重新生成桌面端与手机远程端图标。
//
// 用法：pnpm icon
// 真相：design-system/icon/omp-inn-icon.svg —— 改图标只改这个文件，再跑一次本脚本。
// Tauri CLI 顺带产出的其他平台资产不回填；手机端额外生成不透明底色的可遮罩图标。
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'design-system/icon/omp-inn-icon.svg');
const DEST = join(ROOT, 'src-tauri/icons');
const WEB_DEST = join(ROOT, 'public/icons');
const KEEP = ['icon.icns', 'icon.ico', 'icon.png', '32x32.png', '64x64.png', '128x128.png', '128x128@2x.png'];

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const tmp = mkdtempSync(join(tmpdir(), 'omp-icons-'));

try {
  execFileSync(pnpm, ['tauri', 'icon', SRC, '-o', tmp], { cwd: ROOT, stdio: 'inherit' });

  const missing = KEEP.filter((f) => !existsSync(join(tmp, f)));
  if (missing.length) throw new Error(`Tauri 未产出预期图标：${missing.join('、')}`);

  for (const f of KEEP) cpSync(join(tmp, f), join(DEST, f));
  console.log(`\n已更新 src-tauri/icons/：${KEEP.join('、')}`);

  const web = join(tmp, 'web');
  execFileSync(pnpm, ['tauri', 'icon', SRC, '-o', web, '-p', '192', '-p', '512'], { cwd: ROOT, stdio: 'inherit' });
  cpSync(join(web, '192x192.png'), join(WEB_DEST, 'icon-192.png'));
  cpSync(join(web, '512x512.png'), join(WEB_DEST, 'icon-512.png'));

  // 可遮罩图标和苹果主屏幕图标需要铺满画布的不透明背景。
  const opaqueSrc = join(tmp, 'opaque.svg');
  const svg = readFileSync(SRC, 'utf8');
  if (!svg.includes('</defs>')) throw new Error('图标矢量源缺少定义区');
  writeFileSync(opaqueSrc, svg.replace('</defs>', '</defs>\n  <rect width="1024" height="1024" fill="#191919"/>'));
  const opaque = join(tmp, 'opaque');
  execFileSync(pnpm, ['tauri', 'icon', opaqueSrc, '-o', opaque, '-p', '180', '-p', '512'], { cwd: ROOT, stdio: 'inherit' });
  cpSync(join(opaque, '180x180.png'), join(WEB_DEST, 'apple-touch-icon.png'));
  cpSync(join(opaque, '512x512.png'), join(WEB_DEST, 'icon-512-maskable.png'));
  console.log('已更新 public/icons/ 手机远程端图标');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
