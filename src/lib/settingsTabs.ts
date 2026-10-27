import type { Text } from "./locale";

/**
 * 设置视图的导航条目（v3 设置重构的四组十条目：通用 / 模型 / 扩展 / 数据（通用组多了「系统授权」「远程控制」））。
 * 类型与文案键映射放这里（纯数据），`SettingsPage` 与搜索视图共用——
 * 搜索视图不许反向 import 页面组件（会成环）。
 */
export type SettingsTab = "general" | "constraints" | "system" | "remote" | "models" | "plugins" | "skills" | "memories" | "usage" | "archived" | "storage";

/** 条目 → 标题文案键（导航条目与搜索分组标题共用）。 */
export const SETTINGS_TAB_LABEL_KEYS: Record<SettingsTab, keyof Text> = {
 general: "tabGeneral",
 constraints: "tabConstraints",
 system: "tabSystem",
 remote: "tabRemote",
 models: "tabModels",
 plugins: "tabPlugins",
 skills: "tabSkills",
 memories: "tabMemories",
 usage: "tabUsage",
 archived: "tabArchived",
 storage: "tabStorage",
};

/**
 * 搜索结果的定位请求（v3）：`key` = 目标设置键（常用设置）或约束文件键（`kind:name`）；
 * `seq` 每次生成自增——目标页按 seq 去重（同一请求不重复定位），消费完成后回调清空。
 */
export type SettingsFocusRequest = { key: string; seq: number };
