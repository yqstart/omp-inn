import { useCallback, useState } from "react";
import { Check, ChevronDown, Refresh } from "reicon-react";
import { api } from "@shared/api";
import type { ModelInfo } from "@shared/types";
import { useApp } from "../../stores/app";
import { splitStarredModels, toggleMyModel } from "../../lib/myModels";
import { fmt } from "../../lib/locale";
import { useText } from "../../lib/useText";
import { useDropdown } from "../../lib/useDropdown";
import { clampThinking, thinkingLevelsOf } from "../../lib/thinking";
import { shortModelName } from "../../lib/modelNames";
import { StarToggle } from "../settings/StarToggle";

/**
 * 模型选择器（2026-10-14 与思考档拆分）：触发按钮 = 模型短名，浮层 = 搜索 + 刷新 +
 * 星标置顶分组（与设置页模型弹窗同一份口径）。
 *
 * **每行只带供应商标识**（`m.provider`）：同一模型名可能来自多家（deepseek 直连 / ccproxy /
 * commandcode…），只给模型名分不出是哪一个；分组标题之外每行各自带一份，星标区与搜索结果里
 * 也不会裸露。行尾**不再摆上下文窗口 / 图片能力标记**（2026-10-19 用户口径：选择器里只要供应商，
 * 容量与模态不进选择面）。
 *
 * **面板宽度 26rem**（2026-10-20 用户口径：`commandcode` 这类长供应商 + 长模型名把名字截成
 * 「DeepSeek V4 Flash Vision…」）：比原来的 20rem 宽出 6rem，长名字基本能看全；窄视口仍由
 * `max-w-[calc(100vw-2rem)]` 兜底收窄。
 *
 * 选模型仍会联动思考档，但**只在后端兜底**：omp 切模型会保留仍然合法的档位，只有缺档
 * （切过无思考模型等）才由 runtime 落 **omp 配置的默认档**（`defaultThinkingLevel`，
 * 见 `lib/thinkingDefault.ts`）——这里乐观镜像同一口径（有效档保留、否则夹默认档），
 * 真值随后经 `omp-state://` 回读收敛。
 */
export function ModelMenu() {
  const t = useText();
  const composerMenu = useApp((s) => s.composerMenu);
  const models = useApp((s) => s.models);
  const activeSessionId = useApp((s) => s.activeSessionId);
  const currentModel = useApp((s) => s.currentModel);
  const myModels = useApp((s) => s.myModels);
  const open = composerMenu === "model";
  const setOpen = useCallback(
    (v: boolean) => useApp.setState({ composerMenu: v ? "model" : null }),
    [],
  );
  const ref = useDropdown(open, () => setOpen(false));
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  /** 目录加载失败的内联提示（刷新按钮下方）；成功后清掉。 */
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const catalog = models?.models ?? [];
  const current: ModelInfo | null = catalog.find((m) => m.selector === currentModel) ?? null;

  /**
   * 选模型：乐观更新本地态（omp 真值随后经 `omp-state://` 回读收敛）。
   * 思考档镜像后端的兜底口径——仍然合法就留着（omp 会保留），缺档 / 非法才落 omp 配置的默认档。
   */
  const pick = async (m: ModelInfo) => {
    setOpen(false);
    const st = useApp.getState();
    const rollback = {
      currentModel: st.currentModel,
      currentThinking: st.currentThinking,
      currentEfforts: st.currentEfforts,
    };
    const efforts = m.thinking ?? null;
    const levels = thinkingLevelsOf(efforts);
    const thinking =
      st.currentThinking && levels.includes(st.currentThinking)
        ? st.currentThinking
        : clampThinking(st.ompDefaultThinking, efforts);
    useApp.setState({ currentModel: m.selector, currentEfforts: efforts, currentThinking: thinking });
    if (!activeSessionId) return;
    try {
      await api.setModel(activeSessionId, m.provider, m.id);
    } catch {
      useApp.setState(rollback); // 会话未运行等；omp 侧拒绝会走事件分隔线，真值回读兜底
    }
  };

  const load = async (force: boolean) => {
    setLoading(true);
    setLoadErr(null);
    try {
      const cat = force ? await api.refreshModels() : await api.getModels();
      useApp.setState({ models: cat });
    } catch (e) {
      // 目录加载失败：内联给原因（刷新按钮下方），不再静默
      setLoadErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // 候选 = 全量目录，星标只是分区、不收窄范围（没挑过也看得到全部）
  const filtered = catalog.filter((m) =>
    q.trim() ? `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(q.toLowerCase()) : true,
  );
  const starredSet = new Set(myModels);
  /** 分区：**我的模型**置顶成组（按挑选顺序）+ 其余按供应商——与设置页模型弹窗同一份口径。 */
  const { starred, others } = splitStarredModels(filtered, myModels);
  const groups = new Map<string, ModelInfo[]>();
  for (const m of others) {
    const g = groups.get(m.provider) ?? [];
    g.push(m);
    groups.set(m.provider, g);
  }
  const sections: { label: string; labelClass: string; models: ModelInfo[] }[] = [
    ...(starred.length > 0 ? [{ label: t.myModelsSection, labelClass: "text-faint", models: starred }] : []),
    ...[...groups].map(([provider, ms]) => ({ label: provider, labelClass: "font-mono text-muted", models: ms })),
  ];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => {
          setOpen(!open);
          if (!models && !open) void load(false);
        }}
        className={`flex min-w-0 max-w-52 shrink cursor-pointer items-center gap-1 rounded-md px-2 py-1 whitespace-nowrap transition-colors duration-100 hover:bg-hover ${open ? "text-foreground" : "text-muted hover:text-foreground"}`}
        aria-label={t.chooseModel}
        aria-expanded={open}
        title={current ? current.selector : t.modelLabel}
      >
        <span className="min-w-0 truncate">{current ? shortModelName(current) : t.modelLabel}</span>
        <ChevronDown size={13} aria-hidden className="shrink-0 opacity-60" />
      </button>
      {open && (
        <div className="absolute right-0 bottom-8 z-10 w-[26rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-elevated shadow-pop">
          <div className="flex items-center gap-2 p-2">
            <label htmlFor="model-search" className="sr-only">{t.searchModelLabel}</label>
            <input
              id="model-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t.searchModelPlaceholder}
              className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-[13px] outline-none"
            />
            <button
              onClick={() => void load(true)}
              disabled={loading}
              className="cursor-pointer rounded-md p-1.5 transition-colors duration-100 hover:bg-hover disabled:opacity-50"
              aria-label={t.refreshModels}
            >
              <Refresh size={14} className={loading ? "animate-spin" : ""} aria-hidden />
            </button>
          </div>
          {loadErr && (
            <p role="alert" className="px-3 pb-1.5 text-xs text-danger">{fmt(t.pickerLoadError, loadErr)}</p>
          )}
          <div className="max-h-64 overflow-y-auto px-2 pb-2">
            {sections.map((s) => (
              <div key={s.label}>
                <div className={`px-1 pt-2 pb-0.5 text-xs ${s.labelClass}`}>{s.label}</div>
                {s.models.map((m) => (
                  <div key={m.selector} className="flex items-center rounded-md">
                    <StarToggle
                      on={starredSet.has(m.selector)}
                      name={m.name}
                      onClick={() => useApp.setState({ myModels: toggleMyModel(myModels, m.selector) })}
                    />
                    <button
                      onClick={() => void pick(m)}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-100 hover:bg-hover"
                      aria-label={fmt(t.useModelAria, m.name)}
                      title={m.selector}
                    >
                      <span className="truncate">{m.name}</span>
                      <span className="ml-auto flex shrink-0 font-mono text-xs">
                        {/* 供应商：同一模型名可能来自多家，行内必须能分辨 */}
                        <span className="text-faint">{m.provider}</span>
                      </span>
                      {m.selector === currentModel && <Check size={12} className="shrink-0 text-accent" aria-hidden />}
                    </button>
                  </div>
                ))}
              </div>
            ))}
            {filtered.length === 0 && <div className="p-2 text-[13px] text-muted">{t.noModelMatch}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
