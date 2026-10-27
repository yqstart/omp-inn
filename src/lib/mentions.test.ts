import { describe, expect, it } from "vitest";
import { extractMentions, rewriteMentions } from "./mentions";

/**
 * V2 M6b：`@文件` 解析必须与 omp 的 `extractFileMentions` 同规则，
 * 否则输入框芯片与 omp 实际读进上下文的文件会对不上。
 */
describe("extractMentions", () => {
  it("行首与空白后的 @ 都算提及", () => {
    expect(extractMentions("@docs/rpc-memo.md")).toEqual(["docs/rpc-memo.md"]);
    expect(extractMentions("看下 @src/lib/viewmsg.ts 这段")).toEqual(["src/lib/viewmsg.ts"]);
  });

  it("引号形式允许路径带空格", () => {
    expect(extractMentions('@"docs/my notes.md"')).toEqual(["docs/my notes.md"]);
    expect(extractMentions("看 @'a b/c.ts' 文件")).toEqual(["a b/c.ts"]);
  });

  it("非行首的 @（邮箱、装饰）不算提及", () => {
    expect(extractMentions("mail me at a@b.com")).toEqual([]);
    expect(extractMentions("价格 100@200")).toEqual([]);
  });

  it("只按 omp 的 ASCII 边界与句读修剪（全角标点会留在路径里）", () => {
    expect(extractMentions("见 (@src/a.ts),")).toEqual(["src/a.ts"]);
    expect(extractMentions("见 @src/a.ts.")).toEqual(["src/a.ts"]);
    // 全角括号不在 omp 的边界集合里 → 上游也不会展开，这里必须保持一致
    expect(extractMentions("见（@src/a.ts）")).toEqual([]);
    // 全角句号不在 omp 的 TRAILING 集合里 → 会被当成路径的一部分（上游同样如此）
    expect(extractMentions("见 @src/a.ts。")).toEqual(["src/a.ts。"]);
  });

  it("去重且保持出现顺序", () => {
    expect(extractMentions("@a.ts 和 @b.ts 再看 @a.ts")).toEqual(["a.ts", "b.ts"]);
  });

  it("空文本与只有 @ 的情况安全返回", () => {
    expect(extractMentions("")).toEqual([]);
    expect(extractMentions("@ ")).toEqual([]);
    expect(extractMentions("@@")).toEqual([]);
  });
});

/**
 * 发送前改写：把短标签换成完整相对路径时**只动真正的提及位置**。
 * 与 `extractMentions` 共用正则与边界规则，正文里恰好同名的字符串不受影响。
 */
describe("提及改写（rewriteMentions）", () => {
 const toFull = (token: string) =>
  token === "components/" ? "src/views/engineering/baseline/components/" : null;

 it("只改写提及，正文里同名的字符串不碰", () => {
  expect(rewriteMentions("@components/ 里的东西", toFull)).toBe(
   "@src/views/engineering/baseline/components/ 里的东西",
  );
  expect(rewriteMentions("components/ 不是提及", toFull)).toBe("components/ 不是提及");
  // 邮箱里的 @ 不是提及（前一个字符不是边界）
  expect(rewriteMentions("a@components/", toFull)).toBe("a@components/");
 });

 it("回调和 extractMentions 看到的是同一个 token（含引号形式）", () => {
  const seen: string[] = [];
  const out = rewriteMentions('看 @"docs/设 计 稿.md" 和 @components/', (token) => {
   seen.push(token);
   return token === "docs/设 计 稿.md" ? "docs/设计 稿.md" : null;
  });
  expect(seen).toEqual(["docs/设 计 稿.md", "components/"]);
  // 新路径仍含空白 → 继续用引号形式；返回 null 的原样保留
  expect(out).toBe('看 @"docs/设计 稿.md" 和 @components/');
  // 新路径不含空白 → 去掉引号（引号只在必要时用）
  expect(rewriteMentions('@"a b.md"', () => "a-b.md")).toBe("@a-b.md");
  expect(rewriteMentions("@a.md", () => "x y.md")).toBe('@"x y.md"');
 });

 it("目录写法保留尾斜杠由调用方决定（回调用什么就写什么）", () => {
  expect(rewriteMentions("@components/", (t) => (t === "components/" ? "src/components/" : null))).toBe(
   "@src/components/",
  );
  // 返回与 token 相同 = 不改写
  expect(rewriteMentions("@a.ts", (t) => t)).toBe("@a.ts");
 });

 it("改写后文本里的提及仍解析得出来（幂等）", () => {
  const once = rewriteMentions("看 @components/ 吧", toFull);
  expect(extractMentions(once)).toEqual(["src/views/engineering/baseline/components/"]);
  expect(rewriteMentions(once, toFull)).toBe(once);
 });
});
