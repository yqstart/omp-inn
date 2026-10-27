import { useEffect, useState } from "react";
import type { ConstraintsView, MemoryProjectView, ModelCatalog, OmpSettingsCatalog, PluginsView, SessionView, SkillsView } from "@shared/types";
import { useApp } from "../stores/app";
import {
 loadSettingsSearchSource,
 SETTINGS_SEARCH_SOURCE_KEYS,
 type SettingsSearchSourceKey,
 type SettingsSearchSources,
} from "./settingsSearch";

/** 各源的数据形状（键与 `SettingsSearchSources` 一致，剥离 null）。 */
type SearchData = {
 catalog: OmpSettingsCatalog;
 models: ModelCatalog;
 plugins: PluginsView;
 skills: SkillsView;
 memories: MemoryProjectView[];
 archived: SessionView[];
 constraints: ConstraintsView;
};

type SourceStatus = "idle" | "loading" | "ok" | "error";

type SourceState<K extends SettingsSearchSourceKey> = {
 status: SourceStatus;
 data: SearchData[K] | null;
 error: string | null;
};

type SearchState = { [K in SettingsSearchSourceKey]: SourceState<K> };

const IDLE: SearchState = Object.fromEntries(
 SETTINGS_SEARCH_SOURCE_KEYS.map((key) => [key, { status: "idle", data: null, error: null }]),
) as SearchState;

/**
 * 设置搜索的数据源（v3）：搜索首次展开时**并行懒加载**全部源（模块级缓存 + 单飞在
 * `lib/settingsSearch.ts`；本 hook 只管把状态交给界面）。模型目录优先用 store 里
 * App 启动就拉好的那份，store 没有才自己请求。
 *
 * 返回 `settled` = 全部源已落定（成功或失败）——搜索视图用它区分「还在加载」与「真没有」。
 */
export function useSettingsSearchSources(enabled: boolean): {
 sources: SettingsSearchSources;
 settled: boolean;
 /** 全部源都失败（omp 未就绪一类）：界面要显示读取失败，不能糊成「没有匹配」。 */
 allFailed: boolean;
} {
 const storeModels = useApp((s) => s.models);
 const [state, setState] = useState<SearchState>(IDLE);

 useEffect(() => {
  if (!enabled) return;
  let alive = true;
  const setSource = <K extends SettingsSearchSourceKey>(key: K, value: SourceState<K>) => {
   if (!alive) return;
   setState((prev) => ({ ...prev, [key]: value }) as SearchState);
  };
  const run = <K extends SettingsSearchSourceKey>(key: K, promise: Promise<SearchData[K]>) => {
   setSource(key, { status: "loading", data: null, error: null });
   promise.then(
    (data) => setSource(key, { status: "ok", data, error: null }),
    (error: unknown) =>
     setSource(key, {
      status: "error",
      data: null,
      error: error instanceof Error ? error.message : String(error ?? ""),
     }),
   );
  };

  run("catalog", loadSettingsSearchSource("catalog"));
  run("plugins", loadSettingsSearchSource("plugins"));
  run("skills", loadSettingsSearchSource("skills"));
  run("memories", loadSettingsSearchSource("memories"));
  run("archived", loadSettingsSearchSource("archived"));
  run("constraints", loadSettingsSearchSource("constraints"));
  // 模型目录优先 store（App 启动静默拉过一次）
  const stored = useApp.getState().models;
  if (stored) setSource("models", { status: "ok", data: stored, error: null });
  else run("models", loadSettingsSearchSource("models"));
  return () => {
   alive = false;
  };
 }, [enabled, storeModels]);

 return {
  sources: {
   catalog: state.catalog.data,
   models: state.models.data ?? storeModels,
   plugins: state.plugins.data,
   skills: state.skills.data,
   memories: state.memories.data,
   archived: state.archived.data,
   constraints: state.constraints.data,
  },
  settled: SETTINGS_SEARCH_SOURCE_KEYS.every((key) => state[key].status === "ok" || state[key].status === "error"),
  allFailed: SETTINGS_SEARCH_SOURCE_KEYS.every((key) => state[key].status === "error"),
 };
}
