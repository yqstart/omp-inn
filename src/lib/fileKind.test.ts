import { describe, expect, it } from "vitest";
import { fileKindOf } from "./fileKind";

describe("补全列表的文件类别", () => {
  it("目录不看扩展名", () => {
    expect(fileKindOf("src", true)).toBe("dir");
    expect(fileKindOf("src/components", true)).toBe("dir");
    // 名字里带点的目录也是目录
    expect(fileKindOf("foo.bar", true)).toBe("dir");
  });

  it("按基名的扩展名判定，路径层级不影响", () => {
    expect(fileKindOf("src/app/App.tsx", false)).toBe("code");
    expect(fileKindOf("docs/v1-design.md", false)).toBe("doc");
    expect(fileKindOf("assets/icon.png", false)).toBe("image");
    expect(fileKindOf("dist/app.zip", false)).toBe("archive");
    expect(fileKindOf("LICENSE.bin", false)).toBe("file");
  });

  it("扩展名大小写不敏感", () => {
    expect(fileKindOf("LOGO.PNG", false)).toBe("image");
    expect(fileKindOf("App.TSX", false)).toBe("code");
    expect(fileKindOf("Readme.MD", false)).toBe("doc");
  });

  it("无扩展名的文件走惯用名表，认不出就是 file", () => {
    expect(fileKindOf("Makefile", false)).toBe("code");
    expect(fileKindOf("Dockerfile", false)).toBe("code");
    expect(fileKindOf("README", false)).toBe("doc");
    expect(fileKindOf("NOTES", false)).toBe("file");
  });

  it("点不在扩展名位置时不当扩展名", () => {
    // 前导点是隐藏文件的写法，不是扩展名（后端列举时已过滤隐藏项，这里只保证不误判）
    expect(fileKindOf(".gitignore", false)).toBe("file");
    // 末尾的点也没有扩展名
    expect(fileKindOf("weird.", false)).toBe("file");
  });

  it("认不出的扩展名退回 file，不猜", () => {
    expect(fileKindOf("model.gguf", false)).toBe("file");
    expect(fileKindOf("blob.xyzzy", false)).toBe("file");
  });
});
