import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@shared/types";
import {
  addManyMyModels,
  myModelEntries,
  normalizeMyModels,
  orderModelsByStars,
  removeManyMyModels,
  removeProviderModels,
  splitStarredModels,
  toggleMyModel,
} from "./myModels";

const m = (provider: string, id: string): ModelInfo => ({
  provider,
  id,
  selector: `${provider}/${id}`,
  name: id,
  contextWindow: null,
  maxTokens: null,
  reasoning: null,
  thinking: null,
  input: null,
});

const CATALOG = [m("opencode-go", "deepseek-v4.1-flash"), m("commandcode", "claude-fable-5"), m("opencode-go", "muse-spark")];

describe("我的模型", () => {
  it("normalizeMyModels 丢弃坏数据并去重保序", () => {
    expect(normalizeMyModels("nope")).toEqual([]);
    expect(normalizeMyModels([1, null, "", "   ", "a/b", "a/b", " c/d "])).toEqual(["a/b", "c/d"]);
  });

  it("toggleMyModel 追加到末尾 / 移除后其余顺序不变", () => {
    expect(toggleMyModel([], "a/b")).toEqual(["a/b"]);
    expect(toggleMyModel(["a/b", "c/d"], "e/f")).toEqual(["a/b", "c/d", "e/f"]);
    expect(toggleMyModel(["a/b", "c/d"], "a/b")).toEqual(["c/d"]);
  });

  it("removeProviderModels 只删该供应商下的收藏（前缀相似不算）", () => {
    // 模型 id 可再含 `/`：仍属于同一供应商
    const list = ["opencode-go/deepseek-v4.1-flash", "opencode-go/meta/muse", "openai/gpt", "opencode-gox/model"];
    expect(removeProviderModels(list, "opencode-go")).toEqual(["openai/gpt", "opencode-gox/model"]);
    expect(removeProviderModels(list, "no-such-provider")).toEqual(list);
    expect(removeProviderModels(list, "")).toEqual(list);
  });

  it("addMany / removeMany 批量增删（去重、保序、不动无关项）", () => {
    expect(addManyMyModels(["a/b"], ["c/d", "a/b", "e/f"])).toEqual(["a/b", "c/d", "e/f"]);
    expect(removeManyMyModels(["a/b", "c/d", "e/f"], ["c/d", "x/y"])).toEqual(["a/b", "e/f"]);
    expect(removeManyMyModels(["a/b"], [])).toEqual(["a/b"]);
  });

  it("myModelEntries 按存储顺序解析，目录里没有的模型为 null", () => {
    expect(myModelEntries(["commandcode/claude-fable-5", "x/y"], CATALOG)).toEqual([
      { selector: "commandcode/claude-fable-5", model: CATALOG[1] },
      { selector: "x/y", model: null },
    ]);
  });

  it("orderModelsByStars：空星标返回目录原序；星标按存储顺序置顶；缺席的星标被忽略", () => {
    // 空 → 原数组原序（同一个引用，不做拷贝）
    expect(orderModelsByStars(CATALOG, [])).toBe(CATALOG);
    // 星标按存储顺序置顶，其余保持目录顺序、一个不少（只排序、不收窄）
    expect(orderModelsByStars(CATALOG, ["opencode-go/muse-spark", "commandcode/claude-fable-5"]).map((x) => x.selector)).toEqual([
      "opencode-go/muse-spark",
      "commandcode/claude-fable-5",
      "opencode-go/deepseek-v4.1-flash",
    ]);
    // 目录里不存在的 selector 被忽略；全都对不上时退回目录原序
    expect(orderModelsByStars(CATALOG, ["x/y"]).map((x) => x.selector)).toEqual(CATALOG.map((x) => x.selector));
    expect(orderModelsByStars(CATALOG, ["x/y", "commandcode/claude-fable-5"])[0].selector).toBe("commandcode/claude-fable-5");
  });

  it("splitStarredModels：星标组按存储顺序、其余不含星标项；无星标 / 全缺席时原样返回", () => {
    // 空星标：starred 为空、others 是原数组（同一个引用）
    expect(splitStarredModels(CATALOG, [])).toEqual({ starred: [], others: CATALOG });
    // 星标组按存储顺序；其余保目录原序且**不含星标项**（不在供应商组里重复出现）
    const { starred, others } = splitStarredModels(CATALOG, ["opencode-go/muse-spark", "commandcode/claude-fable-5", "opencode-go/muse-spark"]);
    expect(starred.map((x) => x.selector)).toEqual(["opencode-go/muse-spark", "commandcode/claude-fable-5"]);
    expect(others.map((x) => x.selector)).toEqual(["opencode-go/deepseek-v4.1-flash"]);
    // 一个都对不上（目录里没有）：退化为空组 + 原数组
    expect(splitStarredModels(CATALOG, ["x/y"])).toEqual({ starred: [], others: CATALOG });
  });
});
