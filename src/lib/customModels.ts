import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from "yaml";

/**
 * 自定义模型接入（`<agentDir>/models.yml`）的数据层：**保真编辑** omp 的用户级
 * 自定义供应商 / 模型配置。
 *
 * omp 支持在 `models.yml` 里声明自定义供应商（`baseUrl` + `apiKey` + `api` + `models`），
 * 或对内置供应商做覆盖（`baseUrl` / `headers` / `modelOverrides`…）。上游**没有 CLI 写入口**
 * （`omp models` 只有 ls / find / refresh），写文件是唯一路径——本文件负责把用户的 YAML 文本
 * 变成可编辑的表单模型，再原子地改回去。
 *
 * **职责划分（供应商配置 与 模型清单 拆开，2026-10-17）**：
 * - [`upsertProvider`] 只管**供应商本身**（名称 / 接口地址 / 接口类型 / API Key）——它**不碰
 *   `models` 节点**，老配置里手工维护的模型列表在改地址 / 换密钥后原样保留；
 * - [`setProviderModels`] 只管**模型清单**（「挑选模型」弹窗：从端点拉候选 → 勾选 → 逐项编辑
 *   显示名 / 上下文窗口 / 最大输出 / 推理 / 输入模态）。
 *   两个入口各写各的，互不覆盖。
 *
 * **保真三原则**（npm `yaml` 包的 Document API，实测零修改往返逐字节一致）：
 * 1. 只改被编辑的节点：未触碰的键、注释、格式原样保留（`toString({ flowCollectionPadding: false,
 *    lineWidth: 0 })`——默认选项会把 `[text, image]` 重排成 `[ text, image ]`，必须关掉）；
 * 2. 界面不管理的键（provider 级 `headers` / `compat` / `discovery` / `modelOverrides`…，
 *    model 级 `cost` / `tokenizer`…）**原样保留**——它们只被展示为「其它字段」，绝不被编辑抹掉；
 * 3. 覆盖型供应商（没有 `baseUrl`，只覆盖内置供应商）在界面上**只读**：界面无法完整表达
 *    那些覆盖语义，编辑它等于丢字段。
 *
 * 写入的最后一公里（预校验 / 备份 / 原子写 / 乐观锁）在后端 `src-tauri/src/models_config.rs`。
 */

import type { DiscoveredModel } from "@shared/types";

/** 界面提供的接口类型（三档，覆盖绝大多数自建端点）：`openai-completions` = OpenAI 兼容
 *  （/chat/completions，网关与本地推理引擎的通用协议）、`openai-responses` = OpenAI 的
 *  Responses 协议（/responses，新网关与“只开 /v1/responses”的端点要用它）、`anthropic-messages`
 *  = Claude 的 Messages 协议。omp 的 schema 还认其它 wire API（`omp://models.md` 的允许值），
 *  但界面不再列出——既有文件里写了别的值也不受影响：`apiOptionsFor` 把当前值一并列出，保存原样写回。 */
export const API_OPTIONS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;

/** 接口类型下拉的候选：三档 + 当前值（属于界面之外的档时原样保留，保证不改动也能保存）。 */
export function apiOptionsFor(current: string): string[] {
 const v = current.trim();
 return v && !(API_OPTIONS as readonly string[]).includes(v) ? [...API_OPTIONS, v] : [...API_OPTIONS];
}

/** 界面管理的 provider 级键；其余键一律原样保留。 */
const MANAGED_PROVIDER_KEYS = new Set(["baseUrl", "api", "apiKey", "auth", "models"]);

/** 一个模型条目的表单值（数字用字符串承载，空串 = 不写该字段）。 */
export type CustomModelForm = {
 id: string;
 /** 编辑前的模型位置；删除、改名或交换 id 后仍复用各自原节点。 */
 originalIndex?: number;
 name: string;
 contextWindow: string;
 maxTokens: string;
 reasoning: boolean;
 /** 保留文件里的所有模态；界面只切换 text / image。 */
 input: string[];
};

/** 一个自定义供应商的表单值（**只管供应商本身**；模型清单见 [`setProviderModels`]）。 */
export type CustomProviderForm = {
 id: string;
 /** 编辑态 = 该块在 `providers` 里的**原键名**（新建时为 undefined）。用户改了 `id` 时，
  *  `upsertProvider` 依据它把 YAML 键就地改名；相等则只是普通更新。 */
 originalId?: string;
 baseUrl: string;
 api: string;
 /** 空串 = 无需鉴权（`auth: none`）；否则写 `apiKey`（环境变量名 / 字面量 / `!命令`，原样透传）。 */
 apiKey: string;
};

/** 解析出的供应商条目（列表展示用）。 */
export type CustomProviderView = {
 id: string;
 /** `custom` = 自己声明了 `baseUrl`（界面可编辑供应商 + 管理模型清单）；
  *  `override` = 只覆盖内置供应商（没有 `baseUrl`，界面只读，手工维护）。 */
 kind: "custom" | "override";
 baseUrl: string | null;
 api: string | null;
 /** `auth: none`（无需鉴权）。 */
 authNone: boolean;
 /** 是否写了 `apiKey`（值不回显——可能是密钥）。 */
 hasApiKey: boolean;
 modelCount: number;
 /** 界面不管理的键（编辑时保留；列出来让用户知道界面之外还有什么）。 */
 extraKeys: string[];
};

/** YAML 解析失败（库的英文消息原样透传——属于上游数据）。 */
export type ParseError = { kind: "yaml"; message: string } | { kind: "shape" };

export type ModelsConfigParse = {
 providers: CustomProviderView[];
 error: ParseError | null;
};

/** 编辑结果：成功给新文本，失败给原因（解析不了就拒绝编辑，绝不覆盖）。 */
export type EditResult = { ok: true; text: string } | { ok: false; error: string };

// ---------- 解析 ----------

function readDoc(text: string): { doc: Document } | { error: string } {
 try {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return { error: doc.errors[0].message };
  return { doc };
 } catch (e) {
  return { error: e instanceof Error ? e.message : String(e) };
 }
}

function str(n: unknown): string {
 if (n == null) return "";
 if (typeof n === "object" && "value" in n) {
  const v = n.value;
  return v == null ? "" : String(v);
 }
 return String(n);
}

function boolOf(n: unknown): boolean {
 if (typeof n === "object" && n !== null && "value" in n) return n.value === true;
 return n === true;
}

/** `createNode({})` 的类型收窄（yaml 的 `NodeType<T>` 条件类型在调用处不精确）。 */
function newMap(doc: Document): YAMLMap {
 const node = doc.createNode({});
 if (!isMap(node)) throw new Error("yaml: createNode({}) 未返回 map");
 return node;
}

/** `createNode([])` 的类型收窄。 */
function newSeq(doc: Document): YAMLSeq {
 const node = doc.createNode([]);
 if (!isSeq(node)) throw new Error("yaml: createNode([]) 未返回 seq");
 return node;
}

function invalidShape(doc: Document): boolean {
 if (doc.contents == null) return false;
 if (!isMap(doc.contents)) return true;
 return doc.has("providers") && !isMap(doc.get("providers", true));
}

/** `models` 节点是否可由界面保真编辑：seq（可为空——实测 omp 接受 `models: []`）且每项是 map。
 *  缺省（没有该键）也算可编辑——新建 / 还没挑过模型的供应商就是这个形状。 */
function editableModels(node: unknown): node is YAMLSeq<YAMLMap> {
 return node == null || (isSeq(node) && node.items.every(isMap));
}

/** 供应商块是否由界面管理：自己声明了 `baseUrl` = 自定义端点（可编辑、可管理模型清单）；
 *  只有覆盖字段（`headers` / `modelOverrides`…）的块界面表达不了，保持只读。 */
function editableProvider(node: unknown): node is YAMLMap {
 return isMap(node) && str(node.get("baseUrl", true)) !== "";
}

/** 解析当前文本里的全部供应商（含只读的覆盖型）。 */
export function parseModelsConfig(text: string): ModelsConfigParse {
 const parsed = readDoc(text);
 if ("error" in parsed) return { providers: [], error: { kind: "yaml", message: parsed.error } };
 if (invalidShape(parsed.doc)) return { providers: [], error: { kind: "shape" } };
 const providersNode = parsed.doc.get("providers", true);
 if (providersNode == null) return { providers: [], error: null };
 if (!isMap(providersNode)) return { providers: [], error: { kind: "shape" } };

 const providers: CustomProviderView[] = [];
 for (const item of providersNode.items) {
  const id = str(item.key);
  if (!id) continue;
  const value = item.value;
  const empty: CustomProviderView = {
   id,
   kind: "override",
   baseUrl: null,
   api: null,
   authNone: false,
   hasApiKey: false,
   modelCount: 0,
   extraKeys: [],
  };
  if (!isMap(value)) {
   providers.push(empty);
   continue;
  }
  const modelsNode = value.get("models", true);
  const modelCount = isSeq(modelsNode) ? modelsNode.items.length : 0;
  if (modelCount > 0 && !editableModels(modelsNode)) return { providers: [], error: { kind: "shape" } };
  const extraKeys = value.items
   .map((i) => str(i.key))
   .filter((k) => k && !MANAGED_PROVIDER_KEYS.has(k));
  providers.push({
   id,
   kind: editableProvider(value) ? "custom" : "override",
   baseUrl: str(value.get("baseUrl", true)) || null,
   api: str(value.get("api", true)) || null,
   authNone: str(value.get("auth", true)) === "none",
   hasApiKey: str(value.get("apiKey", true)) !== "",
   modelCount,
   extraKeys,
  });
 }
 return { providers, error: null };
}

// ---------- 表单初值 ----------

function emptyModel(): CustomModelForm {
 return { id: "", name: "", contextWindow: "", maxTokens: "", reasoning: false, input: ["text"] };
}

/** 新供应商的空白表单（模型清单由「挑选模型」弹窗单独管，这里不带）。 */
export function emptyProviderForm(): CustomProviderForm {
 return { id: "", baseUrl: "", api: API_OPTIONS[0], apiKey: "" };
}

/** 一个新模型条目的表单初值（弹窗里手工添加时用）。 */
export function emptyModelForm(): CustomModelForm {
 return emptyModel();
}

/** 探测到的候选 → 表单初值：端点声明过的字段预填，缺的留空（交给 omp 默认值）。 */
export function modelFormFromDiscovered(m: DiscoveredModel): CustomModelForm {
 const name = (m.name ?? "").trim();
 return {
  id: m.id,
  name: name && name !== m.id ? name : "",
  contextWindow: m.contextWindow && m.contextWindow > 0 ? String(m.contextWindow) : "",
  maxTokens: m.maxTokens && m.maxTokens > 0 ? String(m.maxTokens) : "",
  reasoning: false,
  input: normalizeInput(m.input),
 };
}

/** 输入模态归一：只认 text / image 两类界面能表达的值，其它模态原样保留（保真原则 2）。 */
function normalizeInput(raw: string[] | null | undefined): string[] {
 const items = (raw ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
 if (items.length === 0) return ["text"];
 const known = items.filter((s) => s === "text" || s === "image");
 const extra = items.filter((s) => s !== "text" && s !== "image");
 // 只有未知模态时补一个 text（omp 的模型至少要能收文本）
 const base = known.length > 0 ? known : ["text"];
 return [...base, ...extra];
}

/**
 * 勾选合并：已有同 id 的条目**保留用户已调过的值**（不改、不重复），只追加新 id。
 * 与 DSH 一致（它的候选默认勾选项就是「当前清单里还没有的」）。
 */
export function mergeDiscoveredModels(
 existing: CustomModelForm[],
 picked: DiscoveredModel[],
): CustomModelForm[] {
 const known = new Set(existing.map((m) => m.id.trim()));
 const added = picked
  .filter((m) => m.id.trim() !== "" && !known.has(m.id.trim()))
  .map((m) => modelFormFromDiscovered(m));
 return [...existing, ...added];
}

function modelFormOf(m: YAMLMap, originalIndex?: number): CustomModelForm {
 const inputNode = m.get("input", true);
 const input = isSeq(inputNode) ? inputNode.items.map((i) => str(i)) : ["text"];
 return {
  id: str(m.get("id", true)),
  originalIndex,
  name: str(m.get("name", true)),
  contextWindow: str(m.get("contextWindow", true)),
  maxTokens: str(m.get("maxTokens", true)),
  reasoning: boolOf(m.get("reasoning", true)),
  input,
 };
}

/** 读某个供应商的供应商级表单；不存在（或块不是对象 / 是只读覆盖块）时返回 null。 */
export function providerFormOf(text: string, id: string): CustomProviderForm | null {
 const parsed = readDoc(text);
 if ("error" in parsed || invalidShape(parsed.doc)) return null;
 const node = parsed.doc.getIn(["providers", id], true);
 if (!editableProvider(node)) return null;
 return {
  id,
  originalId: id,
  baseUrl: str(node.get("baseUrl", true)),
  api: str(node.get("api", true)) || API_OPTIONS[0],
  apiKey: str(node.get("apiKey", true)),
 };
}

/**
 * 读某个供应商当前的模型清单（表单形态；`originalIndex` 用于保真复用原节点）。
 * 节点形状界面表达不了（非 seq / 含非 map 项）时返回 null——调用方据此禁用编辑入口。
 */
export function providerModelsOf(text: string, id: string): CustomModelForm[] | null {
 const parsed = readDoc(text);
 if ("error" in parsed || invalidShape(parsed.doc)) return null;
 const node = parsed.doc.getIn(["providers", id], true);
 if (!isMap(node)) return null;
 const modelsNode = node.get("models", true);
 if (!editableModels(modelsNode)) return null;
 if (modelsNode == null) return [];
 return modelsNode.items.map((m, i) => modelFormOf(m, i));
}

// ---------- 校验 ----------

/** 供应商 id（= `providers` 下的键名，也是模型 selector 的前缀，omp 侧没有单独的显示名字段）。
 *  omp 本身没有字符集约束——实测中文键照常收录（`云渡中转/gpt-6-astra` 出现在 `omp models` 里、
 *  stderr 干净），所以这里只挡「写进 YAML 键名 / selector 会歧义」的字符：空白、`/` `:` `#` 引号等。
 *  Unicode 字母 / 数字（中文、日文…）与 `.` `_` `-` 都放行。 */
export function isValidProviderId(id: string): boolean {
 return /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(id);
}

export function isValidBaseUrl(value: string): boolean {
 const trimmed = value.trim();
 if (!/^https?:\/\//i.test(trimmed)) return false;
 try {
  const url = new URL(trimmed);
  return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname;
 } catch {
  return false;
 }
}

/** 正整数（空串 = 不填，返回 null；非法返回 undefined）。 */
function positiveInt(raw: string): number | null | undefined {
 const t = raw.trim();
 if (!t) return null;
 if (!/^\d+$/.test(t)) return undefined;
 const n = Number(t);
 return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export function isValidModelLimit(value: string): boolean {
 return positiveInt(value) !== undefined;
}

/** 模型表单是否完整（id 必填；数字字段要么空、要么正整数）。 */
export function modelFormComplete(m: CustomModelForm): boolean {
 return (
  m.id.trim() !== "" &&
  isValidModelLimit(m.contextWindow) &&
  isValidModelLimit(m.maxTokens)
 );
}

/** 供应商表单是否可保存（id / baseUrl / api 必填）。
 *  **不再要求"至少一个模型"**：模型清单由「挑选模型」弹窗单独管；没有模型的供应商块
 *  omp 照样接受（实测：只是不出现在模型目录里），等挑完模型再写 `models`。 */
export function providerFormComplete(f: CustomProviderForm): boolean {
 return (
  isValidProviderId(f.id.trim()) &&
  isValidBaseUrl(f.baseUrl) &&
  f.api.trim() !== ""
 );
}

/** 模型清单是否可写：至少一个、id 唯一、限额字段合法（数字要么空、要么正整数）。 */
export function modelsComplete(models: CustomModelForm[]): boolean {
 return (
  models.length > 0 &&
  new Set(models.map((m) => m.id.trim())).size === models.length &&
  models.every(modelFormComplete)
 );
}

/** id 是否与**别的**块冲突（新建撞任何已有 id / 编辑改名撞别人 = 冲突；编辑保留原名不算）。 */
export function isDuplicateProviderId(f: CustomProviderForm, existingIds: string[]): boolean {
 const id = f.id.trim();
 if (!id || id === (f.originalId ?? "").trim()) return false;
 return existingIds.includes(id);
}

// ---------- 保真编辑 ----------

/** 序列化：关掉流式集合补白与行宽折行，保证「未触碰的字节零变化」。 */
function serialize(doc: Document): string {
 return doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
}

function ensureProviders(doc: Document): YAMLMap {
 // `get(key, true)` 的重载返回 `Scalar | undefined`——先按 unknown 收窄再判断
 const current: unknown = doc.get("providers", true);
 if (isMap(current)) return current;
 const fresh = newMap(doc);
 doc.set("providers", fresh);
 return fresh;
}

function setField(doc: Document, node: YAMLMap, key: string, value: string | number | boolean | string[] | null): void {
 if (value === null) {
  node.delete(key);
  return;
 }
 node.set(key, Array.isArray(value) ? doc.createNode(value, { flow: true }) : value);
}

function applyModelForm(doc: Document, node: YAMLMap, f: CustomModelForm): void {
 const previous = modelFormOf(node);
 if (f.id !== previous.id) setField(doc, node, "id", f.id.trim());
 if (f.name !== previous.name) setField(doc, node, "name", f.name.trim() || null);
 if (f.contextWindow !== previous.contextWindow) setField(doc, node, "contextWindow", positiveInt(f.contextWindow) ?? null);
 if (f.maxTokens !== previous.maxTokens) setField(doc, node, "maxTokens", positiveInt(f.maxTokens) ?? null);
 // 未改动的显式 false / 默认模态也原样保留；用户关闭推理时仍交给 omp 默认。
 if (f.reasoning !== previous.reasoning) setField(doc, node, "reasoning", f.reasoning ? true : null);
 if (f.input.length !== previous.input.length || f.input.some((v, i) => v !== previous.input[i])) {
  const isDefault = f.input.length === 0 || (f.input.length === 1 && f.input[0] === "text");
  setField(doc, node, "input", isDefault ? null : f.input);
 }
}

/** 按原位置复用模型节点；新条目不继承已删除同名模型的隐藏字段。 */
function buildModelsSeq(doc: Document, current: unknown, forms: CustomModelForm[]): YAMLSeq {
 const seq = isSeq(current) ? current : newSeq(doc);
 const originalItems = seq.items;
 seq.items = forms.map((f) => {
  const original = f.originalIndex !== undefined ? originalItems[f.originalIndex] : undefined;
  const node = isMap(original) ? original : newMap(doc);
  applyModelForm(doc, node, f);
  return node;
 });
 return seq;
}

/**
 * 新增 / 更新一个自定义供应商（返回新文本，原文本不动）。
 * **只管供应商级字段**（`baseUrl` / `api` / `apiKey` / `auth`）：`models` 节点与界面不管理的键
 * 原样保留（模型清单走 [`setProviderModels`]）；`apiKey` 与 `auth: none` 互斥。
 * 表单带 `originalId` 且与 `id` 不同 = **改名**：YAML 键就地替换（块的位置与键上的注释保留）。
 * 新建撞名、改名撞名、原节点已消失或是只读覆盖块时拒绝编辑，绝不覆盖别的块。
 */
export function upsertProvider(text: string, form: CustomProviderForm): EditResult {
 const parsed = readDoc(text);
 if ("error" in parsed) return { ok: false, error: parsed.error };
 if (invalidShape(parsed.doc)) return { ok: false, error: "Invalid models config structure" };
 if (!providerFormComplete(form)) return { ok: false, error: "Incomplete provider fields" };
 const doc = parsed.doc;
 const providers = ensureProviders(doc);

 const id = form.id.trim();
 const from = (form.originalId ?? "").trim();
 if (id !== from && providers.has(id)) return { ok: false, error: "Provider name already exists" };
 const source: unknown = from ? providers.get(from, true) : undefined;
 if (from && !editableProvider(source)) return { ok: false, error: "Provider is missing or read-only" };
 if (from && from !== id) {
  const pair = providers.items.find((p) => str(p.key) === from);
  if (pair && isScalar(pair.key)) pair.key.value = id;
 }
 const current: unknown = providers.get(id, true);
 let node: YAMLMap;
 if (isMap(current)) {
  node = current;
 } else {
  node = newMap(doc);
  providers.set(id, node);
 }

 if (form.baseUrl !== str(node.get("baseUrl", true))) setField(doc, node, "baseUrl", form.baseUrl.trim() || null);
 if (form.api !== (str(node.get("api", true)) || API_OPTIONS[0]) || !from) setField(doc, node, "api", form.api.trim() || null);
 if (form.apiKey !== str(node.get("apiKey", true)) || !from) {
  const apiKey = form.apiKey.trim();
  if (apiKey) {
   setField(doc, node, "apiKey", apiKey);
   if (str(node.get("auth", true)) === "none") node.delete("auth");
  } else {
   node.delete("apiKey");
   setField(doc, node, "auth", "none");
  }
 }
 return { ok: true, text: serialize(doc) };
}

/**
 * 写某个自定义供应商的模型清单（返回新文本，原文本不动）。
 *
 * 保真口径：逐个模型**复用原位置的原节点**（`originalIndex`），未触碰的模型级字段
 * （`cost` / `tokenizer`…）与注释原样保留；清单为空时**删掉 `models` 键**（实测 omp 接受
 * 没有 models 的自定义供应商块，只是它不出现在模型目录里——比留一个 `models: []` 干净）。
 * 块不存在、或块不是对象时拒绝（模型清单必须先有供应商）。
 */
export function setProviderModels(text: string, id: string, models: CustomModelForm[]): EditResult {
 const parsed = readDoc(text);
 if ("error" in parsed) return { ok: false, error: parsed.error };
 if (invalidShape(parsed.doc)) return { ok: false, error: "Invalid models config structure" };
 const doc = parsed.doc;
 const providers = doc.get("providers", true);
 if (!isMap(providers)) return { ok: false, error: "Provider is missing" };
 const node: unknown = providers.get(id, true);
 if (!isMap(node)) return { ok: false, error: "Provider is missing" };
 const forms = models.filter((m) => m.id.trim() !== "");
 if (forms.length === 0) {
  node.delete("models");
  return { ok: true, text: serialize(doc) };
 }
 if (!modelsComplete(forms)) return { ok: false, error: "Incomplete or duplicate model fields" };
 const current: unknown = node.get("models", true);
 if (!editableModels(current)) return { ok: false, error: "Provider is read-only" };
 node.set("models", buildModelsSeq(doc, current, forms));
 return { ok: true, text: serialize(doc) };
}

/** 删除一个供应商块（其余内容与注释原样保留）。 */
export function removeProvider(text: string, id: string): EditResult {
 const parsed = readDoc(text);
 if ("error" in parsed) return { ok: false, error: parsed.error };
 if (invalidShape(parsed.doc)) return { ok: false, error: "Invalid models config structure" };
 const doc = parsed.doc;
 const providers = doc.get("providers", true);
 if (!isMap(providers)) return { ok: true, text };
 const current: unknown = providers.get(id, true);
 if (providers.has(id) && !editableProvider(current)) return { ok: false, error: "Provider is read-only" };
 providers.delete(id);
 return { ok: true, text: serialize(doc) };
}
