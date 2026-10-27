// @ts-check
/**
 * ESLint flat config（eslint 9 + typescript-eslint）。
 *
 * 为什么要它：`package.json` 早就声明了 `lint` 脚本，但仓库里没有配置文件，
 * `pnpm lint` 一直以 exit 2 失败（等于没有 lint）。这里补齐并把 lint 纳入
 * CI 与提交前检查（README「常用命令」同步）。
 *
 * 规则取舍：
 * - 类型相关的重活交给 `tsc --noEmit`（typecheck），eslint 只兜类型系统看不见的坑；
 * - `react-hooks` 保留 exhaustive-deps 检查（仓库里已有若干处显式 disable，说明在用）；
 * - `react-refresh` 只检查组件文件是否混出非组件导出（HMR 失效的常见原因）。
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default tseslint.config(
  {
    // 生成产物不参与 lint（图标表是脚本产物，规则对它没有意义）
    ignores: [
      "dist/**",
      "node_modules/**",
      "src-tauri/**",
      "design-system/**",
      "src/lib/materialIcons.generated.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // 未使用变量：允许 `_` 前缀占位（与 TS 的 noUnusedLocals 语义对齐）
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // 空 catch 是刻意的降级写法（前端一律不许因附属功能炸掉主流程）
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["scripts/**/*.mjs", "*.config.{js,ts}"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
