import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "./src/shared"),
    },
  },
  clearScreen: false,
  // 测试环境补齐（jsdom 缺的 Web API，见 `src/test/setup.ts`）
  test: {
    setupFiles: ["./src/test/setup.ts"],
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2021",
    rollupOptions: {
      // 桌面壳入口 + 手机 PWA 入口：两者共享 store / 事件归一 / 消息渲染，
      // 远程服务只把 mobile.html 与 assets 暴露给手机。
      input: {
        main: path.resolve(__dirname, "index.html"),
        mobile: path.resolve(__dirname, "mobile.html"),
      },
      output: {
        // Markdown 渲染链（react-markdown + remark-gfm + rehype-highlight）体积大且只在
        // 渲染助手正文时用到：单独分包，主包保持轻量（桌面端本地加载，无网络成本）。
        manualChunks: {
          markdown: ["react-markdown", "remark-gfm", "rehype-highlight"],
        },
      },
    },
  },
});
