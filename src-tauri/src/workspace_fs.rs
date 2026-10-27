//! 右栏「文件」页签的目录读取（v4 右栏改造）：只读、单层、懒加载。
//!
//! 不做递归树（大仓库一次全量会卡首屏）、不读文件内容、不写文件——范围边界见 `AGENTS.md`
//! 「不做编辑器」：这里只回答「这个目录里有什么」，打开交给系统默认程序。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::commands::{cmd_err, CmdError};
use crate::git_info::{git_bin, run_git};

/// 单层条目上限：`node_modules` / 构建产物目录动辄上万项，列全了既卡界面也没人看。
const MAX_ENTRIES: usize = 2000;

/// 搜索跳过的目录名（依赖 / 缓存 / 构建中间产物）：搜索是为了找**源码**，
/// 钻进这些目录只会把结果淹掉、还拖慢遍历。命中本身不受影响（搜 `node_modules` 照样能搜到它）。
const SEARCH_SKIP_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    ".gradle",
    ".idea",
    ".mypy_cache",
    ".pytest_cache",
    "Pods",
];

/// 搜索最大深度（防极端深目录；符号链接一律不跟，天然无环）。
const SEARCH_MAX_DEPTH: usize = 24;
/// 搜索扫描条目预算：到顶即停并如实标记截断（大仓库里搜一个字母也不许把界面卡死）。
const SEARCH_SCAN_BUDGET: usize = 200_000;
/// 搜索命中收集上限：先收够再排序取前 N，避免「先到先得」把好匹配挤掉。
const SEARCH_HIT_BUDGET: usize = 800;

/// 目录里的一个条目。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// 绝对路径（前端打开 / 引用注入直接用它）。
    pub path: String,
    /// 是否目录：**跟随符号链接**后的判断（链接到目录也能展开）。
    pub is_dir: bool,
    /// 符号链接（前端标 `↗`，避免把它当成真实目录）。
    pub is_symlink: bool,
    /// 文件字节数；目录 / stat 失败时为 None。
    pub size: Option<u64>,
}

/// 一次目录列举的结果。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    /// 父目录（已是文件系统根时为 None）。
    pub parent: Option<String>,
    pub entries: Vec<DirEntry>,
    /// 命中 [`MAX_ENTRIES`]：前端注明「还有更多未列出」。
    pub truncated: bool,
    /// 该目录所属 git 仓库根（`withRepoRoot` 为真且确实在仓库内时给）：
    /// 前端用它把 `get_change_set` 的相对路径换算成树节点的绝对路径，做变更标色。
    pub repo_root: Option<String>,
}

/// 读一层目录（纯函数，便于单测）：目录优先 + 名称升序（大小写不敏感），超限截断。
pub fn read_entries(dir: &str) -> Result<(Vec<DirEntry>, bool), CmdError> {
    let rd = std::fs::read_dir(dir).map_err(|e| cmd_err("DIR_READ", e.to_string(), Some(dir.to_string())))?;
    let mut out = Vec::new();
    for item in rd.flatten() {
        let path = item.path();
        let meta = std::fs::symlink_metadata(&path);
        let is_symlink = meta.as_ref().map(|m| m.file_type().is_symlink()).unwrap_or(false);
        // 链接按目标判类型：链接到目录要能展开，链接断了就当普通条目
        let is_dir = if is_symlink {
            std::fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false)
        } else {
            meta.as_ref().map(|m| m.is_dir()).unwrap_or(false)
        };
        let size = if is_dir { None } else { std::fs::metadata(&path).ok().map(|m| m.len()) };
        out.push(DirEntry {
            name: item.file_name().to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            is_dir,
            is_symlink,
            size,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    let truncated = out.len() > MAX_ENTRIES;
    out.truncate(MAX_ENTRIES);
    Ok((out, truncated))
}

/// 该目录所属仓库根（非仓库 / git 不可用 / 超时都返回 None，前端降级为不标色）。
async fn repo_root_of(dir: &str) -> Option<String> {
    let git = git_bin().await?;
    let out = run_git(&git, dir, &["rev-parse", "--show-toplevel"]).await.ok()?;
    let text = out.trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// 列一层目录（右栏文件树的懒加载入口）。
///
/// `with_repo_root` 只在树根加载时传 true：仓库根每次展开都问一遍 git 是白花开销。
#[tauri::command]
pub async fn list_dir(path: String, with_repo_root: Option<bool>) -> Result<DirListing, CmdError> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(cmd_err("DIR_MISSING", "目录不存在".into(), Some(path.clone())));
    }
    // 本地读盘通常很快，但超大目录仍可能几十毫秒：放阻塞线程池，不占 tokio worker。
    let target = path.clone();
    let (entries, truncated) = tauri::async_runtime::spawn_blocking(move || read_entries(&target))
        .await
        .map_err(|e| cmd_err("DIR_READ", e.to_string(), None))??;
    let repo_root = if with_repo_root.unwrap_or(false) {
        repo_root_of(&path).await
    } else {
        None
    };
    Ok(DirListing {
        path: path.clone(),
        parent: dir.parent().map(|p| p.to_string_lossy().into_owned()),
        entries,
        truncated,
        repo_root,
    })
}

/// 搜索命中项（右栏文件页签的快速过滤）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathHit {
    /// 条目名（最后一段）。
    pub name: String,
    /// 相对搜索根（POSIX 分隔；前端直接显示这个，不是绝对路径）。
    pub rel: String,
    /// 绝对路径（前端打开 / 引用注入用它）。
    pub path: String,
    pub is_dir: bool,
}

/// 一次搜索的结果。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub hits: Vec<PathHit>,
    /// 结果被截断（命中 / 扫描预算用尽，或超出 `limit`）：界面据此注明「继续输入以缩小范围」。
    pub truncated: bool,
}

/// 条目表缓存 TTL：一次全量遍历（跳依赖目录）几毫秒到几十毫秒，标签 / 后缀解析共用一张表；
/// 30s 足够新鲜，也免掉「展开每层目录都重扫一遍」。
const ENTRIES_TTL: Duration = Duration::from_secs(30);
/// 缓存条目上限：超过直接清表（简单防膨胀，与 `project_files` 同风格）。
const ENTRIES_CACHE_MAX: usize = 32;

/// root → `(写入时刻, [(相对路径, 是否目录)])`。
static ENTRIES_CACHE: LazyLock<Mutex<HashMap<String, (Instant, Arc<Vec<(String, bool)>>)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 遍历整棵树收集 `(相对路径, 是否目录)`：跳依赖与缓存目录、深度与条目数带预算、符号链接不跟。
/// 命中预算就停（返回已收集的部分）——标签与后缀解析只需要「大致全」的视野。
pub fn collect_entries(root: &str) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    let mut stack: Vec<(PathBuf, String, usize)> = vec![(PathBuf::from(root), String::new(), 0)];
    let mut scanned = 0usize;
    while let Some((dir, rel, depth)) = stack.pop() {
        if depth > SEARCH_MAX_DEPTH {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for item in rd.flatten() {
            scanned += 1;
            if scanned > SEARCH_SCAN_BUDGET {
                return out;
            }
            let Ok(file_type) = item.file_type() else { continue };
            let name = item.file_name().to_string_lossy().into_owned();
            let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let is_dir = file_type.is_dir();
            let skip = SEARCH_SKIP_DIRS.contains(&name.as_str());
            if is_dir && !skip {
                stack.push((item.path(), child.clone(), depth + 1));
            }
            out.push((child, is_dir));
        }
    }
    out
}

/// 取（并缓存）某棵树的条目表；缓存未命中才重新遍历（锁只在读写缓存时持有）。
pub fn entries_for(root: &str) -> Arc<Vec<(String, bool)>> {
    if let Ok(map) = ENTRIES_CACHE.lock() {
        if let Some((at, list)) = map.get(root) {
            if at.elapsed() < ENTRIES_TTL {
                return list.clone();
            }
        }
    }
    let fresh = Arc::new(collect_entries(root));
    if let Ok(mut map) = ENTRIES_CACHE.lock() {
        if map.len() >= ENTRIES_CACHE_MAX {
            map.clear();
        }
        map.insert(root.to_string(), (Instant::now(), fresh.clone()));
    }
    fresh
}

/// 标签体系统一用 `/` 分隔：Windows 传来的 `\` 先归一，后续切段 / 前缀比较只认一种写法。
fn normalize_slashes(s: &str) -> String {
    s.replace('\\', "/")
}

/// 路径的各级后缀（`a/b/c` → `["c", "b/c", "a/b/c"]`，短的在前；`/` 是 ASCII，切字节安全）。
fn suffixes(rel: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut end = rel.len();
    loop {
        let start = rel[..end].rfind('/').map(|i| i + 1).unwrap_or(0);
        out.push(&rel[start..]);
        if start == 0 {
            break;
        }
        end = start - 1;
    }
    out
}

/// 一批相对路径 → **最短唯一后缀**（输入框 `@` 标签用它：`src/views/…/components` → `components`）。
///
/// 唯一性看全库：段数从 1 开始增长，取第一个只对应这一个条目的后缀；都不唯一 → 完整相对路径
/// （它本身必然唯一）。`all` = 同一棵树的全量条目（`entries_for`）。
pub fn unique_labels(all: &[(String, bool)], targets: &[String]) -> HashMap<String, String> {
    // Windows 的 `rel` 可能带 `\`：归一后再切后缀；输出 key 仍是调用方给的原字符串。
    let targets_norm: Vec<String> = targets.iter().map(|t| normalize_slashes(t)).collect();
    let mut need: HashSet<String> = HashSet::new();
    for target in &targets_norm {
        for suffix in suffixes(target) {
            if !suffix.is_empty() {
                need.insert(suffix.to_string());
            }
        }
    }
    // 目标的 1 段后缀必然也在 need 里（它本身就是某目标的后缀），所以「尾段都不在 need」
    // 的条目一个 need 后缀都贡献不了，可以整体跳过——这让全库扫描基本只做一次哈希查询。
    let mut counts: HashMap<String, usize> = HashMap::new();
    for (rel, _) in all {
        let rel = normalize_slashes(rel);
        let segs = suffixes(&rel);
        if !segs.first().is_some_and(|tail| need.contains(*tail)) {
            continue;
        }
        for suffix in segs {
            if need.contains(suffix) {
                *counts.entry(suffix.to_string()).or_insert(0) += 1;
            }
        }
    }
    let mut out = HashMap::new();
    for (target, target_norm) in targets.iter().zip(&targets_norm) {
        let label = suffixes(target_norm)
            .into_iter()
            .find(|suffix| counts.get(*suffix).copied().unwrap_or(0) == 1)
            .unwrap_or(target_norm.as_str());
        out.insert(target.clone(), label.to_string());
    }
    out
}

/// 后缀反解：`components/` → 全库里**唯一**以它结尾的条目；不唯一（歧义）或没有 → None。
/// 芯片的存在性、发送前的短标签展开共用它（同一套规则，两边不会各说各话）。
pub fn resolve_suffix(all: &[(String, bool)], token: &str) -> Option<(String, bool)> {
    let needle = normalize_slashes(token);
    let needle = needle.trim_end_matches('/');
    if needle.is_empty() || needle.contains("..") {
        return None;
    }
    let tail = format!("/{needle}");
    let mut hit: Option<(String, bool)> = None;
    for (rel, is_dir) in all {
        let rel = normalize_slashes(rel);
        if rel == needle || rel.ends_with(&tail) {
            if hit.is_some() {
                return None; // 歧义：不猜
            }
            // 返回归一后的相对路径（前端芯片 / 发送前展开都用正斜杠）
            hit = Some((rel, *is_dir));
        }
    }
    hit
}

/// 绝对路径 → 相对 `base` 的路径：不在 `base` 之内（含等于）→ None。
/// 与前端 `lib/workspaceFiles.ts` 的 `relativeToCwd` 同一口径。
///
/// 输入先归一成 `/`：Windows 的 `C:\proj` 与 `C:\proj\src` 不能靠字符串前缀直接切
/// （`strip_prefix` 会留下 `\src`）；盘符大小写不敏感（`C:` / `c:` 视为同一盘）。
pub fn rel_to(base: &str, path: &str) -> Option<String> {
    let base = normalize_slashes(base);
    let path = normalize_slashes(path);
    let base = base.trim_end_matches('/');
    let base = if base.is_empty() { "/" } else { base };
    let path = path.trim_end_matches('/');
    if path.is_empty() || path.eq_ignore_ascii_case(base) {
        return None;
    }
    let rest = if base == "/" {
        path.strip_prefix('/')?
    } else {
        // 用 get(..len) 而不是直接切片：用户目录可能含非 ASCII，切在字符中间会 panic。
        let head = path.get(..base.len())?;
        if !head.eq_ignore_ascii_case(base) || path.as_bytes().get(base.len()) != Some(&b'/') {
            return None;
        }
        &path[base.len() + 1..]
    };
    (!rest.is_empty() && !rest.split('/').any(|part| part == "..")).then(|| rest.to_string())
}

/// 单条命中的相关度（越大越靠前；None = 不匹配）。
///
/// 判据从强到弱：名字精确 → 名字前缀 → 名字内包含（位置越靠前越好）→ 仅路径包含；
/// 同档再按「层级浅、路径短」加分——`src/a.ts` 要排在 `deep/deeper/a.ts` 前面。
///
/// **路径包含只在查询自带 `/` 时才算命中**（`src/comp` 这类带层级的写法）：否则搜 `src`
/// 会把 `src` 下每个文件都列出来（它们的相对路径都含 `src/`），结果全是没有信息量的噪音。
fn match_score(lower_query: &str, name: &str, rel: &str) -> Option<i64> {
    let n = name.to_lowercase();
    let base = if n == lower_query {
        1000
    } else if n.starts_with(lower_query) {
        900
    } else if let Some(pos) = n.find(lower_query) {
        800 - pos.min(150) as i64
    } else if lower_query.contains('/') && rel.to_lowercase().contains(lower_query) {
        600
    } else {
        return None;
    };
    let depth = rel.matches('/').count() as i64;
    Some(base - depth * 5 - (rel.len() as i64) / 8)
}

/// 递归搜索（纯函数，便于单测）：名字 / 相对路径包含 `query` 的都算命中，
/// 深度 + 扫描条目 + 命中数三重预算，返回 `(命中, 是否截断)`。
pub fn search_entries(root: &str, query: &str, limit: usize) -> (Vec<PathHit>, bool) {
    let q = query.trim().to_lowercase();
    if q.is_empty() || limit == 0 {
        return (vec![], false);
    }
    let mut stack: Vec<(PathBuf, String, usize)> = vec![(PathBuf::from(root), String::new(), 0)];
    let mut scored: Vec<(i64, PathHit)> = Vec::new();
    let mut scanned = 0usize;
    let mut truncated = false;
    while let Some((dir, rel, depth)) = stack.pop() {
        if depth > SEARCH_MAX_DEPTH {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        // 目录顺序不影响最终排序（分数 + 路径决定），所以不做 collect 排序，直接遍历
        for item in rd.flatten() {
            scanned += 1;
            if scanned > SEARCH_SCAN_BUDGET {
                truncated = true;
                break;
            }
            let Ok(file_type) = item.file_type() else { continue };
            let name = item.file_name().to_string_lossy().into_owned();
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let is_dir = file_type.is_dir();
            // 跳过判断要在 `name` 被 move 进命中项之前算（跳过的目录本身仍可被搜到，只是不进去）
            let skip = SEARCH_SKIP_DIRS.contains(&name.as_str());
            if let Some(score) = match_score(&q, &name, &child_rel) {
                if scored.len() >= SEARCH_HIT_BUDGET {
                    truncated = true;
                } else {
                    scored.push((
                        score,
                        PathHit {
                            name,
                            rel: child_rel.clone(),
                            path: item.path().to_string_lossy().into_owned(),
                            is_dir,
                        },
                    ));
                }
            }
            // 只递归真实目录（符号链接不跟）
            if is_dir && !skip {
                stack.push((item.path(), child_rel, depth + 1));
            }
        }
        if scanned > SEARCH_SCAN_BUDGET {
            break;
        }
    }
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.rel.len().cmp(&b.1.rel.len()))
            .then_with(|| a.1.rel.cmp(&b.1.rel))
    });
    if scored.len() > limit {
        truncated = true;
        scored.truncate(limit);
    }
    (scored.into_iter().map(|(_, hit)| hit).collect(), truncated)
}

/// 右栏文件页签的快速过滤：按名字 / 相对路径搜索文件与文件夹（**只读**，不读文件内容）。
///
/// 目标目录 = 当前会话 cwd（与文件树同一个根）；命中给相对路径，前端显示与引用注入都用它。
#[tauri::command]
pub async fn search_paths(root: String, query: String, limit: Option<usize>) -> Result<SearchResult, CmdError> {
    if !Path::new(&root).is_dir() {
        return Err(cmd_err("DIR_MISSING", "目录不存在".into(), Some(root)));
    }
    let cap = limit.unwrap_or(200).clamp(1, SEARCH_HIT_BUDGET);
    // 递归遍历是纯 CPU + 磁盘活：放阻塞线程池，不占 tokio worker
    let target = root.clone();
    let (hits, truncated) =
        tauri::async_runtime::spawn_blocking(move || search_entries(&target, &query, cap))
            .await
            .map_err(|e| cmd_err("DIR_READ", e.to_string(), None))?;
    Ok(SearchResult { hits, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_entries_lists_dirs_first() {
        // 用本 crate 目录做真样本（Cargo.toml 是文件、src 是目录）
        let dir = env!("CARGO_MANIFEST_DIR");
        let (entries, truncated) = read_entries(dir).expect("读目录");
        assert!(!truncated);
        let cargo = entries.iter().find(|e| e.name == "Cargo.toml").expect("Cargo.toml");
        assert!(!cargo.is_dir);
        assert!(cargo.size.unwrap_or(0) > 0);
        assert!(entries.iter().any(|e| e.name == "src" && e.is_dir));
        let first_file = entries.iter().position(|e| !e.is_dir).expect("至少一个文件");
        let last_dir = entries.iter().rposition(|e| e.is_dir).expect("至少一个目录");
        assert!(last_dir < first_file, "目录必须排在文件前面");
    }

    #[test]
    fn read_entries_missing_dir_errors() {
        assert!(read_entries("/nonexistent-omp-inn-dir-for-test").is_err());
    }

    /// 临时目录树：`src/components/FileTree.tsx` / `src/index.ts` / `docs/FileTree.md` /
    /// `node_modules/pkg/index.ts`（应被跳过）。
    fn sample_tree(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("omp-inn-search-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for dir in ["src/components", "docs", "node_modules/pkg"] {
            std::fs::create_dir_all(root.join(dir)).expect("建临时目录");
        }
        std::fs::write(root.join("src/components/FileTree.tsx"), "x").unwrap();
        std::fs::write(root.join("src/index.ts"), "x").unwrap();
        std::fs::write(root.join("docs/FileTree.md"), "x").unwrap();
        std::fs::write(root.join("node_modules/pkg/index.ts"), "x").unwrap();
        root
    }

    #[test]
    fn search_matches_files_and_dirs_with_relative_paths() {
        let root = sample_tree("rel");
        let dir = root.to_str().unwrap();
        // 名字命中：文件与目录都返回，路径是相对根的 POSIX 写法
        let (hits, truncated) = search_entries(dir, "filetree", 50);
        assert!(!truncated);
        assert_eq!(
            hits.iter().map(|h| h.rel.as_str()).collect::<Vec<_>>(),
            vec!["docs/FileTree.md", "src/components/FileTree.tsx"],
            "同分按路径短者先：{hits:?}"
        );
        assert!(!hits[0].is_dir);
        assert_eq!(
            hits[1].path,
            root.join("src/components/FileTree.tsx").to_string_lossy()
        );

        let (dirs, _) = search_entries(dir, "components", 50);
        assert_eq!(dirs.len(), 1, "只按名字匹配，不许把目录下的文件也带出来：{dirs:?}");
        assert!(dirs[0].is_dir, "目录也要能搜到：{dirs:?}");
        assert_eq!(dirs[0].rel, "src/components");

        // 带层级的查询（含 `/`）才按相对路径匹配：`src/` 命中该目录本身与它下面的条目
        let (by_path, _) = search_entries(dir, "src/", 50);
        assert!(by_path.iter().any(|h| h.rel == "src/components/FileTree.tsx"), "{by_path:?}");
        assert!(by_path.iter().all(|h| h.rel.starts_with("src/")), "{by_path:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_skips_dependency_dirs_but_finds_them() {
        let root = sample_tree("skip");
        let dir = root.to_str().unwrap();
        let (hits, _) = search_entries(dir, "index.ts", 50);
        assert_eq!(hits.len(), 1, "node_modules 里的同名文件不许出现：{hits:?}");
        assert_eq!(hits[0].rel, "src/index.ts");
        // 跳过的是「进去搜」，不是「搜不到」：目录本身照旧命中
        let (dirs, _) = search_entries(dir, "node_modules", 50);
        assert!(dirs.iter().any(|h| h.rel == "node_modules" && h.is_dir), "{dirs:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_ranks_exact_and_shallow_first_and_truncates() {
        let root = sample_tree("rank");
        let dir = root.to_str().unwrap();
        // 精确同名 > 前缀 > 包含 > 仅路径包含；层级浅者先
        let (hits, _) = search_entries(dir, "src", 50);
        assert!(hits.iter().any(|h| h.rel == "src" && h.is_dir));
        assert_eq!(hits[0].rel, "src", "精确命中排最前：{hits:?}");
        // limit 生效并标记截断
        let (limited, truncated) = search_entries(dir, "i", 2);
        assert_eq!(limited.len(), 2);
        assert!(truncated);
        // 空查询 / 非法参数：不返回东西，也不报错
        assert!(search_entries(dir, "   ", 10).0.is_empty());
        assert!(search_entries(dir, "x", 0).0.is_empty());
        assert!(search_entries("/nonexistent-omp-inn-search", "x", 10).0.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `@` 标签：最短唯一后缀（尾段唯一就用尾段，重名才逐级加父目录）。
    #[test]
    fn labels_pick_shortest_unique_suffix() {
        let all = vec![
            ("src/views/engineering/baseline/components".to_string(), true),
            ("src/components/FileTree.tsx".to_string(), false),
            ("docs/components.md".to_string(), false),
        ];
        let labels = unique_labels(
            &all,
            &[
                "src/views/engineering/baseline/components".to_string(),
                "src/components/FileTree.tsx".to_string(),
            ],
        );
        assert_eq!(labels["src/views/engineering/baseline/components"], "components");
        assert_eq!(labels["src/components/FileTree.tsx"], "FileTree.tsx");

        // 尾段重名 → 加一层父目录；加到顶都不唯一 → 完整相对路径
        let dup = vec![
            ("src/a/index.ts".to_string(), false),
            ("src/b/index.ts".to_string(), false),
        ];
        let labels = unique_labels(&dup, &["src/a/index.ts".to_string()]);
        assert_eq!(labels["src/a/index.ts"], "a/index.ts");
        let same = vec![("index.ts".to_string(), false), ("sub/index.ts".to_string(), false)];
        let labels = unique_labels(&same, &["sub/index.ts".to_string()]);
        assert_eq!(labels["sub/index.ts"], "sub/index.ts", "都不唯一就只能给完整路径");

        // 目录与同名文件并存：尾段不唯一，照样逐级加
        let mixed = vec![("components".to_string(), true), ("src/components".to_string(), true)];
        let labels = unique_labels(&mixed, &["src/components".to_string()]);
        assert_eq!(labels["src/components"], "src/components");
    }

    /// 后缀反解：唯一才认，歧义不猜；`..` 一律拒绝。
    #[test]
    fn resolve_suffix_only_accepts_unique_hits() {
        let all = vec![
            ("src/views/components".to_string(), true),
            ("src/a/index.ts".to_string(), false),
            ("src/b/index.ts".to_string(), false),
        ];
        assert_eq!(
            resolve_suffix(&all, "components/"),
            Some(("src/views/components".to_string(), true)),
            "目录标签（带尾斜杠）按尾段唯一命中"
        );
        assert_eq!(
            resolve_suffix(&all, "src/a/index.ts"),
            Some(("src/a/index.ts".to_string(), false)),
            "完整相对路径原样命中"
        );
        assert_eq!(resolve_suffix(&all, "index.ts"), None, "两个同名 → 歧义，不猜");
        assert_eq!(resolve_suffix(&all, "nope"), None);
        assert_eq!(resolve_suffix(&all, "../x"), None);
        assert_eq!(resolve_suffix(&all, "/"), None);
    }

    /// 条目表：跳依赖目录（不进去）、符号链接不跟、相对路径是 POSIX 写法。
    #[test]
    fn collect_entries_skips_dependency_dirs() {        let root = sample_tree("entries");
        let dir = root.to_str().unwrap();
        let all = collect_entries(dir);
        let rels: Vec<&str> = all.iter().map(|(rel, _)| rel.as_str()).collect();
        assert!(rels.contains(&"src/components/FileTree.tsx"), "{rels:?}");
        assert!(rels.contains(&"node_modules"), "跳过的目录本身仍要在表里");
        assert!(!rels.contains(&"node_modules/pkg/index.ts"), "但不进去：{rels:?}");
        assert!(all.iter().any(|(rel, is_dir)| rel == "src" && *is_dir));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 绝对路径 → 会话目录内的相对路径（与前端 `relativeToCwd` 同口径）。
    #[test]
    fn rel_to_only_inside_base() {
        assert_eq!(rel_to("/w/alpha", "/w/alpha/src/a.ts").as_deref(), Some("src/a.ts"));
        assert_eq!(rel_to("/w/alpha/", "/w/alpha/src/a.ts").as_deref(), Some("src/a.ts"));
        assert_eq!(rel_to("/w/alpha", "/w/alpha"), None, "目录自己不算相对路径");
        assert_eq!(rel_to("/w/alpha", "/w/alpha-2/a.ts"), None, "同前缀但不是子目录");
        assert_eq!(rel_to("/w/alpha", "/w/beta/a.ts"), None);
        assert_eq!(rel_to("/", "/etc/hosts").as_deref(), Some("etc/hosts"));
        assert_eq!(rel_to("/w/alpha", "/w/alpha/../x"), None, "越界不认");
    }

    /// Windows 的 `\` 与盘符大小写：标签体系仍输出 `/`（前端 split("/") 与 omp 的 `@` 都认它）。
    #[test]
    fn rel_to_accepts_windows_separators() {
        assert_eq!(rel_to(r"C:\proj", r"C:\proj\src\a.ts").as_deref(), Some("src/a.ts"));
        assert_eq!(rel_to(r"c:\proj", r"C:\proj\src").as_deref(), Some("src"), "盘符大小写不敏感");
        assert_eq!(rel_to(r"C:\proj\", r"C:\proj\src\a.ts").as_deref(), Some("src/a.ts"));
        assert_eq!(rel_to(r"C:\proj", r"D:\other\a.ts"), None);
        assert_eq!(rel_to(r"C:\proj", r"C:\proj2\a.ts"), None, "同前缀但不是子目录");
        assert_eq!(
            rel_to(r"\\wsl$\Ubuntu\home\u", r"\\wsl$\Ubuntu\home\u\a.ts").as_deref(),
            Some("a.ts"),
            "WSL UNC 也与普通 Windows 路径同口径"
        );
    }

    #[test]
    fn resolve_suffix_accepts_windows_token() {
        let all = vec![("src/a.ts".to_string(), false), ("src/b.ts".to_string(), false)];
        assert_eq!(resolve_suffix(&all, r"src\a.ts"), Some(("src/a.ts".to_string(), false)));
    }
}
