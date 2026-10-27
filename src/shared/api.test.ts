import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("IPC 错误诊断", () => {
 it("配置冲突保留后端原因与恢复提示，供界面直接展示", async () => {
  vi.mocked(invoke).mockRejectedValueOnce({ ok: false, code: "MODELS_CONFLICT", message: "配置文件已在外部修改", hint: "重新加载后再保存" });
  await expect(api.writeModelsConfig("providers: {}", "old")).rejects.toThrow("配置文件已在外部修改\n重新加载后再保存");
 });

 it("字符串错误也转换为 Error，避免界面丢掉原始诊断", async () => {
  vi.mocked(invoke).mockRejectedValueOnce("登录已结束，无法发送输入");
  await expect(api.providerLoginInput("answer")).rejects.toThrow("登录已结束，无法发送输入");
 });
});
