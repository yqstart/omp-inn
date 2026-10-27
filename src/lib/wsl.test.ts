import { describe, expect, it } from "vitest";
import { wslDistroOf } from "./wsl";

describe("wslDistroOf", () => {
  it("识别 wsl$ / wsl.localhost 的 UNC 路径", () => {
    expect(wslDistroOf("\\\\wsl$\\Ubuntu\\home\\u\\proj")).toBe("Ubuntu");
    expect(wslDistroOf("\\\\wsl.localhost\\Debian\\srv\\app")).toBe("Debian");
    expect(wslDistroOf("//wsl$/Ubuntu/home/u")).toBe("Ubuntu");
    expect(wslDistroOf("\\\\WSL$\\Ubuntu")).toBe("Ubuntu");
  });

  it("普通 Windows / POSIX 路径不算 WSL", () => {
    expect(wslDistroOf("C:\\proj")).toBeNull();
    expect(wslDistroOf("\\\\server\\share")).toBeNull();
    expect(wslDistroOf("/home/u/proj")).toBeNull();
    expect(wslDistroOf("")).toBeNull();
    expect(wslDistroOf(null)).toBeNull();
  });
});
