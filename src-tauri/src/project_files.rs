//! 引用浮层的项目文件列表（V22）：`git ls-files -c -o --exclude-standard -z` 的解析 + 60s 缓存。
//!
//! 只读、失败降级为每项 `error` 字段（不整体失败）：浮层是锦上添花的功能，
//! 某个项目列不出文件不该拖垮整张列表（非 git 目录、git 缺失、超时都落在它自己那一项）。

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::commands::CmdError;
use crate::git_info::{dir_exists, git_bin, run_git_timeout};

/// 单项目文件数上限：超大仓库不整表塞给前端（截断并标记）。
const MAX_FILES: usize = 50_000;
/// `ls-files` 超时：大仓库可能偏慢，比背景徽章那条链路（4s）宽。
const LIST_TIMEOUT: Duration = Duration::from_secs(10);
/// 缓存 TTL：浮层每次打开都会请求，短窗口内直接命中。
const CACHE_TTL: Duration = Duration::from_secs(60);
/// 缓存条目上限：超过直接清表（简单防膨胀，不做 LRU）。
const CACHE_MAX_ENTRIES: usize = 64;

/// 一个项目的文件列表（与前端 `src/shared/types.ts` 的 `ProjectFiles` 同构）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFiles {
    /// 项目主目录（绝对路径；入参原样）。
    pub path: String,
    /// 仓库相对路径（POSIX 分隔；`ls-files` 原样）。
    pub files: Vec<String>,
    /// 是否因 [`MAX_FILES`] 截断。
    pub truncated: bool,
    /// 该项失败原因（目录不存在 / 非 git 仓库 / git 缺失 / 超时）；成功为 None。
    pub error: Option<String>,
}

impl ProjectFiles {
    /// 失败项：空文件表 + 错误原文（调用方不做特殊分支，统一按「有 error 就不列」渲染）。
    fn failed(path: &str, message: String) -> Self {
        Self {
            path: path.to_string(),
            files: vec![],
            truncated: false,
            error: Some(message),
        }
    }
}

/// 解析 `git ls-files -z`：NUL 分隔，丢弃空段。
pub fn parse_ls_files_z(out: &str) -> Vec<String> {
    out.split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// 排序（输出稳定，前端按项目分组直接渲染）+ 截断：返回 `(files, truncated)`。
pub fn finalize_files(mut files: Vec<String>, max: usize) -> (Vec<String>, bool) {
    files.sort_unstable();
    let truncated = files.len() > max;
    files.truncate(max);
    (files, truncated)
}

/// 缓存条目：写入时刻 + 文件表 + 截断标记。
struct CacheEntry {
    at: Instant,
    files: Arc<Vec<String>>,
    truncated: bool,
}

/// 缓存：path → 条目。Arc 让命中路径少一次整表拷贝。
static FILES_CACHE: LazyLock<Mutex<HashMap<String, CacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// TTL 内命中返回 `(文件表, 截断标记)`；过期 / 未命中返回 None（过期条目下次写入时被覆盖）。
fn cache_hit(path: &str) -> Option<(Arc<Vec<String>>, bool)> {
    let map = FILES_CACHE.lock().ok()?;
    let entry = map.get(path)?;
    (entry.at.elapsed() < CACHE_TTL).then(|| (entry.files.clone(), entry.truncated))
}

fn cache_store(path: &str, files: Arc<Vec<String>>, truncated: bool) {
    let Ok(mut map) = FILES_CACHE.lock() else { return };
    if map.len() > CACHE_MAX_ENTRIES {
        map.clear();
    }
    map.insert(
        path.to_string(),
        CacheEntry { at: Instant::now(), files, truncated },
    );
}

/// 单项目取数：`ls-files -c -o --exclude-standard`（已跟踪 + 未跟踪但未被 ignore）。
/// 不是仓库 / git 报错时返回错误原文（调用方落 `error` 字段）。
async fn files_for(git: &str, path: &str) -> Result<(Vec<String>, bool), String> {
    let out = run_git_timeout(
        git,
        path,
        &["ls-files", "-c", "-o", "--exclude-standard", "-z"],
        LIST_TIMEOUT,
    )
    .await?;
    Ok(finalize_files(parse_ls_files_z(&out), MAX_FILES))
}

/// 批量列文件（引用浮层）：并发跑，每项失败只落 `error`；结果顺序 = 入参顺序。
#[tauri::command]
pub async fn list_project_files(paths: Vec<String>) -> Result<Vec<ProjectFiles>, CmdError> {
    if paths.is_empty() {
        return Ok(vec![]);
    }
    let git = git_bin().await;
    let mut set = tokio::task::JoinSet::new();
    for (i, path) in paths.into_iter().enumerate() {
        let git = git.clone();
        set.spawn(async move {
            let item = match &git {
                None => ProjectFiles::failed(&path, "未找到 git".into()),
                Some(_) if !dir_exists(&path) => ProjectFiles::failed(&path, "目录不存在".into()),
                Some(g) => match cache_hit(&path) {
                    Some((files, truncated)) => ProjectFiles {
                        path: path.clone(),
                        files: (*files).clone(),
                        truncated,
                        error: None,
                    },
                    None => match files_for(g, &path).await {
                        Ok((files, truncated)) => {
                            let files = Arc::new(files);
                            cache_store(&path, files.clone(), truncated);
                            ProjectFiles {
                                path: path.clone(),
                                files: (*files).clone(),
                                truncated,
                                error: None,
                            }
                        }
                        Err(e) => ProjectFiles::failed(&path, e),
                    },
                },
            };
            (i, item)
        });
    }
    let mut out: Vec<(usize, ProjectFiles)> = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok((i, item)) = joined {
            out.push((i, item));
        }
    }
    out.sort_by_key(|(i, _)| *i);
    Ok(out.into_iter().map(|(_, item)| item).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    #[test]
    fn parse_ls_files_z_splits_nul_and_drops_empty() {
        assert_eq!(
            parse_ls_files_z("a.txt\0sub/b c.txt\0\0中文.md\0"),
            vec!["a.txt", "sub/b c.txt", "中文.md"]
        );
        assert!(parse_ls_files_z("").is_empty());
    }

    #[test]
    fn finalize_files_sorts_and_truncates() {
        let (files, truncated) = finalize_files(vec!["b".into(), "a".into(), "c".into()], 2);
        assert_eq!(files, vec!["a", "b"]);
        assert!(truncated);
        let (files, truncated) = finalize_files(vec!["z".into(), "y".into()], 5);
        assert_eq!(files, vec!["y", "z"]);
        assert!(!truncated);
    }

    fn git_run(git: &str, dir: &Path, args: &[&str]) {
        let out = Command::new(git)
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git 调用失败");
        assert!(
            out.status.success(),
            "git {args:?} 失败: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// 真实临时仓库：确认「已跟踪 + 未跟踪未忽略」都列出、ignored 不列出、非仓库降级为 Err。
    #[tokio::test]
    async fn lists_files_in_real_repo() {
        let Some(git) = git_bin().await else { return }; // 无 git 环境跳过
        let root = std::env::temp_dir().join(format!("omp-inn-files-{}", std::process::id()));
        let repo = root.join("repo");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(repo.join("sub")).expect("建临时目录");
        std::fs::write(repo.join("a.txt"), "a").unwrap();
        std::fs::write(repo.join("sub/b.txt"), "b").unwrap();
        std::fs::write(repo.join("untracked.txt"), "u").unwrap();
        std::fs::write(repo.join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(repo.join("ignored.txt"), "i").unwrap();
        git_run(&git, &repo, &["init", "-q"]);
        git_run(&git, &repo, &["add", "a.txt", "sub/b.txt", ".gitignore"]);

        let (files, truncated) = files_for(&git, repo.to_str().unwrap())
            .await
            .expect("真实仓库应能列出");
        assert!(files.contains(&"a.txt".to_string()));
        assert!(files.contains(&"sub/b.txt".to_string()));
        assert!(files.contains(&"untracked.txt".to_string()), "未跟踪文件也要列出：{files:?}");
        assert!(files.contains(&".gitignore".to_string()));
        assert!(!files.contains(&"ignored.txt".to_string()), "被 ignore 的不列出：{files:?}");
        assert!(!truncated);

        // 仓库子目录：路径是相对**该项目目录**（`git -C <子目录> ls-files` 的行为，拼绝对路径直接可用）
        let (sub_files, _) = files_for(&git, repo.join("sub").to_str().unwrap())
            .await
            .expect("仓库子目录应能列出");
        assert!(sub_files.contains(&"b.txt".to_string()), "子目录输出相对自身：{sub_files:?}");

        // 非仓库目录（父目录不是仓库）/ 不存在的目录：返回 Err（命令层落 error 字段）
        let plain = root.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(files_for(&git, plain.to_str().unwrap()).await.is_err());
        assert!(files_for(&git, root.join("nope").to_str().unwrap()).await.is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 命令层：多项目并发，结果顺序 = 入参顺序；坏路径降级为 error 项、不拖垮其它项。
    #[tokio::test]
    async fn command_keeps_order_and_degrades_per_project() {
        let Some(git) = git_bin().await else { return };
        let root = std::env::temp_dir().join(format!("omp-inn-files-cmd-{}", std::process::id()));
        let repo_a = root.join("repo-a");
        let repo_b = root.join("repo-b");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&repo_a).unwrap();
        std::fs::create_dir_all(&repo_b).unwrap();
        std::fs::write(repo_a.join("a.txt"), "a").unwrap();
        std::fs::write(repo_b.join("b.txt"), "b").unwrap();
        git_run(&git, &repo_a, &["init", "-q"]);
        git_run(&git, &repo_b, &["init", "-q"]);
        git_run(&git, &repo_a, &["add", "-A"]);
        git_run(&git, &repo_b, &["add", "-A"]);

        let missing = root.join("missing");
        let out = list_project_files(vec![
            repo_b.to_string_lossy().to_string(),
            missing.to_string_lossy().to_string(),
            repo_a.to_string_lossy().to_string(),
        ])
        .await
        .expect("命令层不整体失败");
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].path, repo_b.to_string_lossy());
        assert_eq!(out[0].files, vec!["b.txt".to_string()]);
        assert!(out[0].error.is_none());
        assert!(out[1].error.is_some(), "目录不存在 → error 项");
        assert!(out[1].files.is_empty());
        assert_eq!(out[2].path, repo_a.to_string_lossy());
        assert_eq!(out[2].files, vec!["a.txt".to_string()]);

        let _ = std::fs::remove_dir_all(&root);
    }
}
