//! 右栏「Git 图谱」数据面（只读）：提交列表 / 提交详情 / 提交内单文件 diff。
//!
//! 对齐 VS Code Git Graph 的核心视图：按 `--topo-order` 取提交（跨分支），带上
//! `%D` 引用（HEAD / 分支 / 远程 / 标签）与父提交，前端自己算 lane 布局画连线。
//!
//! 分工：
//! - **读**全在这里（git CLI + 纯解析函数，解析全带单测）；
//! - **写**一律不碰：切分支 / 提交 / 推送仍走 `git_ops.rs` / `git_commit.rs`，
//!   图谱不做 checkout / reset / cherry-pick（见根 `AGENTS.md` 铁律）。
//!
//! 路径口径：日志与 diff 都在**仓库根**下跑（`work_root`）——会话目录可能是仓库子目录，
//! 而 `git show` 的 pathspec 相对自己的 cwd，不统一到根就会把子目录路径当成另一个文件。

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;

use crate::commands::{cmd_err, CmdError};
use crate::git_info::{dir_exists, git_bin, run_git, run_git_timeout};
use crate::git_ops::work_root;

/// 提交历史单次读取的上限保护（前端分页再取）。
const MAX_LIMIT: u32 = 500;
/// 默认一页：右栏一屏能滚很久，再多只是白占内存。
const DEFAULT_LIMIT: u32 = 200;
/// `git log` 在大仓库（几十万提交）也可能慢：比只读状态刷新宽，但要有上限。
const LOG_TIMEOUT: Duration = Duration::from_secs(20);
/// 提交详情 / 单文件 diff：大提交可能扫很多 blob。
const DETAIL_TIMEOUT: Duration = Duration::from_secs(30);
/// 单个 diff 的输出上限（与 `git_file_diff` 同一口径）。
const DIFF_MAX: usize = 400_000;
/// 详情里最多列出的文件数（超大合并提交不把整表塞给前端）。
const MAX_DETAIL_FILES: usize = 2000;
/// 提交正文上限（超长正文只影响详情面板，不让它撑爆 IPC）。
const MAX_BODY: usize = 50_000;

/// `git log --pretty` 的字段分隔符（0x1F 不会出现在 ref 名里；提交标题里的概率可忽略）。
const FIELD: char = '\x1f';

/// 一条提交引用（`%D` 解析结果）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitGraphRef {
    /// 短名：`main` / `origin/main` / `v0.1.0` / detached 时的 `HEAD`。
    pub name: String,
    /// `head` / `branch` / `remote` / `tag`。
    pub kind: String,
}

/// 图谱里的一行提交。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitGraphCommit {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    /// Unix 秒（作者时间；与 `git log` 的 `%at` 一致）。
    pub at: i64,
    pub subject: String,
    pub refs: Vec<GitGraphRef>,
}

/// 分支筛选下拉的一项（本地分支 + 远程分支；符号引用 `origin/HEAD` 不收）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitGraphBranch {
    /// 展示名：`main` / `origin/main`。
    pub name: String,
    /// 传给后端的完整引用：`refs/heads/main` / `refs/remotes/origin/main`。
    pub r#ref: String,
    /// `branch` / `remote`。
    pub kind: String,
}

/// 一页提交历史。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitGraphPage {
    pub is_repo: bool,
    /// 仓库根（工作区未提交改动的相对路径以它为基准）。
    pub root: Option<String>,
    /// 当前分支；detached / 无提交时为 None（detached 的 HEAD 由提交上的 `HEAD` 引用标出）。
    pub branch: Option<String>,
    pub branches: Vec<GitGraphBranch>,
    pub commits: Vec<GitGraphCommit>,
    pub has_more: bool,
}

impl GitGraphPage {
    fn not_repo() -> Self {
        Self {
            is_repo: false,
            root: None,
            branch: None,
            branches: vec![],
            commits: vec![],
            has_more: false,
        }
    }
}

/// 提交详情里的一个文件（`--name-status` + `--numstat` 合并）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub path: String,
    /// 重命名 / 复制时的原名。
    pub orig_path: Option<String>,
    /// `M` / `A` / `D` / `R` / `C` / `T` 等（取 name-status 的首字母）。
    pub status: String,
    pub add: u32,
    pub del: u32,
    /// numstat 给 `-` 的文件（二进制）。
    pub binary: bool,
}

/// 一次提交的完整详情。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetail {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_email: String,
    /// 作者时间（Unix 秒）。
    pub at: i64,
    pub subject: String,
    /// 正文（不含标题；超长截断）。
    pub body: String,
    pub body_truncated: bool,
    pub files: Vec<GitCommitFile>,
    pub files_truncated: bool,
}

/// 提交内单文件 diff 的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDiff {
    /// `diff` / `none`。
    pub kind: String,
    pub text: String,
    pub truncated: bool,
}

// ---------- 纯函数（全部带单测） ----------

/// 解析 `git log` 的一行：`%H %P %an %ae %at %s %D`（0x1F 分隔）。
pub fn parse_commits(out: &str) -> Vec<GitGraphCommit> {
    out.lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let mut fields = line.splitn(7, FIELD);
            let hash = fields.next()?.trim().to_string();
            if hash.is_empty() {
                return None;
            }
            let parents = fields.next()?.split_whitespace().map(str::to_string).collect();
            let author = fields.next()?.to_string();
            let email = fields.next()?.to_string();
            let at = fields.next()?.trim().parse::<i64>().unwrap_or(0);
            let subject = fields.next()?.to_string();
            let refs = parse_decorations(fields.next().unwrap_or(""));
            Some(GitGraphCommit { hash, parents, author, email, at, subject, refs })
        })
        .collect()
}

/// 解析 `%D`（`--decorate=full`）：`HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/o/x`。
///
/// `origin/HEAD` 这类符号引用只制造噪音，直接丢掉；未知命名空间（stash / notes）也不进图谱。
pub fn parse_decorations(raw: &str) -> Vec<GitGraphRef> {
    let mut out: Vec<GitGraphRef> = Vec::new();
    for token in raw.split(", ") {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        let found = if let Some(rest) = token.strip_prefix("HEAD -> ") {
            rest.strip_prefix("refs/heads/")
                .or_else(|| rest.strip_prefix("refs/remotes/"))
                .map(|name| ("head".to_string(), name.to_string()))
        } else if token == "HEAD" {
            Some(("head".to_string(), "HEAD".to_string()))
        } else if let Some(rest) = token.strip_prefix("tag: ") {
            Some(("tag".to_string(), rest.strip_prefix("refs/tags/").unwrap_or(rest).to_string()))
        } else if let Some(name) = token.strip_prefix("refs/heads/") {
            Some(("branch".to_string(), name.to_string()))
        } else if let Some(name) = token.strip_prefix("refs/remotes/") {
            (!name.ends_with("/HEAD")).then(|| ("remote".to_string(), name.to_string()))
        } else {
            None
        };
        if let Some((kind, name)) = found {
            if !name.is_empty() && !out.iter().any(|r| r.kind == kind && r.name == name) {
                out.push(GitGraphRef { name, kind });
            }
        }
    }
    out
}

/// 解析 `git for-each-ref --format=%(refname)%09%(symref)`（完整引用名）。符号引用跳过。
pub fn parse_branches(out: &str) -> Vec<GitGraphBranch> {
    out.lines()
        .filter_map(|line| {
            let (full, symref) = line.split_once('\t').unwrap_or((line, ""));
            let full = full.trim();
            if full.is_empty() || !symref.trim().is_empty() {
                return None;
            }
            let (kind, name) = if let Some(name) = full.strip_prefix("refs/heads/") {
                ("branch", name)
            } else if let Some(name) = full.strip_prefix("refs/remotes/") {
                ("remote", name)
            } else {
                return None;
            };
            if name.is_empty() || (kind == "remote" && name.ends_with("/HEAD")) {
                return None;
            }
            Some(GitGraphBranch { name: name.to_string(), r#ref: full.to_string(), kind: kind.to_string() })
        })
        .collect()
}

/// 解析 `git show --name-status -z`：`(当前路径, 状态首字母, 原名)`。
///
/// `-z` 下普通条目是 `M\0path\0`，重命名是 `R100\0old\0new\0`。
pub fn parse_name_status_z(out: &str) -> Vec<(String, String, Option<String>)> {
    let tokens: Vec<&str> = out.split('\0').collect();
    let mut rows = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let status = tokens[i].trim();
        i += 1;
        if status.is_empty() {
            continue;
        }
        let code = status.chars().next().unwrap_or('M').to_string();
        if code == "R" || code == "C" {
            if i + 1 >= tokens.len() {
                break;
            }
            let from = tokens[i].to_string();
            let to = tokens[i + 1].to_string();
            i += 2;
            if !to.is_empty() {
                rows.push((to, code, Some(from)));
            }
        } else {
            if i >= tokens.len() {
                break;
            }
            let path = tokens[i].to_string();
            i += 1;
            if !path.is_empty() {
                rows.push((path, code, None));
            }
        }
    }
    rows
}

/// 解析 `git show --numstat -z`：路径 → (增, 删, 是否二进制)。
///
/// 与 `git_ops::parse_numstat_z` 口径一致（改名两段都登记），但保留 `-` 的二进制标记。
pub fn parse_numstat_z(out: &str) -> HashMap<String, (u32, u32, bool)> {
    let tokens: Vec<&str> = out.split('\0').collect();
    let mut map: HashMap<String, (u32, u32, bool)> = HashMap::new();
    let mut i = 0;
    while i < tokens.len() {
        let token = tokens[i];
        i += 1;
        if token.is_empty() {
            continue;
        }
        let mut parts = token.splitn(3, '\t');
        let (Some(add), Some(del), path) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let binary = add.trim() == "-" || del.trim() == "-";
        let nums = (add.trim().parse().unwrap_or(0), del.trim().parse().unwrap_or(0), binary);
        match path {
            Some(p) if !p.is_empty() => {
                map.insert(p.to_string(), nums);
            }
            _ => {
                // 改名：空路径后跟两段名字（顺序不假设，两段都登记）
                if i + 1 < tokens.len() {
                    let from = tokens[i];
                    let to = tokens[i + 1];
                    i += 2;
                    if !from.is_empty() {
                        map.insert(from.to_string(), nums);
                    }
                    if !to.is_empty() {
                        map.insert(to.to_string(), nums);
                    }
                }
            }
        }
    }
    map
}

/// 合并 name-status 与 numstat：文件顺序以 name-status 为准（git 的输出顺序）。
pub fn merge_files(
    statuses: Vec<(String, String, Option<String>)>,
    nums: &HashMap<String, (u32, u32, bool)>,
) -> Vec<GitCommitFile> {
    statuses
        .into_iter()
        .map(|(path, status, orig_path)| {
            let (add, del, binary) = nums.get(&path).copied().unwrap_or((0, 0, false));
            GitCommitFile { path, orig_path, status, add, del, binary }
        })
        .collect()
}

/// `git show -s --format=…` 的解析结果。
#[derive(Debug, Clone, PartialEq)]
pub struct ShowMeta {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_email: String,
    pub at: i64,
    pub subject: String,
    pub body: String,
}

/// 解析提交元信息（7 段，0x1F 分隔；末尾换行由 git 追加）。
pub fn parse_show_meta(out: &str) -> Option<ShowMeta> {
    let text = out.trim_end_matches('\n');
    let mut fields = text.splitn(7, FIELD);
    let hash = fields.next()?.trim().to_string();
    if hash.is_empty() {
        return None;
    }
    let parents = fields.next()?.split_whitespace().map(str::to_string).collect();
    let author = fields.next()?.to_string();
    let author_email = fields.next()?.to_string();
    let at = fields.next()?.trim().parse::<i64>().unwrap_or(0);
    let subject = fields.next()?.to_string();
    let body = fields.next().unwrap_or("").to_string();
    Some(ShowMeta { hash, parents, author, author_email, at, subject, body })
}

/// 提交哈希的形状校验：4–64 位十六进制。短 sha 与完整 sha 都收。
pub fn valid_hash(hash: &str) -> bool {
    (4..=64).contains(&hash.len()) && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 按字节上限截断，回退到字符边界（不能把 UTF-8 切一半）。
pub fn truncate_text(text: &str, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text.to_string(), false);
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

// ---------- git 调用 ----------

/// 是否在 work tree 里（bare 仓库不画图：没有工作区，未提交改动也不成立）。
async fn is_work_tree(git: &str, dir: &str) -> bool {
    matches!(
        run_git(git, dir, &["rev-parse", "--is-inside-work-tree"]).await,
        Ok(out) if out.trim() == "true"
    )
}

/// 分支筛选的数据源（本地 + 远程；按 for-each-ref 的字典序）。
async fn read_branches(git: &str, root: &str) -> Vec<GitGraphBranch> {
    match run_git(git, root, &["for-each-ref", "--format=%(refname)%09%(symref)", "refs/heads", "refs/remotes"])
        .await
    {
        Ok(out) => parse_branches(&out),
        Err(_) => vec![],
    }
}

/// 当前分支（detached / unborn 时为 None）。
async fn current_branch(git: &str, root: &str) -> Option<String> {
    run_git(git, root, &["symbolic-ref", "-q", "--short", "HEAD"])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 提交列表（右栏「Git 图谱」页签的入口）。
///
/// - `rev` 缺省 = 全部本地分支 / 标签 / 远程分支 + HEAD（不含 stash / notes）；
/// - `skip` / `limit` 支持分页；返回 `limit + 1` 条判断是否还有下一页；
/// - 非仓库返回 `isRepo:false`（不抛错，界面显示空态）。
#[tauri::command]
pub async fn git_graph(
    cwd: String,
    rev: Option<String>,
    limit: Option<u32>,
    skip: Option<u32>,
) -> Result<GitGraphPage, CmdError> {
    if !dir_exists(&cwd) {
        return Ok(GitGraphPage::not_repo());
    }
    let Some(git) = git_bin().await else {
        return Err(cmd_err("GIT_MISSING", "未找到 git".into(), None));
    };
    if !is_work_tree(&git, &cwd).await {
        return Ok(GitGraphPage::not_repo());
    }
    let root = work_root(&git, &cwd).await;
    let branches = read_branches(&git, &root).await;
    let branch = current_branch(&git, &root).await;
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let skip = skip.unwrap_or(0).min(1_000_000);

    // 空仓库：HEAD 还没指向提交，`git log HEAD` 会直接失败（不是错误，是空历史）。
    let has_head = run_git(&git, &root, &["rev-parse", "--verify", "--quiet", "HEAD"]).await.is_ok();
    if !has_head && rev.is_none() {
        return Ok(GitGraphPage {
            is_repo: true,
            root: Some(root),
            branch,
            branches,
            commits: vec![],
            has_more: false,
        });
    }

    let mut args: Vec<String> = vec![
        "log".into(),
        "--topo-order".into(),
        "--decorate=full".into(),
        "--encoding=UTF-8".into(),
        format!("--pretty=format:%H{FIELD}%P{FIELD}%an{FIELD}%ae{FIELD}%at{FIELD}%s{FIELD}%D"),
        format!("--max-count={}", limit + 1),
        format!("--skip={skip}"),
    ];
    match rev.as_deref().filter(|r| !r.is_empty()) {
        Some(r) => {
            if !branches.iter().any(|b| b.r#ref == r) {
                return Err(cmd_err(
                    "UNKNOWN_REF",
                    "分支已不存在，请刷新".into(),
                    Some(r.to_string()),
                ));
            }
            args.push(r.to_string());
        }
        None => {
            args.push("--branches".into());
            args.push("--tags".into());
            args.push("--remotes".into());
            if has_head {
                args.push("HEAD".into());
            }
        }
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_git_timeout(&git, &root, &refs, LOG_TIMEOUT)
        .await
        .map_err(|e| cmd_err("LOG_FAILED", "读取提交历史失败".into(), Some(e)))?;
    let mut commits = parse_commits(&out);
    let has_more = commits.len() > limit as usize;
    if has_more {
        commits.truncate(limit as usize);
    }
    Ok(GitGraphPage { is_repo: true, root: Some(root), branch, branches, commits, has_more })
}

/// 一次提交的详情（点提交行时取）：元信息 + 文件清单。
///
/// 合并提交按**第一个父提交**给改动——与 VS Code Git Graph 的口径一致，也避免把两侧
/// 合并差异全摊开（`git show` 对 merge 默认什么都不输出）。
#[tauri::command]
pub async fn git_commit_detail(cwd: String, hash: String) -> Result<GitCommitDetail, CmdError> {
    if !valid_hash(&hash) {
        return Err(cmd_err("BAD_ARG", "提交哈希格式不正确".into(), None));
    }
    let Some(git) = git_bin().await else {
        return Err(cmd_err("GIT_MISSING", "未找到 git".into(), None));
    };
    let root = work_root(&git, &cwd).await;
    let meta_out = run_git_timeout(
        &git,
        &root,
        &[
            "show",
            "-s",
            "--encoding=UTF-8",
            &format!("--format=%H{FIELD}%P{FIELD}%an{FIELD}%ae{FIELD}%at{FIELD}%s{FIELD}%b"),
            &hash,
        ],
        DETAIL_TIMEOUT,
    )
    .await
    .map_err(|e| cmd_err("COMMIT_NOT_FOUND", "读取提交失败".into(), Some(e)))?;
    let meta = parse_show_meta(&meta_out)
        .ok_or_else(|| cmd_err("COMMIT_PARSE", "无法解析提交信息".into(), None))?;
    let first_parent = meta.parents.len() > 1;

    let mut base: Vec<&str> = vec!["show", "--format=", "-z"];
    if first_parent {
        base.push("--first-parent");
    }
    let mut status_args = base.clone();
    status_args.extend(["--name-status", hash.as_str()]);
    let mut num_args = base;
    num_args.extend(["--numstat", hash.as_str()]);
    let status_out = run_git_timeout(&git, &root, &status_args, DETAIL_TIMEOUT)
        .await
        .map_err(|e| cmd_err("COMMIT_FILES", "读取提交文件清单失败".into(), Some(e)))?;
    let num_out = run_git_timeout(&git, &root, &num_args, DETAIL_TIMEOUT)
        .await
        .map_err(|e| cmd_err("COMMIT_FILES", "读取提交文件清单失败".into(), Some(e)))?;
    let mut statuses = parse_name_status_z(&status_out);
    let files_truncated = statuses.len() > MAX_DETAIL_FILES;
    if files_truncated {
        statuses.truncate(MAX_DETAIL_FILES);
    }
    let nums = parse_numstat_z(&num_out);
    let files = merge_files(statuses, &nums);
    let (body, body_truncated) = truncate_text(&meta.body, MAX_BODY);
    Ok(GitCommitDetail {
        hash: meta.hash,
        parents: meta.parents,
        author: meta.author,
        author_email: meta.author_email,
        at: meta.at,
        subject: meta.subject,
        body,
        body_truncated,
        files,
        files_truncated,
    })
}

/// 提交内单文件的统一 diff（点详情里的文件行时取）。
///
/// `path` 是**仓库根相对路径**（详情文件清单原样）；`--literal-pathspecs` 保证
/// 包含 `*` / `?` 的文件名不被当成通配符。
#[tauri::command]
pub async fn git_commit_diff(cwd: String, hash: String, path: String) -> Result<GitCommitDiff, CmdError> {
    if !valid_hash(&hash) {
        return Err(cmd_err("BAD_ARG", "提交哈希格式不正确".into(), None));
    }
    if path.trim().is_empty() || path.contains('\0') {
        return Err(cmd_err("BAD_ARG", "文件路径为空".into(), None));
    }
    let Some(git) = git_bin().await else {
        return Err(cmd_err("GIT_MISSING", "未找到 git".into(), None));
    };
    let root = work_root(&git, &cwd).await;
    // 合并提交要显式 `--first-parent`，否则 `git show` 一个文件都不给
    let parents_out = run_git_timeout(&git, &root, &["show", "-s", "--format=%P", &hash], DETAIL_TIMEOUT)
        .await
        .map_err(|e| cmd_err("COMMIT_NOT_FOUND", "读取提交失败".into(), Some(e)))?;
    let first_parent = parents_out.split_whitespace().count() > 1;
    let mut args: Vec<&str> = vec!["--literal-pathspecs", "show", "--format=", "--no-color", "--no-ext-diff"];
    if first_parent {
        args.push("--first-parent");
    }
    args.push(&hash);
    args.push("--");
    args.push(&path);
    let out = run_git_timeout(&git, &root, &args, DETAIL_TIMEOUT)
        .await
        .map_err(|e| cmd_err("DIFF_FAILED", "读取文件改动失败".into(), Some(e)))?;
    if out.trim().is_empty() {
        return Ok(GitCommitDiff { kind: "none".into(), text: String::new(), truncated: false });
    }
    let (text, truncated) = truncate_text(&out, DIFF_MAX);
    Ok(GitCommitDiff { kind: "diff".into(), text, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log_line(hash: &str, parents: &str, subject: &str, decorations: &str) -> String {
        format!("{hash}\x1f{parents}\x1f张三\x1fa@b.c\x1f1700000000\x1f{subject}\x1f{decorations}")
    }

    #[test]
    fn parses_log_rows_with_parents_and_decorations() {
        let out = format!(
            "{}\n{}\n",
            log_line("aaa", "bbb ccc", "merge feat", "HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1"),
            log_line("bbb", "", "root", ""),
        );
        let commits = parse_commits(&out);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].parents, vec!["bbb", "ccc"]);
        assert_eq!(commits[0].subject, "merge feat");
        assert_eq!(commits[0].refs.len(), 3);
        assert_eq!(commits[0].refs[0], GitGraphRef { name: "main".into(), kind: "head".into() });
        assert_eq!(commits[0].refs[1], GitGraphRef { name: "origin/main".into(), kind: "remote".into() });
        assert_eq!(commits[0].refs[2], GitGraphRef { name: "v1".into(), kind: "tag".into() });
        assert!(commits[1].parents.is_empty());
        assert!(commits[1].refs.is_empty());
    }

    #[test]
    fn parses_detached_head_branch_and_unknown_refs() {
        assert_eq!(
            parse_decorations("HEAD, refs/heads/feat, refs/stash"),
            vec![
                GitGraphRef { name: "HEAD".into(), kind: "head".into() },
                GitGraphRef { name: "feat".into(), kind: "branch".into() },
            ]
        );
    }

    #[test]
    fn parses_branches_and_skips_symbolic_remote_head() {
        let out = "refs/heads/main\t\nrefs/heads/feat/x\t\nrefs/remotes/origin/HEAD\trefs/remotes/origin/main\nrefs/remotes/origin/main\t\n";
        assert_eq!(
            parse_branches(out),
            vec![
                GitGraphBranch { name: "main".into(), r#ref: "refs/heads/main".into(), kind: "branch".into() },
                GitGraphBranch { name: "feat/x".into(), r#ref: "refs/heads/feat/x".into(), kind: "branch".into() },
                GitGraphBranch { name: "origin/main".into(), r#ref: "refs/remotes/origin/main".into(), kind: "remote".into() },
            ]
        );
    }

    #[test]
    fn parses_name_status_with_rename() {
        let out = "M\0src/a.ts\0A\0new.ts\0R100\0old.ts\0renamed.ts\0";
        assert_eq!(
            parse_name_status_z(out),
            vec![
                ("src/a.ts".into(), "M".into(), None),
                ("new.ts".into(), "A".into(), None),
                ("renamed.ts".into(), "R".into(), Some("old.ts".into())),
            ]
        );
    }

    #[test]
    fn parses_numstat_with_binary_and_rename() {
        let out = "1\t2\tsrc/a.ts\0-\t-\timg.png\03\t4\t\0old.ts\0renamed.ts\0";
        let map = parse_numstat_z(out);
        assert_eq!(map.get("src/a.ts"), Some(&(1, 2, false)));
        assert_eq!(map.get("img.png"), Some(&(0, 0, true)));
        assert_eq!(map.get("old.ts"), Some(&(3, 4, false)));
        assert_eq!(map.get("renamed.ts"), Some(&(3, 4, false)));
    }

    #[test]
    fn merges_status_with_numstat_by_current_path() {
        let statuses = vec![
            ("a.ts".into(), "M".into(), None),
            ("renamed.ts".into(), "R".into(), Some("old.ts".into())),
        ];
        let mut nums = HashMap::new();
        nums.insert("a.ts".to_string(), (2, 1, false));
        nums.insert("renamed.ts".to_string(), (3, 4, false));
        let files = merge_files(statuses, &nums);
        assert_eq!(files[0], GitCommitFile { path: "a.ts".into(), orig_path: None, status: "M".into(), add: 2, del: 1, binary: false });
        assert_eq!(files[1].orig_path.as_deref(), Some("old.ts"));
        assert_eq!((files[1].add, files[1].del), (3, 4));
    }

    #[test]
    fn parses_show_meta_with_body() {
        let out = "aaa\x1fbbb ccc\x1f张三\x1fa@b.c\x1f1700000000\x1ffeat: x\x1fbody line 1\nbody line 2\n";
        let meta = parse_show_meta(out).unwrap();
        assert_eq!(meta.parents, vec!["bbb", "ccc"]);
        assert_eq!(meta.subject, "feat: x");
        assert_eq!(meta.body, "body line 1\nbody line 2");
    }

    #[test]
    fn validates_hash_shape() {
        assert!(valid_hash("835ced8"));
        assert!(valid_hash("835CED8"));
        assert!(valid_hash(&"a".repeat(64)));
        assert!(!valid_hash("abc"));
        assert!(!valid_hash("xyz123"));
        assert!(!valid_hash(""));
        assert!(!valid_hash(&"a".repeat(65)));
    }

    #[test]
    fn truncates_on_char_boundary() {
        let (text, cut) = truncate_text("中文abc", 4);
        assert!(cut);
        assert_eq!(text, "中");
        let (text, cut) = truncate_text("abc", 10);
        assert!(!cut);
        assert_eq!(text, "abc");
    }

    // ---------- 真实仓库（快；只用 git，不消耗 AI） ----------

    /// 建一个带分支 + 合并提交的临时仓库，返回 `(root, work)`。
    async fn temp_repo(tag: &str) -> (std::path::PathBuf, String) {
        let Some(git) = git_bin().await else { panic!("未找到 git") };
        let root = std::env::temp_dir().join(format!("omp-inn-git-graph-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let g = |args: &[&str]| {
            let out = std::process::Command::new(&git).arg("-C").arg(&work).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?} 失败：{}", String::from_utf8_lossy(&out.stderr));
        };
        g(&["init", "-q", "--initial-branch=main"]);
        g(&["config", "user.email", "e2e@test.local"]);
        g(&["config", "user.name", "omp e2e"]);
        std::fs::write(work.join("a.txt"), "a\n").unwrap();
        g(&["add", "."]);
        g(&["commit", "-qm", "root"]);
        g(&["checkout", "-qb", "feat"]);
        std::fs::write(work.join("a.txt"), "a\nb\n").unwrap();
        std::fs::write(work.join("c.txt"), "c\n").unwrap();
        g(&["add", "."]);
        g(&["commit", "-qm", "feat: add b and c"]);
        g(&["checkout", "-q", "main"]);
        std::fs::write(work.join("d.txt"), "d\n").unwrap();
        g(&["add", "."]);
        g(&["commit", "-qm", "main: add d"]);
        g(&["merge", "-q", "--no-ff", "feat", "-m", "merge feat"]);
        (root, work.to_string_lossy().to_string())
    }

    #[tokio::test]
    async fn real_repo_graph_reads_history_details_and_diffs() {
        let (root, work) = temp_repo("read").await;
        let page = git_graph(work.clone(), None, Some(50), Some(0)).await.unwrap();
        assert!(page.is_repo);
        assert_eq!(page.root.as_deref().map(|r| r.ends_with("/work")), Some(true));
        assert_eq!(page.branch.as_deref(), Some("main"));
        assert!(page.branches.iter().any(|b| b.name == "feat" && b.kind == "branch"));
        assert_eq!(page.commits.len(), 4);
        // 第一条是合并提交，HEAD / main 的引用落在它上面
        let merge = &page.commits[0];
        assert_eq!(merge.parents.len(), 2);
        assert!(merge.refs.iter().any(|r| r.kind == "head" && r.name == "main"));
        assert!(!page.has_more);

        // 合并提交按第一个父提交给文件（a.txt / c.txt 来自 feat 侧）
        let detail = git_commit_detail(work.clone(), merge.hash.clone()).await.unwrap();
        let paths: Vec<&str> = detail.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"a.txt") && paths.contains(&"c.txt"), "{paths:?}");
        let diff = git_commit_diff(work.clone(), merge.hash.clone(), "a.txt".into()).await.unwrap();
        assert_eq!(diff.kind, "diff");
        assert!(diff.text.contains("+b"), "{}", diff.text);

        // 根提交（没有父）也要能列出全量文件、能取单文件 diff
        let root_commit = page.commits.last().unwrap();
        assert!(root_commit.parents.is_empty());
        let root_detail = git_commit_detail(work.clone(), root_commit.hash.clone()).await.unwrap();
        assert_eq!(root_detail.files.len(), 1);
        assert_eq!(root_detail.files[0].path, "a.txt");
        let root_diff = git_commit_diff(work.clone(), root_commit.hash.clone(), "a.txt".into()).await.unwrap();
        assert!(root_diff.text.contains("+a"), "{}", root_diff.text);

        // 未知引用 / 非法哈希都必须被挡住（不把参数直接塞给 git）
        assert!(git_graph(work.clone(), Some("refs/heads/nope".into()), None, None).await.is_err());
        assert!(git_commit_detail(work.clone(), "--upload-pack=evil".into()).await.is_err());

        // 非仓库目录 → isRepo:false，不抛错
        let plain = root.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let empty = git_graph(plain.to_string_lossy().into_owned(), None, None, None).await.unwrap();
        assert!(!empty.is_repo);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn real_repo_paginates_without_overlap() {
        let (root, work) = temp_repo("page").await;
        let first = git_graph(work.clone(), None, Some(2), Some(0)).await.unwrap();
        let second = git_graph(work.clone(), None, Some(2), Some(2)).await.unwrap();
        assert_eq!(first.commits.len(), 2);
        assert!(first.has_more);
        assert_eq!(second.commits.len(), 2);
        assert!(!second.has_more);
        assert_ne!(first.commits[0].hash, second.commits[0].hash);
        let _ = std::fs::remove_dir_all(&root);
    }
}
