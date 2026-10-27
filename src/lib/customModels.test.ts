import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  API_OPTIONS,
  apiOptionsFor,
  emptyModelForm,
  emptyProviderForm,
  isDuplicateProviderId,
  isValidProviderId,
  mergeDiscoveredModels,
  modelFormComplete,
  modelFormFromDiscovered,
  modelsComplete,
  parseModelsConfig,
  providerFormComplete,
  providerFormOf,
  providerModelsOf,
  removeProvider,
  setProviderModels,
  upsertProvider,
  type CustomModelForm,
  type CustomProviderForm,
} from "./customModels";

// 样例＝用户真实 models.yml 的形态：顶部注释 + 覆盖型块（deepseek）+ 自定义块（含界面之外的键）
const SAMPLE = `# 顶部注释：保留说明
providers:
  deepseek:
    modelOverrides:
      deepseek-flash:
        input: [text, image]
        compat:
          stripImageInput: false
  my-gw:
    baseUrl: https://gw.example.com/v1
    apiKey: GW_KEY
    api: openai-completions
    headers:
      X-Team: platform
    models:
      - id: gpt-x
        name: GPT X
        contextWindow: 128000
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
`;

function form(over: Partial<CustomProviderForm> = {}): CustomProviderForm {
  return {
    ...emptyProviderForm(),
    id: "new-gw",
    baseUrl: "http://127.0.0.1:8000/v1",
    ...over,
  };
}

function model(over: Partial<CustomModelForm> = {}): CustomModelForm {
  return { ...emptyModelForm(), id: "m1", ...over };
}

describe("parseModelsConfig", () => {
  it("区分自定义块与覆盖型块，读出字段与界面之外的键", () => {
    const { providers, error } = parseModelsConfig(SAMPLE);
    expect(error).toBeNull();
    expect(providers.map((p) => p.id)).toEqual(["deepseek", "my-gw"]);

    const [deepseek, gw] = providers;
    expect(deepseek.kind).toBe("override");
    expect(deepseek.extraKeys).toEqual(["modelOverrides"]);
    expect(deepseek.modelCount).toBe(0);

    expect(gw.kind).toBe("custom");
    expect(gw.baseUrl).toBe("https://gw.example.com/v1");
    expect(gw.api).toBe("openai-completions");
    expect(gw.hasApiKey).toBe(true);
    expect(gw.authNone).toBe(false);
    expect(gw.modelCount).toBe(1);
    expect(gw.extraKeys).toEqual(["headers"]);
  });

  it("没有 models 但有 baseUrl 的块也算自定义（拆分后：先配供应商，再挑模型）", () => {
    const { providers, error } = parseModelsConfig("providers:\n  gw:\n    baseUrl: http://x/v1\n    api: openai-completions\n    auth: none\n");
    expect(error).toBeNull();
    expect(providers[0].kind).toBe("custom");
    expect(providers[0].modelCount).toBe(0);
  });

  it("空文本 / 无 providers 都是空清单而非错误", () => {
    expect(parseModelsConfig("")).toEqual({ providers: [], error: null });
    expect(parseModelsConfig("# 只有注释\n")).toEqual({ providers: [], error: null });
    expect(parseModelsConfig("theme:\n  dark: x\n")).toEqual({ providers: [], error: null });
  });

  it("坏 YAML 报 yaml 错误；providers 不是对象报 shape 错误", () => {
    const bad = parseModelsConfig("providers: [");
    expect(bad.providers).toEqual([]);
    expect(bad.error?.kind).toBe("yaml");
    const shape = parseModelsConfig("providers: 42\n");
    expect(shape.error?.kind).toBe("shape");
  });
});

describe("providerFormOf / providerModelsOf", () => {
  it("不存在的 id / 解析失败 / 覆盖型块都返回 null（覆盖块界面只读）", () => {
    expect(providerFormOf(SAMPLE, "nope")).toBeNull();
    expect(providerFormOf("providers: [", "x")).toBeNull();
    expect(providerFormOf(SAMPLE, "deepseek")).toBeNull();
  });

  it("自定义块即使还没有 models 也能读出供应商表单", () => {
    const text = "providers:\n  gw:\n    baseUrl: http://x/v1\n    api: anthropic-messages\n    apiKey: K\n";
    expect(providerFormOf(text, "gw")).toEqual({
      id: "gw", originalId: "gw", baseUrl: "http://x/v1", api: "anthropic-messages", apiKey: "K",
    });
    expect(providerModelsOf(text, "gw")).toEqual([]);
  });

  it("读模型清单：按行读出含 originalIndex（保真复用原节点）", () => {
    const models = providerModelsOf(SAMPLE, "my-gw")!;
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "gpt-x", name: "GPT X", contextWindow: "128000", maxTokens: "", reasoning: false, input: ["text"], originalIndex: 0,
    });
    expect(providerModelsOf(SAMPLE, "deepseek")).toEqual([]);
    expect(providerModelsOf("providers: [", "my-gw")).toBeNull();
  });
});

describe("upsertProvider 保真编辑（只管供应商字段）", () => {
  it("改接口地址：注释、其它块、界面之外的键与已有模型清单全部原样保留", () => {
    const f = providerFormOf(SAMPLE, "my-gw")!;
    f.baseUrl = "https://gw2.example.com/v1";
    const r = upsertProvider(SAMPLE, f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.text;
    expect(out).toContain("baseUrl: https://gw2.example.com/v1");
    // 顶部注释、覆盖型块、界面之外的键（headers / cost）一个不少
    expect(out).toContain("# 顶部注释：保留说明");
    expect(out).toContain("stripImageInput: false");
    expect(out).toContain("X-Team: platform");
    // 模型清单不归它管：一个字节都不许动
    expect(out).toContain("cost: {input: 1, output: 2, cacheRead: 0, cacheWrite: 0}");
    expect(out).toContain("        name: GPT X\n");
    expect(out).toContain("  deepseek:\n    modelOverrides:\n      deepseek-flash:\n        input: [text, image]\n");
  });

  it("apiKey 与 auth: none 互斥", () => {
    const f = providerFormOf(SAMPLE, "my-gw")!;
    f.apiKey = "";
    const out = (upsertProvider(SAMPLE, f) as { ok: true; text: string }).text;
    expect(out).toContain("auth: none");
    expect(out).not.toContain("apiKey");
    // 再填回去：auth 消失、apiKey 回来
    const back = (upsertProvider(out, { ...f, apiKey: "NEW_KEY" }) as { ok: true; text: string }).text;
    expect(back).toContain("apiKey: NEW_KEY");
    expect(back).not.toContain("auth: none");
  });

  it("从空文本建新供应商：只写供应商字段（模型留给挑选弹窗）", () => {
    const r = upsertProvider("", form());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("providers:");
    expect(r.text).toContain("new-gw:");
    expect(r.text).toContain("baseUrl: http://127.0.0.1:8000/v1");
    expect(r.text).toContain("auth: none");
    expect(r.text).toContain("api: openai-completions");
    expect(r.text).not.toContain("models");
    const again = parseModelsConfig(r.text);
    expect(again.error).toBeNull();
    expect(again.providers.map((p) => p.id)).toEqual(["new-gw"]);
  });

  it("追加到已有文件末尾：原内容与注释不动", () => {
    const r = upsertProvider(SAMPLE, form());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text.startsWith("# 顶部注释：保留说明\n")).toBe(true);
    expect(r.text).toContain("  deepseek:");
    expect(r.text.indexOf("new-gw:")).toBeGreaterThan(r.text.indexOf("my-gw:"));
  });

  it("中文供应商名：键原样写出、可被解析回来（omp 实测收录该键）", () => {
    const r = upsertProvider("", form({ id: "云渡中转" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("云渡中转:");
    const back = parseModelsConfig(r.text);
    expect(back.error).toBeNull();
    expect(back.providers.map((p) => p.id)).toEqual(["云渡中转"]);
  });

  it("解析不了的文本拒绝编辑（不覆盖）", () => {
    const r = upsertProvider("providers: [", form());
    expect(r.ok).toBe(false);
  });

  it("结构损坏时拒绝编辑，不把 providers 标量或根数组覆盖为空对象", () => {
    for (const text of ["providers: 42\n", "providers: null\n", "- item\n", "42\n"]) {
      expect(parseModelsConfig(text).error?.kind).toBe("shape");
      expect(providerFormOf(text, "my-gw")).toBeNull();
      expect(upsertProvider(text, form()).ok).toBe(false);
      expect(removeProvider(text, "my-gw").ok).toBe(false);
      expect(setProviderModels(text, "my-gw", [model()]).ok).toBe(false);
    }
  });

  it("改名：YAML 键就地替换（块的位置与键上的注释、模型清单都保留）", () => {
    const text = [
      "providers:",
      "  first:",
      "    baseUrl: http://a/v1",
      "  # 待改名的块",
      "  mid:",
      "    baseUrl: http://b/v1",
      "    api: anthropic-messages",
      "    apiKey: K2",
      "    models:",
      "      - id: n",
      "  last:",
      "    baseUrl: http://c/v1",
      "",
    ].join("\n");
    const f = providerFormOf(text, "mid")!;
    f.id = "renamed";
    const r = upsertProvider(text, f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).not.toContain("mid:");
    expect(r.text.indexOf("renamed:")).toBeGreaterThan(r.text.indexOf("first:"));
    expect(r.text.indexOf("renamed:")).toBeLessThan(r.text.indexOf("last:"));
    expect(r.text).toContain("  # 待改名的块");
    expect(r.text).toContain("api: anthropic-messages");
    expect(r.text).toContain("      - id: n\n");
  });

  it("改名：其余块、界面之外的键与模型级字段全部原样保留", () => {
    const f = providerFormOf(SAMPLE, "my-gw")!;
    f.id = "renamed-gw";
    const out = (upsertProvider(SAMPLE, f) as { ok: true; text: string }).text;
    expect(out).toContain("  renamed-gw:\n");
    expect(out).not.toContain("my-gw");
    expect(out).toContain("# 顶部注释：保留说明");
    expect(out).toContain("X-Team: platform");
    expect(out).toContain("GW_KEY");
    expect(out).toContain("cost: {input: 1, output: 2, cacheRead: 0, cacheWrite: 0}");
  });

  it("新建撞名、改名撞名与失效编辑目标均拒绝保存", () => {
    const clash = providerFormOf(SAMPLE, "my-gw")!;
    clash.id = "deepseek";
    expect(upsertProvider(SAMPLE, clash).ok).toBe(false);
    expect(upsertProvider(SAMPLE, form({ id: "my-gw" })).ok).toBe(false);
    expect(upsertProvider(SAMPLE, { ...clash, originalId: "missing", id: "new" }).ok).toBe(false);
    // 覆盖型块（没有 baseUrl）不是界面的编辑目标
    expect(upsertProvider(SAMPLE, { ...clash, originalId: "deepseek" }).ok).toBe(false);
  });
});

describe("setProviderModels（模型清单：挑选弹窗的写入面）", () => {
  it("改一个模型字段：注释、隐藏字段与未知模态全部保留", () => {
    const models = providerModelsOf(SAMPLE, "my-gw")!;
    models[0].name = "新名字";
    const r = setProviderModels(SAMPLE, "my-gw", models);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("name: 新名字");
    expect(r.text).toContain("cost: {input: 1, output: 2, cacheRead: 0, cacheWrite: 0}");
    expect(r.text).toContain("# 顶部注释：保留说明");
    expect(r.text).toContain("X-Team: platform");
    // 供应商级字段不受影响
    expect(r.text).toContain("baseUrl: https://gw.example.com/v1");
    expect(r.text).toContain("apiKey: GW_KEY");
    expect(r.text).toContain("  deepseek:\n    modelOverrides:\n      deepseek-flash:\n        input: [text, image]\n");
  });

  it("数字 / 推理 / 图片输入按 omp 的 schema 写；空值删键", () => {
    const models = providerModelsOf(SAMPLE, "my-gw")!;
    models[0].contextWindow = "";
    models[0].maxTokens = "4096";
    models[0].reasoning = true;
    models[0].input = ["text", "image"];
    const out = (setProviderModels(SAMPLE, "my-gw", models) as { ok: true; text: string }).text;
    expect(out).not.toContain("contextWindow");
    expect(out).toContain("maxTokens: 4096");
    expect(out).toContain("reasoning: true");
    expect(out).toContain("input: [text, image]");
  });

  it("模型改 id 后保留自身 cost，删除后新建同名模型不会继承旧字段", () => {
    const models = providerModelsOf(SAMPLE, "my-gw")!;
    models[0].id = "renamed-model";
    const result = setProviderModels(SAMPLE, "my-gw", models);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = parse(result.text).providers["my-gw"].models[0];
    expect(parsed.id).toBe("renamed-model");
    expect(parsed.cost).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });

    const replacement = setProviderModels(SAMPLE, "my-gw", [model({ id: "gpt-x" })]);
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) return;
    expect(parse(replacement.text).providers["my-gw"].models[0].cost).toBeUndefined();
  });

  it("删除前一行后剩余模型改名仍保留自己的隐藏字段", () => {
    const text = `providers:
  gw:
    baseUrl: https://example.com
    api: openai-completions
    auth: none
    models:
      - id: first
        tokenizer: first-tokenizer
      - id: second
        tokenizer: second-tokenizer
`;
    const models = providerModelsOf(text, "gw")!;
    const kept = [{ ...models[1], id: "first" }];
    const result = setProviderModels(text, "gw", kept);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(parse(result.text).providers.gw.models).toEqual([{ id: "first", tokenizer: "second-tokenizer" }]);
  });

  it("编辑其它字段时保留显式 auth、false、未知模态及模型列表注释", () => {
    const text = `providers:
  gw:
    baseUrl: https://example.com
    api: google-vertex
    apiKey: KEY
    auth: oauth
    models: # keep list comment
      - id: old
        reasoning: false # keep explicit false
        input: [text, audio] # keep input comment
`;
    const models = providerModelsOf(text, "gw")!;
    models[0].id = "new";
    const result = setProviderModels(text, "gw", models);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(parse(result.text).providers.gw).toEqual({
      baseUrl: "https://example.com", api: "google-vertex", apiKey: "KEY", auth: "oauth",
      models: [{ id: "new", reasoning: false, input: ["text", "audio"] }],
    });
    expect(result.text).toContain("# keep list comment");
    expect(result.text).toContain("# keep explicit false");
    expect(result.text).toContain("# keep input comment");

    models[0].input.push("image");
    const withImage = setProviderModels(text, "gw", models);
    expect(withImage.ok).toBe(true);
    if (!withImage.ok) return;
    expect(parse(withImage.text).providers.gw.models[0].input).toEqual(["text", "audio", "image"]);
  });

  it("模型 id 重复（含前后空白）时拒绝保存，不复用同一个节点两次", () => {
    const models = providerModelsOf(SAMPLE, "my-gw")!;
    models.push(model({ id: " gpt-x " }));
    expect(modelsComplete(models)).toBe(false);
    expect(setProviderModels(SAMPLE, "my-gw", models).ok).toBe(false);
  });

  it("保留已有模型的隐藏字段，并允许追加新模型", () => {
    const models = providerModelsOf(SAMPLE, "my-gw")!;
    const next = [{ ...models[0], maxTokens: "2048" }, model({ id: "m2", name: "M2" })];
    const out = (setProviderModels(SAMPLE, "my-gw", next) as { ok: true; text: string }).text;
    expect(out).toContain("cost: {input: 1, output: 2, cacheRead: 0, cacheWrite: 0}");
    expect(out).toContain("maxTokens: 2048");
    expect(out).toContain("id: m2");
  });

  it("空清单删掉 models 键（omp 实测接受没有 models 的自定义块）", () => {
    const r = setProviderModels(SAMPLE, "my-gw", []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).not.toContain("models");
    expect(parse(r.text).providers["my-gw"]).toEqual({
      baseUrl: "https://gw.example.com/v1", apiKey: "GW_KEY", api: "openai-completions", headers: { "X-Team": "platform" },
    });
  });

  it("块不存在时拒绝（模型清单必须先有供应商），坏 YAML 也拒绝", () => {
    expect(setProviderModels(SAMPLE, "nope", [model()]).ok).toBe(false);
    expect(setProviderModels("providers: [", "my-gw", [model()]).ok).toBe(false);
  });
});

describe("removeProvider", () => {
  it("只删目标块，注释与其它块保留", () => {
    const r = removeProvider(SAMPLE, "my-gw");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).not.toContain("my-gw");
    expect(r.text).toContain("# 顶部注释：保留说明");
    expect(r.text).toContain("deepseek:");
    expect(r.text).toContain("stripImageInput: false");
  });

  it("删掉最后一个块后仍留下合法空结构（空文件会让 omp 报 root 错误）", () => {
    const one = "providers:\n  a:\n    baseUrl: http://x/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: m\n";
    const r = removeProvider(one, "a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text.trim()).toBe("providers: {}");
  });

  it("覆盖型块只读，不提供编辑表单也不允许删除", () => {
    expect(providerFormOf(SAMPLE, "deepseek")).toBeNull();
    expect(removeProvider(SAMPLE, "deepseek").ok).toBe(false);
  });
  it("没有 providers 块时原样返回（不制造副作用），坏 YAML 拒绝编辑", () => {
    const r = removeProvider("# x\n", "a");
    expect(r.ok && r.text).toBe("# x\n");
    expect(removeProvider("providers: [", "a").ok).toBe(false);
  });
});

describe("表单校验", () => {
  it("provider id 字符集（Unicode 字母——中文 / 日文——放行，omp 侧无约束）", () => {
    for (const ok of ["a", "my-gw", "llama.cpp", "a_b-1.2", "云渡中转", "模型-2", "プロバイダ"])
      expect(isValidProviderId(ok), ok).toBe(true);
    for (const bad of ["", "-gw", ".gw", "a b", "a/b", "云渡 中转", ":x", "a:b", "a#b"])
      expect(isValidProviderId(bad), bad).toBe(false);
  });

  it("供应商表单只看 id / baseUrl / api（模型清单不在这里拦）", () => {
    expect(providerFormComplete(form())).toBe(true);
    expect(providerFormComplete(form({ id: "云渡中转" }))).toBe(true);
    expect(providerFormComplete(form({ baseUrl: "gw.example.com" }))).toBe(false);
    expect(providerFormComplete(form({ baseUrl: "https://" }))).toBe(false);
    expect(providerFormComplete(form({ baseUrl: "https:example.com" }))).toBe(false);
    expect(providerFormComplete(form({ baseUrl: "HTTPS://example.com/v1" }))).toBe(true);
    expect(providerFormComplete(form({ api: "" }))).toBe(false);
  });

  it("模型字段完整性与清单可写性", () => {
    expect(modelFormComplete({ id: "m", name: "", contextWindow: "", maxTokens: "", reasoning: false, input: [] })).toBe(true);
    expect(modelFormComplete({ id: "m", name: "", contextWindow: "abc", maxTokens: "", reasoning: false, input: [] })).toBe(false);
    expect(modelFormComplete({ id: "m", name: "", contextWindow: "0", maxTokens: "", reasoning: false, input: [] })).toBe(false);
    expect(modelFormComplete({ id: "", name: "", contextWindow: "", maxTokens: "", reasoning: false, input: [] })).toBe(false);

    expect(modelsComplete([model()])).toBe(true);
    expect(modelsComplete([])).toBe(false);
    expect(modelsComplete([model({ id: "a" }), model({ id: "a" })])).toBe(false);
    expect(modelsComplete([model({ contextWindow: "x" })])).toBe(false);
  });
});

describe("接口类型候选（apiOptionsFor）", () => {
  it("界面只提供三档；既有文件里写的其它值原样追加（不改动也能保存）", () => {
    expect(API_OPTIONS).toEqual(["openai-completions", "openai-responses", "anthropic-messages"]);
    for (const cur of ["", " openai-completions "]) {
      expect(apiOptionsFor(cur)).toEqual(["openai-completions", "openai-responses", "anthropic-messages"]);
    }
    expect(apiOptionsFor("openai-responses")).toEqual(["openai-completions", "openai-responses", "anthropic-messages"]);
    expect(apiOptionsFor("anthropic-messages")).toEqual(["openai-completions", "openai-responses", "anthropic-messages"]);
    expect(apiOptionsFor("google-vertex")).toEqual(["openai-completions", "openai-responses", "anthropic-messages", "google-vertex"]);
  });

  it("选 openai-responses：原样写进 YAML 并能读回", () => {
    const created = upsertProvider("", form({ api: "openai-responses" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.text).toContain("api: openai-responses");
    expect(providerFormOf(created.text, "new-gw")?.api).toBe("openai-responses");
  });
});

describe("候选模型合并（「获取可用模型」的结果进清单）", () => {
  it("端点声明过的字段预填，缺的留空（交给 omp 默认值）", () => {
    expect(modelFormFromDiscovered({ id: "m", name: "M", contextWindow: 200000, maxTokens: 8192, input: ["text", "image"] }))
      .toEqual({ id: "m", name: "M", contextWindow: "200000", maxTokens: "8192", reasoning: false, input: ["text", "image"] });
    // 显示名与 id 相同 = 没有显示名；模态缺省 = 纯文本
    expect(modelFormFromDiscovered({ id: "m", name: "m", contextWindow: null, maxTokens: null, input: null }))
      .toEqual({ id: "m", name: "", contextWindow: "", maxTokens: "", reasoning: false, input: ["text"] });
  });

  it("已有同 id 保留用户调过的值，只追加新 id", () => {
    const existing = [model({ id: "a", name: "用户改过的名字", contextWindow: "1024", maxTokens: "64", reasoning: true, input: ["text", "image"] })];
    const merged = mergeDiscoveredModels(existing, [
      { id: "a", name: "端点给的名字", contextWindow: 200000, maxTokens: 8192, input: ["text"] },
      { id: "b", name: "B", contextWindow: 32000, maxTokens: null, input: null },
      { id: "  ", name: null, contextWindow: null, maxTokens: null, input: null },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual(existing[0]);
    expect(merged[1]).toMatchObject({ id: "b", name: "B", contextWindow: "32000", maxTokens: "", input: ["text"] });
  });
});

describe("isDuplicateProviderId", () => {
  const ids = ["a", "b"];
  it("新建撞已有 / 编辑改名撞别人算冲突；保留原名或改回原名不算", () => {
    expect(isDuplicateProviderId(form({ id: "a" }), ids)).toBe(true);
    expect(isDuplicateProviderId(form({ id: "c" }), ids)).toBe(false);
    expect(isDuplicateProviderId(form({ id: "" }), ids)).toBe(false);
    expect(isDuplicateProviderId({ ...form({ id: "b" }), originalId: "a" }, ids)).toBe(true);
    expect(isDuplicateProviderId({ ...form({ id: "a" }), originalId: "a" }, ids)).toBe(false);
  });
});
