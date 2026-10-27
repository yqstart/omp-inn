/**
 * **上次选中的会话**（本应用偏好，localStorage 持久化，2026-10-19 用户口径）：
 * 「关闭 app 当时正在看的那个对话，下次打开接着看」——关闭时把选中会话连同它的
 * 归属（项目 / 标题 / 目录）记在这里，下次启动两处读同一份记录：
 *
 * - `App` 的启动恢复：按 id 走 `openSessionWithHistory` 把它打开（选中 + 拉历史），
 *   hint 用记录里的字段，恢复期间标题 / 项目 / cwd 立刻是对的（真值随后收敛）；
 * - 左栏（`ChatSidebar`）：用它把「该会话所在的工作区 / 项目」展开——其余分组在
 *   app 打开时是收着的（默认只展开第一个）。
 *
 * 记录的是**上一次运行**的快照，所以只是 hint，不是真相：会话可能已被删除 / 归档 /
 * 换了项目 / 改了名。打开失败（文件没了）时壳侧不硬撑，回到空态（见 `App`），
 * 记录本身留着——下次环境好了照样能恢复。
 */
const KEY = "omp.lastSession.v1";

export type LastSession = {
 /** 会话 id（完整 uuid）。 */
 id: string;
 /** 所属项目（null = 未归属；左栏据此定位要展开的分组）。 */
 projectId: string | null;
 /** 打开时的标题（hint 用；真值由 `open_session` 收敛）。 */
 title: string;
 /** 会话工作目录（hint 用）。 */
 cwd: string;
};

/** 坏数据一律丢弃（非对象 / 缺 id）：当没记录过——一个不存在的 id 去 spawn 只会白失败一次。 */
export function normalizeLastSession(raw: unknown): LastSession | null {
 if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
 const it = raw as Partial<LastSession>;
 if (typeof it.id !== "string" || !it.id.trim()) return null;
 return {
  id: it.id.trim(),
  projectId: typeof it.projectId === "string" && it.projectId.trim() ? it.projectId.trim() : null,
  title: typeof it.title === "string" ? it.title : "",
  cwd: typeof it.cwd === "string" ? it.cwd : "",
 };
}

/** 读上次选中的会话（坏 JSON / 无痕模式一律当没记录）。 */
export function loadLastSession(): LastSession | null {
 try {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(KEY);
  return raw ? normalizeLastSession(JSON.parse(raw)) : null;
 } catch {
  return null;
 }
}

/** 写回（内容没变不写；写失败不阻断本次操作，与 myModels / commitLang 同口径）。 */
export function saveLastSession(next: LastSession): void {
 const prev = loadLastSession();
 if (
  prev &&
  prev.id === next.id &&
  prev.projectId === next.projectId &&
  prev.title === next.title &&
  prev.cwd === next.cwd
 ) {
  return;
 }
 try {
  localStorage.setItem(KEY, JSON.stringify(next));
 } catch {
  // 无痕模式等写失败只影响下次启动的恢复
 }
}
