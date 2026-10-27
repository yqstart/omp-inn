#!/usr/bin/env node
/**
 * 右栏文件树的类型图标：从 `material-icon-theme`（devDependency）里**裁剪**出运行时子集，
 * 生成 `src/lib/materialIcons.generated.ts`——运行时零依赖、只带用得到的图标。
 *
 * 口径：
 * - 图标集 = `ICONS`（精选清单）+ 目录图标的 `-open` 变体（manifest 里存在才补）；
 * - 映射表（扩展名 / 文件名 / 目录名）**按收录图标裁剪**：只保留指向已收录图标的条目，
 *   其余丢掉（认不出的一律回退默认 `file` / `folder`），这样映射与 VS Code 侧同源、
 *   又不会把 1251 个 SVG 全打进 bundle；
 * - 清单里写错的图标名**报错退出**（不做静默兜底：静默只会让某类文件长期没有图标）。
 *
 * 用法：`node scripts/generate-material-icons.mjs`（升级 material-icon-theme 后重跑）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const pkgDir = path.join(root, "node_modules", "material-icon-theme");
const manifestPath = path.join(pkgDir, "dist", "material-icons.json");
const outPath = path.join(root, "src", "lib", "materialIcons.generated.ts");

/** 收录的图标（名字取自 manifest 的 `iconDefinitions`）。 */
const ICONS = [
	// 默认（文件 / 目录 / 展开目录）
	"file",
	"folder",
	"folder-open",
	// 语言与代码
	"typescript",
	"javascript",
	"react",
	"react_ts",
	"vue",
	"svelte",
	"astro",
	"angular",
	"python",
	"rust",
	"go",
	"java",
	"kotlin",
	"swift",
	"dart",
	"c",
	"cpp",
	"csharp",
	"ruby",
	"php",
	"lua",
	"console",
	"powershell",
	"html",
	"css",
	"sass",
	"less",
	"stylus",
	"zig",
	"elixir",
	"erlang",
	"haskell",
	"scala",
	"clojure",
	"r",
	"julia",
	"ocaml",
	"nim",
	"lisp",
	"fortran",
	"cobol",
	"verilog",
	"assembly",
	"solidity",
	"graphql",
	"prisma",
	"proto",
	"webassembly",
	"diff",
	"exe",
	"hex",
	"log",
	"jupyter",
	// 数据与配置
	"json",
	"yaml",
	"toml",
	"xml",
	"database",
	"settings",
	"tune",
	// 文本与文档
	"markdown",
	"mdx",
	"tex",
	"pdf",
	"word",
	"table",
	"powerpoint",
	"document",
	"readme",
	"changelog",
	"license",
	"certificate",
	"key",
	"console",
	// 工具链
	"docker",
	"git",
	"npm",
	"nodejs",
	"pnpm",
	"yarn",
	"bun",
	"deno",
	"vscode",
	"eslint",
	"prettier",
	"tailwindcss",
	"vite",
	"vitest",
	"jest",
	"cypress",
	"storybook",
	"babel",
	"webpack",
	"rollup",
	"makefile",
	"cmake",
	"gradle",
	"maven",
	"terraform",
	"nginx",
	"tauri",
	"lock",
	"typescript-def",
	// 媒体与归档
	"image",
	"svg",
	"audio",
	"video",
	"font",
	"zip",
	// 目录
	"folder-src",
	"folder-dist",
	"folder-node",
	"folder-git",
	"folder-github",
	"folder-vscode",
	"folder-docker",
	"folder-test",
	"folder-config",
	"folder-docs",
	"folder-images",
	"folder-components",
	"folder-hook",
	"folder-utils",
	"folder-css",
	"folder-public",
	"folder-api",
	"folder-resource",
	"folder-lib",
	"folder-app",
	"folder-server",
	"folder-client",
	"folder-typescript",
	"folder-javascript",
	"folder-python",
	"folder-rust",
	"folder-go",
	"folder-java",
	"folder-views",
	"folder-class",
	"folder-controller",
	"folder-store",
	"folder-temp",
	"folder-coverage",
	"folder-plugin",
	"folder-scripts",
	"folder-benchmark",
	"folder-mock",
	"folder-helper",
	"folder-middleware",
	"folder-routes",
	"folder-redux-store",
	"folder-android",
	"folder-ios",
	"folder-src-tauri",
	"folder-download",
	"folder-environment",
	"folder-macos",
	"folder-linux",
	"folder-windows",
	"folder-desktop",
	"folder-font",
	"folder-examples",
	"folder-packages",
	"folder-tools",
	"folder-vue",
	"folder-next",
	"folder-nuxt",
	"folder-firebase",
	"folder-vercel",
	"folder-netlify",
	"folder-graphql",
	"folder-database",
	"folder-log",
	"folder-include",
	"folder-target",
	"folder-other",
	"folder-keys",
	"folder-secure",
	"folder-i18n",
	"folder-theme",
	"folder-ui",
	"folder-layout",
	"folder-template",
	"folder-snippet",
	"folder-json",
	"folder-markdown",
	"folder-pdf",
	"folder-archive",
	"folder-backup",
	"folder-ci",
	"folder-pipe",
	"folder-admin",
	"folder-form",
];

/** SVG 压成单行（只动标签之间的空白，不动 path 数据）。 */
function minifySvg(svg) {
	return svg.replace(/>\s+</g, "><").replace(/\s*\n\s*/g, "").trim();
}

/** 只保留值指向已收录图标的映射条目。 */
function prune(map, keep) {
	const out = {};
	for (const [key, id] of Object.entries(map)) {
		if (keep.has(id)) out[key] = id;
	}
	return out;
}

function main() {
	if (!fs.existsSync(manifestPath)) {
		console.error(`找不到 ${manifestPath}：先执行 pnpm install（material-icon-theme 是 devDependency）`);
		process.exit(1);
	}
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	const defs = manifest.iconDefinitions ?? {};

	const wanted = new Set(ICONS);
	// 目录图标的展开态（manifest 用单独的 `folder-*-open` 图标）
	const openVariants = new Set();
	for (const id of [...wanted]) {
		const openId = `${id}-open`;
		if (defs[openId]) {
			openVariants.add(id);
			wanted.add(openId);
		}
	}
	const missing = ICONS.filter((id) => !defs[id]);
	if (missing.length > 0) {
		console.error(`manifest 里没有这些图标：${missing.join(", ")}（清单写错了？）`);
		process.exit(1);
	}

	/** id → 压缩后的 SVG 文本。 */
	const svgs = {};
	for (const id of [...wanted].sort()) {
		const rel = defs[id].iconPath;
		const file = path.resolve(path.join(pkgDir, "dist"), rel);
		if (!fs.existsSync(file)) {
			console.error(`图标文件缺失：${id} → ${rel}`);
			process.exit(1);
		}
		svgs[id] = minifySvg(fs.readFileSync(file, "utf8"));
	}

	const extIcons = prune(manifest.fileExtensions ?? {}, wanted);
	const nameIcons = prune(manifest.fileNames ?? {}, wanted);
	const folderIcons = prune(manifest.folderNames ?? {}, wanted);
	const folderOpenIcons = prune(manifest.folderNamesExpanded ?? {}, wanted);

	const js = (obj) => JSON.stringify(obj, null, 1).replace(/\n\s*/g, " ");
	const lines = [
		"/* eslint-disable */",
		"// 由 scripts/generate-material-icons.mjs 从 material-icon-theme 生成，勿手改。",
		`// 图标 ${Object.keys(svgs).length} 个 · 扩展名 ${Object.keys(extIcons).length} · 文件名 ${Object.keys(nameIcons).length} · 目录名 ${Object.keys(folderIcons).length}`,
		"",
		"/** 图标 id → SVG 源码（单行压缩）。 */",
		`export const MATERIAL_ICON_SVG: Record<string, string> = ${js(svgs)};`,
		"",
		"/** 扩展名 → 图标 id（键可含多段，如 `d.ts`）。 */",
		`export const ICON_BY_EXT: Record<string, string> = ${js(extIcons)};`,
		"",
		"/** 完整文件名 → 图标 id。 */",
		`export const ICON_BY_NAME: Record<string, string> = ${js(nameIcons)};`,
		"",
		"/** 目录名 → 图标 id。 */",
		`export const ICON_BY_FOLDER: Record<string, string> = ${js(folderIcons)};`,
		"",
		"/** 目录名 → 展开态图标 id。 */",
		`export const ICON_BY_FOLDER_OPEN: Record<string, string> = ${js(folderOpenIcons)};`,
		"",
		"/** 默认图标 id（认不出的一律用它）。 */",
		`export const DEFAULT_FILE_ICON = "file";`,
		`export const DEFAULT_FOLDER_ICON = ${js(manifest.folder ?? "folder")};`,
		`export const DEFAULT_FOLDER_OPEN_ICON = ${js(manifest.folderExpanded ?? "folder-open")};`,
		"",
	];
	fs.writeFileSync(outPath, lines.join("\n"), "utf8");
	console.log(
		`已生成 ${path.relative(root, outPath)}：图标 ${Object.keys(svgs).length}（含展开态 ${openVariants.size} 组）· ` +
			`扩展名 ${Object.keys(extIcons).length} · 文件名 ${Object.keys(nameIcons).length} · ` +
			`目录名 ${Object.keys(folderIcons).length} · ${(fs.statSync(outPath).size / 1024).toFixed(0)}KB`,
	);
}

main();
