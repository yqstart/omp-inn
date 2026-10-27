import { describe, expect, it } from "vitest";
import { isAbsolutePath, joinPath } from "./paths";

describe("isAbsolutePath", () => {
  it("识别 POSIX / Windows 盘符 / UNC 绝对路径", () => {
    expect(isAbsolutePath("/tmp/a")).toBe(true);
    expect(isAbsolutePath("C:\\proj\\a")).toBe(true);
    expect(isAbsolutePath("c:/proj/a")).toBe(true);
    expect(isAbsolutePath("\\\\wsl$\\Ubuntu\\home\\u")).toBe(true);
    expect(isAbsolutePath("\\\\server\\share")).toBe(true);
  });

  it("相对路径与非路径写法不算绝对", () => {
    expect(isAbsolutePath("src/a.ts")).toBe(false);
    expect(isAbsolutePath("./a")).toBe(false);
    expect(isAbsolutePath("../a")).toBe(false);
    expect(isAbsolutePath("")).toBe(false);
  });
});

describe("joinPath", () => {
  it("相对路径拼到 base，绝对路径原样返回", () => {
    expect(joinPath("/home/u/proj", "src/a.ts")).toBe("/home/u/proj/src/a.ts");
    expect(joinPath("/home/u/proj/", "src")).toBe("/home/u/proj/src");
    expect(joinPath("/home/u/proj", "/abs/a")).toBe("/abs/a");
    expect(joinPath("C:\\proj", "src\\a.ts")).toBe("C:\\proj/src\\a.ts");
    expect(joinPath("C:\\proj", "D:\\other")).toBe("D:\\other");
    expect(joinPath("", "src")).toBe("src");
    expect(joinPath("/base", "")).toBe("/base");
  });
});
