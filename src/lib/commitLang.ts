/**
 * 提交信息语言（V14 增补，本应用偏好）：`omp commit` 生成提交信息时用的语言。
 *
 * - 三档：`system`（不干预，跟从 omp 自身行为）/ `zh`（简体中文）/ `en`（英文）；
 * - 作用域是**项目**（projectId）：同一项目的主目录与全部 worktree 共用一份，项目之间互不影响；
 * - 落点是 **spawn 时给 `omp commit` 附一句 `--context` 要求**（见 `commitContextArg`）——
 *   不写 omp 配置、不改 `omp commit` 的默认行为；
 * - 「记住选择」= 写 localStorage（键 `omp.commitLang.v1`，`{ projectId: lang }`）；
 *   不记住则只在本次运行期间生效（内存态在 store 的 `commitLangPrefs`）。
 *
 * 上游实测（omp 18.2.10）：`--context` 能改变摘要主体与正文的语言，
 * 但**摘要首词仍必须是英文过去式动词**——校验器硬约束（「添加」「新增」「已添加」都被拒，
 * 只有 `added … 文件` 通过），壳侧不代偿、只能如实提示。
 */
export const COMMIT_LANGS = ["system", "zh", "en"] as const;
export type CommitLang = (typeof COMMIT_LANGS)[number];

/** 一个项目的偏好：语言 + 是否已记住（记住 = 已写 localStorage，应用重启后仍生效）。 */
export type CommitLangPref = { lang: CommitLang; remembered: boolean };

/** localStorage 键（只存已记住的项目）。 */
const KEY = "omp.commitLang.v1";

/** 坏值一律回退 `system`（不干预）——未知字符串不是一档偏好，静默忽略而不是报错。 */
export function normalizeCommitLang(raw: unknown): CommitLang {
 return raw === "zh" || raw === "en" ? raw : "system";
}

/** 读已记住的偏好（键 = projectId）；坏 JSON / 无痕模式一律当没配过。 */
export function loadCommitLangPrefs(): Record<string, CommitLangPref> {
 try {
  if (typeof localStorage === "undefined") return {};
  const raw = localStorage.getItem(KEY);
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, CommitLangPref> = {};
  for (const [projectId, lang] of Object.entries(parsed as Record<string, unknown>)) {
   // 目录里残留的坏条目（空 id / 未知档位）直接丢弃
   if (!projectId || !COMMIT_LANGS.includes(lang as CommitLang)) continue;
   out[projectId] = { lang: lang as CommitLang, remembered: true };
  }
  return out;
 } catch {
  return {};
 }
}

/** 写回：只落 `remembered` 的项目（取消记住 = 从盘里删除）；写失败不阻断本次切换。 */
export function saveCommitLangPrefs(prefs: Record<string, CommitLangPref>): void {
 try {
  const out: Record<string, CommitLang> = {};
  for (const [projectId, pref] of Object.entries(prefs)) {
   if (pref.remembered) out[projectId] = pref.lang;
  }
  localStorage.setItem(KEY, JSON.stringify(out));
 } catch {
  // 无痕模式等写失败不阻断（与 myModels / sidebarWidth 同口径）
 }
}

/**
 * 三档 → 生成提交信息时给模型的语言要求（`system` = 不附加，跟从上游默认）。
 * 快速轨把它拼进提示词，完整轨走 `omp commit --context=`；两轨共用同一段文本。
 * 这是**给模型的要求文本**，不是界面文案（不进 `locale.ts` 字典）。
 */
export function commitContextArg(lang: CommitLang): string | null {
 if (lang === "zh") {
  return "请用简体中文撰写提交信息：正文与摘要都用简体中文；摘要首词用英文过去式动词（仓库约定）。";
 }
 if (lang === "en") {
  return "请用英文撰写提交信息：摘要与正文都用英文，摘要首词为英文过去式动词。";
 }
 return null;
}
