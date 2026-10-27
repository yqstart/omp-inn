//! 记忆（Memory）：把 omp 的**项目记忆**映射到设置页（列表 / 查看 / 删除）。
//!
//! 上游事实（omp 18.2.1 实测）：
//! - 记忆不在项目仓库里，而在 `<agentDir>/memories/` 下**按 cwd 一目录一份**。目录名是
//!   `--` + 绝对路径去掉首斜杠、`/` `\` `:` 换成 `-` + `--`（`/Users/me/proj` →
//!   `--Users-me-proj--`）。注意这**不是** sessions 那套目录名编码，两者不能互推。
//! - 目录内容全是 Markdown：`MEMORY.md`（长期记忆）/ `memory_summary.md`（会话启动时
//!   注入 system prompt 的摘要）/ `raw_memories.md`（逐会话原始记忆）/
//!   `rollout_summaries/*.md` / `skills/<name>/SKILL.md`（可带 scripts）/ `learned.md`。
//! - omp **没有** `omp memory` 这类 CLI：记忆由 agent 工具与启动时的后台流水线写入，
//!   删除的唯一方式就是删文件 / 删目录。所以本模块只做三件事——列、读、删；
//!   **写入一律不碰**（写记忆是 omp 的事，壳侧没有可映射的写入入口）。
//!
//! 目录名来自磁盘、相对路径来自前端回传，**都按不可信输入处理**：一律经 [`safe_path`]
//! 校验（拒绝绝对路径 / `..` / 分隔符），canonicalize 后必须仍落在记忆根目录内。
//!
//! 纯逻辑（目录名解码、文件枚举与排序、路径校验）都有单测，文件操作在临时目录上做真实行为测试。

use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use tauri::State;

use crate::commands::{cmd_err, owner_project, AppState, CmdError};

/// 单文件读取上限：记忆都是 Markdown 文本，超过就截断并告知界面
/// （长项目的 `raw_memories.md` 会很大，但不该整个塞进 WebView）。
const READ_MAX_BYTES: usize = 1024 * 1024;
/// 单个记忆目录的文件枚举上限（防病态目录把列表撑爆）。
const FILES_MAX: usize = 2000;
/// 递归深度上限（真实布局最深是 `skills/<name>/scripts/x.py`，留点余量）。
const DEPTH_MAX: usize = 6;
/// 核心记忆文件置顶的固定顺序——人最常看的就是这几份，其余按相对路径字典序。
const CORE_ORDER: [&str; 4] = ["MEMORY.md", "memory_summary.md", "learned.md", "raw_memories.md"];

// ---------- 视图类型 ----------

/// 记忆目录里的一个文件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFileView {
    /// 相对记忆目录的路径，始终用 `/` 分隔（`MEMORY.md`、`skills/foo/SKILL.md`）。
    pub path: String,
    pub size: u64,
    /// 修改时间（毫秒时间戳；0 = 读不到）。
    pub modified: i64,
    /// 分类：`memory` / `summary` / `raw` / `learned` / `rollout` / `skill` / `other`。
    pub kind: String,
}

/// 一个项目的记忆（= `memories/` 下的一个目录）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryProjectView {
    /// 记忆目录名（编码名；读取 / 删除都用它作唯一标识）。
    pub dir: String,
    /// 解出的 cwd；null = 解不出（原项目目录已删 / 改名，此时 `name` 退回编码名）。
    pub path: Option<String>,
    /// 显示名：命中的覆盖层项目名 > 路径末段 > 编码名。
    pub name: String,
    /// 命中的覆盖层项目 id（未命中为 null）。
    pub project_id: Option<String>,
    pub files: Vec<MemoryFileView>,
    pub total_bytes: u64,
    /// 目录内最近一次修改时间（毫秒；0 = 没有可读文件）。
    pub updated_at: i64,
}

/// 单个记忆文件的正文。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFileContent {
    pub text: String,
    /// 文件真实字节数（截断前）。
    pub bytes: u64,
    /// `text` 是否被截断（只有前 `READ_MAX_BYTES`）。
    pub truncated: bool,
    pub modified: i64,
}

// ---------- 目录名解码 ----------

/// 记忆目录名 → cwd。
///
/// 编码是**不可逆**的（路径里的 `-` 与分隔符同形：`a-b/c` 与 `a/b-c` 编码结果相同），
/// 所以解不回字符串，只能拿真实文件系统当字典：按 `-` 分段，从根开始逐级拼目录名，
/// **优先少合并**（先按单段试），走的通就继续——`ESV-tracsys-web` 这类含连字符的目录
/// 就是靠逐级合并解出来的。解不出（项目已删 / 移动）返回 `None`，界面退回显示编码名。
pub fn decode_cwd(dir_name: &str) -> Option<PathBuf> {
    let inner = dir_name.strip_prefix("--")?.strip_suffix("--")?;
    if inner.is_empty() || inner.len() > 512 {
        return None;
    }
    let tokens: Vec<&str> = inner.split('-').collect();
    dfs_decode(Path::new("/"), &tokens)
}

/// 逐级匹配真实目录：`tokens[..k]` 用 `-` 拼成一级目录名，命中就往下走。
fn dfs_decode(base: &Path, tokens: &[&str]) -> Option<PathBuf> {
    if tokens.is_empty() {
        return if base.is_dir() { Some(base.to_path_buf()) } else { None };
    }
    for k in 1..=tokens.len() {
        let name = tokens[..k].join("-");
        if name.is_empty() {
            continue;
        }
        let cand = base.join(&name);
        if cand.is_dir() {
            if let Some(hit) = dfs_decode(&cand, &tokens[k..]) {
                return Some(hit);
            }
        }
    }
    None
}

/// 目录名的内容部分（去掉首尾的 `--`）。
fn dir_inner(dir_name: &str) -> &str {
    dir_name.strip_prefix("--").and_then(|s| s.strip_suffix("--")).unwrap_or(dir_name)
}

/// 记忆目录名是否合法（omp 的编码形如 `--xxx--`）。
fn is_memory_dir_name(dir_name: &str) -> bool {
    dir_name.starts_with("--") && dir_name.ends_with("--") && dir_name.len() > 4
}

// ---------- 路径安全 ----------

/// 把 (记忆目录名, 相对文件路径) 解析成真实路径，**越界即报错**。
///
/// `dir` 只允许单层目录名（无分隔符、非 `.` / `..`）；`rel` 逐段校验只允许普通分量
/// （绝对路径 / `..` / `.` 全拒）。目录 canonicalize 后必须仍在记忆根内；文件若已存在
/// 再 canonicalize 复核一次（防目录内符号链接指向根外），不存在（如刚被删）则用
/// 已校验的分量拼接结果。
fn safe_path(root: &Path, dir: &str, rel: Option<&str>) -> Result<PathBuf, CmdError> {
    if dir.is_empty()
        || dir.contains('/')
        || dir.contains('\\')
        || dir.contains('\0')
        || dir == "."
        || dir == ".."
    {
        return Err(cmd_err("BAD_ARG", format!("非法记忆目录名：{dir}"), None));
    }
    let root = root
        .canonicalize()
        .map_err(|_| cmd_err("NOT_FOUND", "记忆目录不存在".into(), None))?;
    let dir_path = root
        .join(dir)
        .canonicalize()
        .map_err(|_| cmd_err("NOT_FOUND", format!("记忆目录不存在：{dir}"), None))?;
    if !dir_path.starts_with(&root) {
        return Err(cmd_err("BAD_ARG", "路径越界（不在记忆目录内）".into(), None));
    }
    let Some(rel) = rel else { return Ok(dir_path) };
    if rel.is_empty() || rel.contains('\\') || rel.contains('\0') {
        return Err(cmd_err("BAD_ARG", format!("非法记忆文件路径：{rel}"), None));
    }
    for c in Path::new(rel).components() {
        if !matches!(c, Component::Normal(_)) {
            return Err(cmd_err("BAD_ARG", format!("非法记忆文件路径：{rel}"), None));
        }
    }
    let full = dir_path.join(rel);
    if let Ok(canon) = full.canonicalize() {
        if !canon.starts_with(&root) {
            return Err(cmd_err("BAD_ARG", "路径越界（不在记忆目录内）".into(), None));
        }
        return Ok(canon);
    }
    Ok(full)
}

// ---------- 文件枚举 ----------

/// 相对路径 → 分类（前端据此显示中文标签）。
pub fn file_kind(rel: &str) -> &'static str {
    match rel {
        "MEMORY.md" => "memory",
        "memory_summary.md" => "summary",
        "raw_memories.md" => "raw",
        "learned.md" => "learned",
        _ if rel.starts_with("rollout_summaries/") => "rollout",
        _ if rel.starts_with("skills/") => "skill",
        _ => "other",
    }
}

/// 展示顺序：核心文件按 [`CORE_ORDER`] 置顶，其余按相对路径字典序。
fn sort_key(rel: &str) -> (usize, &str) {
    match CORE_ORDER.iter().position(|c| *c == rel) {
        Some(i) => (i, ""),
        None => (CORE_ORDER.len(), rel),
    }
}

/// 列一个记忆目录下的全部文件（递归；跳过隐藏文件与符号链接）。
pub fn collect_files(dir: &Path) -> Vec<MemoryFileView> {
    let mut out: Vec<MemoryFileView> = vec![];
    walk(dir, "", 0, &mut out);
    out.sort_by(|a, b| sort_key(&a.path).cmp(&sort_key(&b.path)));
    out
}

fn walk(dir: &Path, prefix: &str, depth: usize, out: &mut Vec<MemoryFileView>) {
    if depth > DEPTH_MAX || out.len() >= FILES_MAX {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        if out.len() >= FILES_MAX {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // 隐藏文件（.DS_Store 之类）不进展示面——它们不是记忆内容
        if name.starts_with('.') {
            continue;
        }
        let Ok(ft) = entry.file_type() else { continue };
        let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        // file_type() 不跟随符号链接：symlink 两边都不命中，自然被跳过
        if ft.is_dir() {
            walk(&entry.path(), &rel, depth + 1, out);
        } else if ft.is_file() {
            let meta = entry.metadata().ok();
            out.push(MemoryFileView {
                kind: file_kind(&rel).to_string(),
                path: rel,
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                modified: meta.as_ref().map(mtime_ms).unwrap_or(0),
            });
        }
    }
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------- 列表 ----------

/// 列记忆清单（不碰 tauri，可在临时目录上做真实行为测试）。
/// 目录按最近修改倒序——刚整理过记忆的项目排前面。
pub fn list_memories_in(root: &Path, projects: &[(String, String)]) -> Vec<MemoryProjectView> {
    let Ok(rd) = std::fs::read_dir(root) else { return vec![] };
    let mut out: Vec<MemoryProjectView> = vec![];
    for entry in rd.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().to_string();
        if !is_memory_dir_name(&dir_name) {
            continue;
        }
        let files = collect_files(&entry.path());
        let total_bytes: u64 = files.iter().map(|f| f.size).sum();
        let updated_at = files.iter().map(|f| f.modified).max().unwrap_or(0);
        let decoded = decode_cwd(&dir_name);
        let decoded_str = decoded.as_ref().map(|p| p.to_string_lossy().to_string());
        let project_id = decoded_str.as_deref().and_then(|p| owner_project(projects, p));
        let name = project_id
            .as_deref()
            .and_then(|id| projects.iter().find(|(pid, _)| pid == id))
            .map(|(_, path)| base_name(path))
            .or_else(|| {
                decoded.as_ref().and_then(|p| p.file_name().map(|s| s.to_string_lossy().to_string()))
            })
            .unwrap_or_else(|| dir_inner(&dir_name).to_string());
        out.push(MemoryProjectView {
            dir: dir_name,
            path: decoded_str,
            name,
            project_id,
            files,
            total_bytes,
            updated_at,
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

fn base_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

/// 截到 `max` 字节，且不切碎 UTF-8 字符（往前退到字符边界）。
fn truncate_utf8(bytes: &[u8], max: usize) -> &[u8] {
    if bytes.len() <= max {
        return bytes;
    }
    let mut end = max;
    while end > 0 && (bytes[end] & 0xC0) == 0x80 {
        end -= 1;
    }
    &bytes[..end]
}

/// 删文件后把变空的父目录链收掉（`skills/<name>/` 删空后不留空壳），
/// 到记忆根为止——根目录本身永远保留。
fn prune_empty_parents(root: &Path, from: Option<&Path>) {
    let Ok(root) = root.canonicalize() else { return };
    let mut cur = from.map(|p| p.to_path_buf());
    while let Some(dir) = cur {
        if dir == root {
            break;
        }
        let empty = std::fs::read_dir(&dir).map(|mut it| it.next().is_none()).unwrap_or(false);
        if !empty || std::fs::remove_dir(&dir).is_err() {
            break;
        }
        cur = dir.parent().map(|p| p.to_path_buf());
    }
}

// ---------- 命令 ----------

/// 记忆清单：`<agentDir>/memories/` 下的项目目录 + 文件明细。
#[tauri::command]
pub async fn list_memories(state: State<'_, AppState>) -> Result<Vec<MemoryProjectView>, CmdError> {
    let agent = state.agent_dir.lock().await.clone();
    let projects: Vec<(String, String)> = {
        let ov = state.overlay.lock().await;
        ov.projects.iter().map(|p| (p.id.clone(), p.path.clone())).collect()
    };
    // 归属匹配集含 worktree：omp 在 worktree 里跑出来的记忆目录也归到所属项目
    let scope = crate::commands::ownership_scope(&projects).await;
    Ok(list_memories_in(&agent.join("memories"), &scope))
}

/// 读单个记忆文件的正文（超上限截断并标记）。
#[tauri::command]
pub async fn read_memory_file(
    state: State<'_, AppState>,
    dir: String,
    file: String,
) -> Result<MemoryFileContent, CmdError> {
    let agent = state.agent_dir.lock().await.clone();
    let path = safe_path(&agent.join("memories"), &dir, Some(&file))?;
    let meta = std::fs::metadata(&path)
        .map_err(|e| cmd_err("NOT_FOUND", format!("读取失败：{e}"), None))?;
    if !meta.is_file() {
        return Err(cmd_err("BAD_ARG", format!("不是文件：{file}"), None));
    }
    let bytes = std::fs::read(&path).map_err(|e| cmd_err("READ_FAILED", format!("读取失败：{e}"), None))?;
    let total = bytes.len();
    let cut = truncate_utf8(&bytes, READ_MAX_BYTES);
    Ok(MemoryFileContent {
        text: String::from_utf8_lossy(cut).to_string(),
        bytes: total as u64,
        truncated: cut.len() < total,
        modified: mtime_ms(&meta),
    })
}

/// 删除单个记忆文件（不可撤销）。
#[tauri::command]
pub async fn delete_memory_file(
    state: State<'_, AppState>,
    dir: String,
    file: String,
) -> Result<(), CmdError> {
    let root = state.agent_dir.lock().await.clone().join("memories");
    let path = safe_path(&root, &dir, Some(&file))?;
    std::fs::remove_file(&path).map_err(|e| cmd_err("DELETE_FAILED", format!("删除失败：{e}"), None))?;
    prune_empty_parents(&root, path.parent());
    Ok(())
}

/// 清空一个项目的全部记忆（删整个记忆目录，不可撤销）。
#[tauri::command]
pub async fn delete_memory_project(state: State<'_, AppState>, dir: String) -> Result<(), CmdError> {
    let root = state.agent_dir.lock().await.clone().join("memories");
    let path = safe_path(&root, &dir, None)?;
    std::fs::remove_dir_all(&path)
        .map_err(|e| cmd_err("DELETE_FAILED", format!("删除失败：{e}"), None))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omp-mem-test-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// omp 的目录名编码（`--` + 绝对路径去首斜杠、分隔符换 `-` + `--`）。
    /// 生产路径不需要编码（记忆目录由 omp 创建），这里只为单测做往返验证。
    fn encode_cwd(p: &Path) -> String {
        let s = p.to_string_lossy();
        let body = s.trim_start_matches('/').replace(['/', '\\', ':'], "-");
        format!("--{body}--")
    }

    // ---------- 目录名解码 ----------

    #[test]
    fn decode_round_trips_plain_and_dashed_paths() {
        let root = tmp_root("decode");
        // 三种路径：普通 / 含连字符的目录（编码有歧义，必须靠真实文件系统解）/ 深层
        let plain = root.join("proj");
        let dashed = root.join("ESV-tracsys-web");
        let nested = root.join("a").join("b-c").join("d");
        for p in [&plain, &dashed, &nested] {
            std::fs::create_dir_all(p).unwrap();
        }
        for p in [&plain, &dashed, &nested] {
            let canon = p.canonicalize().unwrap();
            let code = encode_cwd(&canon);
            assert_eq!(
                decode_cwd(&code).map(|d| d.canonicalize().unwrap()),
                Some(canon.clone()),
                "目录名 {code} 应解回 {}",
                canon.display()
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn decode_rejects_malformed_and_missing() {
        assert_eq!(decode_cwd("not-encoded"), None, "缺 -- 包裹不算记忆目录");
        assert_eq!(decode_cwd("----"), None, "内容为空");
        assert_eq!(decode_cwd("--no-such-path-xyzzy--"), None, "解不出真实目录");
    }

    #[test]
    fn dir_name_shape_is_checked() {
        assert!(is_memory_dir_name("--Users-me-proj--"));
        assert!(!is_memory_dir_name("-Users-me--"), "sessions 那套编码不是记忆目录名");
        assert!(is_memory_dir_name("--x--"), "单字符路径（/x）也是合法编码");
        assert!(!is_memory_dir_name("----"), "内容为空不算");
        assert_eq!(dir_inner("--Users-me-proj--"), "Users-me-proj");
    }

    // ---------- 文件枚举与排序 ----------

    #[test]
    fn collect_files_sorts_core_first_and_skips_hidden() {
        let root = tmp_root("files");
        std::fs::write(root.join("MEMORY.md"), "x").unwrap();
        std::fs::write(root.join("raw_memories.md"), "x").unwrap();
        std::fs::write(root.join("memory_summary.md"), "x").unwrap();
        std::fs::write(root.join(".DS_Store"), "x").unwrap();
        std::fs::create_dir_all(root.join("rollout_summaries")).unwrap();
        std::fs::write(root.join("rollout_summaries/a.md"), "x").unwrap();
        std::fs::create_dir_all(root.join("skills/foo/scripts")).unwrap();
        std::fs::write(root.join("skills/foo/SKILL.md"), "x").unwrap();
        std::fs::write(root.join("skills/foo/scripts/run.py"), "x").unwrap();
        let files = collect_files(&root);
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "MEMORY.md",
                "memory_summary.md",
                "raw_memories.md",
                "rollout_summaries/a.md",
                "skills/foo/SKILL.md",
                "skills/foo/scripts/run.py",
            ],
            "核心文件置顶、其余按路径字典序、隐藏文件不进列表"
        );
        assert_eq!(files[0].kind, "memory");
        assert_eq!(files[3].kind, "rollout");
        assert_eq!(files[4].kind, "skill");
        assert_eq!(files[5].kind, "skill", "skills 下的脚本同属技能包");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_memories_resolves_project_and_falls_back() {
        let root = tmp_root("list");
        let proj = root.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(proj.join("MEMORY.md"), "hello").unwrap();
        // 能解出真实路径的目录 + 解不出的目录（模拟项目已删）
        let mem = root.join("memories");
        std::fs::create_dir_all(mem.join(encode_cwd(&proj.canonicalize().unwrap()))).unwrap();
        std::fs::write(mem.join(encode_cwd(&proj.canonicalize().unwrap())).join("MEMORY.md"), "hello").unwrap();
        std::fs::create_dir_all(mem.join("--no-such-project-xyzzy--")).unwrap();
        std::fs::write(mem.join("--no-such-project-xyzzy--/raw_memories.md"), "raw").unwrap();

        let projects = vec![("p1".to_string(), proj.to_string_lossy().to_string())];
        let rows = list_memories_in(&mem, &projects);
        assert_eq!(rows.len(), 2);
        let hit = rows.iter().find(|r| r.project_id.is_some()).unwrap();
        assert_eq!(hit.name, "proj", "命中覆盖层项目时显示项目名");
        assert_eq!(hit.project_id.as_deref(), Some("p1"));
        assert_eq!(hit.total_bytes, 5);
        assert!(hit.updated_at > 0, "修改时间要透出（列表按它倒序）");
        let miss = rows.iter().find(|r| r.project_id.is_none()).unwrap();
        assert_eq!(miss.path, None, "解不出的目录 path 为 null");
        assert_eq!(miss.name, "no-such-project-xyzzy", "退回编码名（去掉 --）");
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---------- 路径安全 ----------

    #[test]
    fn safe_path_rejects_escapes() {
        let root = tmp_root("safe");
        let mem = root.join("memories");
        let ok_dir = mem.join("--proj--");
        std::fs::create_dir_all(&ok_dir).unwrap();
        std::fs::write(ok_dir.join("MEMORY.md"), "x").unwrap();
        let outside = root.join("secret.txt");
        std::fs::write(&outside, "x").unwrap();

        // 合法路径：目录 + 文件
        assert!(safe_path(&mem, "--proj--", None).is_ok());
        assert!(safe_path(&mem, "--proj--", Some("MEMORY.md")).is_ok());
        // 目录名层面：分隔符 / 相对路径 / 空
        for bad in ["../memories", "a/b", "a\\b", "..", ".", ""] {
            assert!(safe_path(&mem, bad, None).is_err(), "目录名 {bad} 必须拒绝");
        }
        // 文件名层面：绝对路径 / 上跳 / 反斜杠 / 空
        for bad in ["/etc/passwd", "../secret.txt", "a/../../secret.txt", "a\\b", ""] {
            assert!(safe_path(&mem, "--proj--", Some(bad)).is_err(), "文件路径 {bad} 必须拒绝");
        }
        // 目录不存在 → 报错（不静默返回拼接路径）
        assert!(safe_path(&mem, "--nope--", None).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn truncate_utf8_keeps_char_boundary() {
        let zh = "中文内容测试".as_bytes();
        // 从中间切开也要退到字符边界，不能产出半个字符
        let cut = truncate_utf8(zh, 7);
        assert!(std::str::from_utf8(cut).is_ok());
        assert!(cut.len() <= 7);
        assert_eq!(truncate_utf8(b"abc", 10), b"abc", "短内容原样返回");
    }

    // ---------- 读 / 删（临时目录真实行为） ----------

    #[test]
    fn read_and_delete_real_files() {
        let root = tmp_root("rw");
        let mem = root.join("memories");
        let dir = mem.join("--proj--");
        std::fs::create_dir_all(dir.join("skills/foo/scripts")).unwrap();
        std::fs::write(dir.join("MEMORY.md"), "长期记忆").unwrap();
        std::fs::write(dir.join("skills/foo/SKILL.md"), "技能").unwrap();
        std::fs::write(dir.join("skills/foo/scripts/run.py"), "print(1)").unwrap();

        // 路径解析 + 读取
        let p = safe_path(&mem, "--proj--", Some("MEMORY.md")).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "长期记忆");

        // 删脚本：scripts 变空被收掉，foo 里还有 SKILL.md → 保留
        let f = safe_path(&mem, "--proj--", Some("skills/foo/scripts/run.py")).unwrap();
        std::fs::remove_file(&f).unwrap();
        prune_empty_parents(&mem, f.parent());
        assert!(!dir.join("skills/foo/scripts").exists(), "删空的目录链要收掉");
        assert!(dir.join("skills/foo/SKILL.md").exists(), "同目录还有内容，父目录保留");

        // 再删 SKILL.md：foo 与 skills 一起收掉；记忆目录本身保留（里面还有 MEMORY.md）
        let f2 = safe_path(&mem, "--proj--", Some("skills/foo/SKILL.md")).unwrap();
        std::fs::remove_file(&f2).unwrap();
        prune_empty_parents(&mem, f2.parent());
        assert!(!dir.join("skills").exists(), "空目录链一路收到记忆目录为止");
        assert!(dir.exists(), "记忆目录里还有 MEMORY.md，绝不连它一起删");

        // 清空整个记忆目录
        let d = safe_path(&mem, "--proj--", None).unwrap();
        std::fs::remove_dir_all(&d).unwrap();
        assert!(!dir.exists());
        assert!(mem.exists(), "记忆根目录永远保留");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_agent_dir_yields_empty_list() {
        let projects: Vec<(String, String)> = vec![];
        assert!(list_memories_in(Path::new("/tmp/omp-mem-definitely-missing"), &projects).is_empty());
    }
}
