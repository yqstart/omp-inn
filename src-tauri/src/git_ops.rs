//! 壳侧 git 写操作（V19）：变更集读取、勾选 → 暂存区同步。
//!
//! 分工（V19 起）：**git 的写操作由壳侧用 git CLI 直接做**——快、可预期、错误就是 git
//! 原文；`omp` 只负责「用哪个模型、怎么出提交信息」（见 `commit_msg.rs`）。这替代了
//! V14「壳只做编排、不碰 git index 语义」的口径，理由就是速度与可控性（V14 每次提交
//! 要跑完整条 `omp commit` agent 流水线，实测 16–35s）。
//!
//! 本模块只放「读状态 / 建参数 / 解析输出」的纯函数（全部带单测）与少量 git 调用；
//! 提交 / 推送的**任务编排**在 `git_commit.rs`。

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use serde::Serialize;

use crate::commands::{cmd_err, CmdError};
use crate::git_info::{dir_exists, git_bin, run_git, run_git_timeout};
use crate::project_files::parse_ls_files_z;

/// 变更集里一个文件的上限保护：超大仓库不把整表塞给前端（够用且不卡界面）。
const MAX_CHANGE_FILES: usize = 2000;
/// 大仓库里可能偏慢的 git 操作（status / add）：给 30s，超时才报失败。
/// 只读的行徽章那条链路仍用 `git_info::GIT_TIMEOUT`（4s）——那是背景刷新，慢就降级。
const SLOW: Duration = Duration::from_secs(30);
/// 拉取要 fetch + merge，慢网络 / 大仓库下比本地写操作慢得多：给 120s。
const PULL_TIMEOUT: Duration = Duration::from_secs(120);
// ---------- 类型（与前端 `shared/types.ts` 同构） ----------

/// 一个待提交的文件（`git status --porcelain=v1 -z` 一行 + numstat 的增删行数）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeFile {
    /// 相对仓库根（porcelain 原样）。
    pub path: String,
    /// 重命名 / 复制时的原名（porcelain `-z` 的第二段；`-z` 下 git 把顺序反了过来：
    /// `from -> to` 变成 `to from`，所以第一段才是当前路径）。
    pub orig_path: Option<String>,
    /// `XY` 的 X（暂存区态）：`M` / `A` / `D` / `R` / `?`（未跟踪时两位都是 `?`）。
    pub index: String,
    /// `XY` 的 Y（工作区态）。
    pub worktree: String,
    /// `??` 未跟踪文件。
    pub untracked: bool,
    /// 已跟踪改动的 +N（未跟踪恒 0；二进制文件也是 0）。
    pub add: u32,
    /// 已跟踪改动的 -M。
    pub del: u32,
}

/// 一个工作区的完整变更视图（面板打开时取一次）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    pub is_repo: bool,
    /// 当前分支；detached / 无提交时为 None。
    pub branch: Option<String>,
    /// detached 时的短 sha（用于展示「游离」）。
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub upstream_gone: bool,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<ChangeFile>,
}

impl ChangeSet {
    fn not_repo() -> Self {
        Self {
            is_repo: false,
            branch: None,
            head: None,
            upstream: None,
            upstream_gone: false,
            ahead: 0,
            behind: 0,
            files: vec![],
        }
    }
}

/// 一次拉取的结果（行徽章的「远程有新提交」点击）。
///
/// **冲突不是命令失败**：合并停在冲突态，等用户在编辑器里解决——所以走 `Ok` 返回，
/// 让前端拿到冲突文件清单；真正的命令失败（网络 / 权限 / 本地改动被覆盖）才走 `Err`。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullOutcome {
    /// `up-to-date`（远程没有新提交）/ `merged`（已更新：快进或产生合并提交）/ `conflicts`。
    pub status: String,
    /// 冲突文件的**绝对路径**（`status == "conflicts"` 时非空）。
    pub conflicts: Vec<String>,
    /// git 输出摘要（成功时是 pull 的 stdout；冲突时是 stderr 的冲突提示）。
    pub detail: String,
}

impl PullOutcome {
    fn done(status: &str, detail: String) -> Self {
        Self { status: status.into(), conflicts: vec![], detail }
    }

    fn conflicts(paths: Vec<String>, detail: String) -> Self {
        Self { status: "conflicts".into(), conflicts: paths, detail }
    }
}

// ---------- 纯函数（全部带单测） ----------

/// 解析 `git diff --numstat -z`（路径 → (增, 删)）。
///
/// 普通条目是一段 `add\tdel\tpath`；改名条目的路径字段为空、后跟两段名字。
/// **不对这两段的顺序做假设**：两段都登记进同一张表，查表时任一段命中即可。
pub fn parse_numstat_z(out: &str) -> HashMap<String, (u32, u32)> {
    let mut map: HashMap<String, (u32, u32)> = HashMap::new();
    let tokens: Vec<&str> = out.split('\0').collect();
    let mut i = 0;
    while i < tokens.len() {
        let token = tokens[i];
        if token.is_empty() {
            i += 1;
            continue;
        }
        let mut parts = token.splitn(3, '\t');
        let (Some(add), Some(del), path) = (parts.next(), parts.next(), parts.next()) else {
            i += 1;
            continue;
        };
        // `-` 是二进制文件；解析不出来按 0（只影响展示的数字）
        let nums = (add.trim().parse().unwrap_or(0), del.trim().parse().unwrap_or(0));
        match path {
            Some(p) if !p.is_empty() => {
                map.insert(p.to_string(), nums);
            }
            // 改名 / 复制：接下来两段是（新名 / 原名，顺序不假设）
            _ => {
                for extra in tokens.iter().skip(i + 1).take(2) {
                    if !extra.is_empty() {
                        map.insert((*extra).to_string(), nums);
                    }
                }
                i += 2;
            }
        }
        i += 1;
    }
    map
}

/// 解析 `git status --porcelain=v1 -z`：NUL 分隔，条目形如 `XY path`；
/// `R` / `C` 条目再多一段原名。头段（`## …`）由调用方先摘掉，这里遇到也跳过。
pub fn parse_status_porcelain_z(out: &str, numstat: &str) -> Vec<ChangeFile> {
    let nums = parse_numstat_z(numstat);
    let tokens: Vec<&str> = out.split('\0').collect();
    let mut files: Vec<ChangeFile> = vec![];
    let mut i = 0;
    while i < tokens.len() && files.len() < MAX_CHANGE_FILES {
        let token = tokens[i];
        if token.is_empty() || token.starts_with("## ") {
            i += 1;
            continue;
        }
        let bytes = token.as_bytes();
        if bytes.len() < 3 {
            i += 1;
            continue;
        }
        let (x, y) = (bytes[0] as char, bytes[1] as char);
        // 前两字节是 ASCII 状态位 + 一个空格，索引 3 一定是字符边界
        let path = token[3..].to_string();
        let renamed = x == 'R' || x == 'C' || y == 'R' || y == 'C';
        let orig_path = if renamed {
            let next = tokens.get(i + 1).map(|s| s.to_string()).filter(|s| !s.is_empty());
            i += 1;
            next
        } else {
            None
        };
        let untracked = x == '?' && y == '?';
        let (add, del) = if untracked {
            (0, 0)
        } else {
            nums.get(&path)
                .or_else(|| orig_path.as_ref().and_then(|o| nums.get(o)))
                .copied()
                .unwrap_or((0, 0))
        };
        files.push(ChangeFile {
            path,
            orig_path,
            index: x.to_string(),
            worktree: y.to_string(),
            untracked,
            add,
            del,
        });
        i += 1;
    }
    files
}

/// 摘出 `git status --porcelain=v1 -b -z` 的头段（`## …`）；没有则返回空串。
pub fn split_status_header_z(out: &str) -> (&str, &str) {
    match out.split_once('\0') {
        Some((first, rest)) if first.starts_with("## ") => (first, rest),
        _ => ("", out),
    }
}

/// 勾选 → 暂存区的动作计划：返回 `(要 add 的, 要 unstage 的)`。
///
/// `to_add` = 选中集里的全部（幂等，直接全量 `add -A`）；`to_unstage` = 已暂存但**未**选中的。
pub fn stage_plan(selected: &[String], staged: &[String]) -> (Vec<String>, Vec<String>) {
    let to_add = selected.to_vec();
    let to_unstage: Vec<String> = staged
        .iter()
        .filter(|p| !selected.iter().any(|s| s == *p))
        .cloned()
        .collect();
    (to_add, to_unstage)
}

/// 取消暂存的参数：有 HEAD 走 `restore --staged`；空仓库（首个提交前）没有 HEAD，
/// `restore --staged` 会失败，改用 `rm --cached --force`（把新增文件退回未跟踪）。
pub fn unstage_args(has_head: bool, paths: &[String]) -> Vec<String> {
    let mut args: Vec<String> = if has_head {
        vec!["restore".into(), "--staged".into(), "--".into()]
    } else {
        vec!["rm".into(), "--cached".into(), "--force".into(), "--".into()]
    };
    args.extend(paths.iter().cloned());
    args
}

/// 暂存的参数：`add -A` 覆盖新增 / 修改 / 删除（与 V14 `omp commit` 的 stage 语义一致）。
pub fn add_args(paths: &[String]) -> Vec<String> {
    let mut args: Vec<String> = vec!["add".into(), "-A".into(), "--".into()];
    args.extend(paths.iter().cloned());
    args
}

/// 一条勾选是否覆盖某个具体文件路径：精确相等，或勾选是未跟踪目录（`dir/`，porcelain
/// 对未跟踪目录的输出形态）且路径在它下面。目录勾选连带的文件是用户的显式意图。
pub fn selection_covers(selected: &str, path: &str) -> bool {
    selected == path || (selected.ends_with('/') && path.starts_with(selected))
}

/// 从 [`ls_files_visible`] 的结果里保留 git 仍可暂存的路径（其余剔除）。
///
/// 三类「已无内容可暂」的勾选路径会让**整条** `git add -A -- <paths>` 报错并全批失败：
/// 已暂存的删除条目（porcelain `D `，索引与工作区都已不存在——面板默认勾选就含它）、
/// 面板打开后又被删除 / 改名的未跟踪文件（`fatal: pathspec ... did not match any files`）、
/// 面板打开后新被 `.gitignore` 规则覆盖的未跟踪文件（ignored 错误）。跳过都没有副作用：
/// 删除状态本来就在暂存区里，另两类已无内容可暂（与不带 pathspec 的 `git add -A` 一致）。
pub fn retain_addable(selected: &[String], listed: &[String]) -> Vec<String> {
    let set: HashSet<&str> = listed.iter().map(String::as_str).collect();
    selected
        .iter()
        .filter(|p| set.contains(p.as_str()) || (p.ends_with('/') && listed.iter().any(|f| selection_covers(p, f))))
        .cloned()
        .collect()
}

/// `modelRoles.commit`（如 `commandcode/deepseek/deepseek-v4.1-flash:low`）
/// → `(模型选择器, 思考档)`。按**最后一个** `:` 切；层不是已知档位时整串当选择器。
pub fn commit_model_args(role: Option<&str>) -> (Option<String>, Option<String>) {
    const LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    let Some(role) = role.map(str::trim).filter(|r| !r.is_empty()) else {
        return (None, None);
    };
    match role.rsplit_once(':') {
        Some((selector, level)) if !selector.is_empty() && LEVELS.contains(&level) => {
            (Some(selector.to_string()), Some(level.to_string()))
        }
        _ => (Some(role.to_string()), None),
    }
}

/// 推送的参数：有上游直接 `push`；没有上游时显式设上游（`-u <remote> <branch>`），
/// 与 Cursor / GitHub Desktop 的「首次推送自动建立跟踪」同口径。
pub fn push_args(branch: &str, has_upstream: bool, remotes: &[String]) -> Result<Vec<String>, String> {
    if has_upstream {
        return Ok(vec!["push".into()]);
    }
    if let Some(remote) = remotes.iter().find(|r| r.as_str() == "origin") {
        return Ok(vec!["push".into(), "-u".into(), remote.clone(), branch.to_string()]);
    }
    match remotes {
        [only] => Ok(vec!["push".into(), "-u".into(), only.clone(), branch.to_string()]),
        _ => Err("没有配置远程仓库".into()),
    }
}

/// 切换分支的目标名校验：空串、以 `-` 开头（会被 git 当选项解析，如 `--orphan`）都拒绝；
/// 名字是否真实存在、是否合法引用交给 git 判定（错误原文比我们复刻的规则准确）。
pub fn validate_branch_arg(branch: &str) -> Result<(), String> {
    if branch.trim().is_empty() {
        return Err("分支名为空".into());
    }
    if branch.starts_with('-') {
        return Err("分支名不能以 - 开头".into());
    }
    Ok(())
}

/// 解析 `git diff --name-only --diff-filter=U -z` 的未合并路径（相对仓库根）。
///
/// `-z` 是 NUL 分隔，中文 / 空格路径不用转义；空段（尾部 NUL）丢掉。
pub fn parse_unmerged_paths(out: &str) -> Vec<String> {
    out.split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// 把仓库根基准的路径拼成绝对路径（前端打开编辑器 / 显示都需要绝对路径）。
/// 已经是绝对路径的原样保留。
pub fn absolute_paths(root: &str, paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .map(|p| {
            if std::path::Path::new(p).is_absolute() {
                p.clone()
            } else {
                std::path::Path::new(root).join(p).to_string_lossy().into_owned()
            }
        })
        .collect()
}

/// git 输出摘要：给前端做悬停说明，限行 + 限长（完整输出只进日志 / 终端）。
pub fn summarize_git(out: &str) -> String {
    let text = out.trim();
    if text.is_empty() {
        return String::new();
    }
    let mut s = text.lines().take(20).collect::<Vec<_>>().join("\n");
    if s.chars().count() > 2000 {
        s = s.chars().take(2000).collect();
    }
    s
}

// ---------- git 调用 ----------

/// 仓库根（`rev-parse --show-toplevel`）：变更集与暂存区都是**根基准**（porcelain 与
/// `diff --cached` 都从根算路径），而 git 的 pathspec 相对自己的 cwd——项目目录是仓库
/// 子目录时两者对不上，写操作必须统一到根下跑。拿不到根（极端情形）退回 cwd。
pub(crate) async fn work_root(git: &str, cwd: &str) -> String {
    match run_git(git, cwd, &["rev-parse", "--show-toplevel"]).await {
        Ok(out) if !out.trim().is_empty() => out.trim().to_string(),
        _ => cwd.to_string(),
    }
}

/// 读当前已暂存的文件（`git diff --cached --name-only -z`）。
///
/// 输出是**根基准**路径——调用方要么传仓库根，要么保证 cwd 下基准一致。
pub(crate) async fn staged_paths(git: &str, cwd: &str) -> Result<Vec<String>, String> {
    let out = run_git_timeout(git, cwd, &["diff", "--cached", "--name-only", "-z"], SLOW).await?;
    Ok(out.split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect())
}

/// 列出勾选路径里「索引中」或「工作区未跟踪且未被忽略」的文件（文件级，不折叠目录）。
/// 非空即证明该 pathspec 仍能被 `git add` 接受；调用方在仓库根下跑（根基准）。
async fn ls_files_visible(git: &str, root: &str, paths: &[String]) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = vec!["ls-files".into(), "-c".into(), "-o".into(), "--exclude-standard".into(), "-z".into(), "--".into()];
    args.extend(paths.iter().cloned());
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_git_timeout(git, root, &refs, SLOW).await.map(|out| parse_ls_files_z(&out))
}

/// 把勾选同步到暂存区（**生成 / 提交都先做这一步**）：
/// 未选中的取消暂存、选中的全量 `add -A`，最后复查「暂存集合 ⊆ 勾选集合」。
///
/// 只做**子集**校验：选中但没有改动的文件不会出现在暂存区，等值校验会误报。
/// 勾选集是根基准（来自变更集），git 调用统一在仓库根下跑；已无内容可暂的路径
/// （已暂存的删除条目 / 被删的未跟踪文件 / 新被忽略的文件）先剔除，不让整批 add 失败。
pub(crate) async fn apply_selection(git: &str, cwd: &str, paths: &[String]) -> Result<(), CmdError> {
    let selected: Vec<String> = paths.iter().map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect();
    if selected.is_empty() {
        return Err(cmd_err("NO_SELECTION", "请至少勾选一个文件".into(), None));
    }
    let root = work_root(git, cwd).await;
    let staged = staged_paths(git, &root)
        .await
        .map_err(|e| cmd_err("STATUS_FAILED", e, None))?;
    let (to_add, to_unstage) = stage_plan(&selected, &staged);
    if !to_unstage.is_empty() {
        let has_head = run_git(git, &root, &["rev-parse", "--verify", "-q", "HEAD"]).await.is_ok();
        let args = unstage_args(has_head, &to_unstage);
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        run_git_timeout(git, &root, &refs, SLOW).await.map_err(|e| cmd_err("STAGE_FAILED", e, None))?;
    }
    if !to_add.is_empty() {
        // 探测失败不拦路（退回旧行为）：照旧 add，错误由 git 原文上报
        let addable = match ls_files_visible(git, &root, &to_add).await {
            Ok(listed) => retain_addable(&to_add, &listed),
            Err(_) => to_add.clone(),
        };
        if !addable.is_empty() {
            let args = add_args(&addable);
            let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            run_git(git, &root, &refs).await.map_err(|e| cmd_err("STAGE_FAILED", e, None))?;
        }
    }
    // 复查：暂存区不能出现勾选之外的文件（那是「提交了没勾的东西」，必须挡住）；
    // 覆盖判定含目录勾选（`dir/` 下的文件都算被覆盖）
    let after = staged_paths(git, &root)
        .await
        .map_err(|e| cmd_err("STATUS_FAILED", e, None))?;
    if let Some(extra) = after.iter().find(|p| !selected.iter().any(|s| selection_covers(s, p))) {
        return Err(cmd_err(
            "STAGE_MISMATCH",
            "暂存区与勾选不一致（文件在操作期间被改动），请重试".into(),
            Some(format!("意外暂存：{extra}")),
        ));
    }
    Ok(())
}

// ---------- 命令 ----------

/// 面板打开时取一次变更集（**只读**）：文件清单 + 分支 / 上游状态。
/// 非仓库 / 目录不存在都降级为 `isRepo:false`（不抛错，前端显示「不是 git 仓库」）。
#[tauri::command]
pub async fn get_change_set(cwd: String) -> Result<ChangeSet, CmdError> {
    let Some(git) = git_bin().await else {
        return Err(cmd_err("GIT_MISSING", "未找到 git".into(), None));
    };
    if !dir_exists(&cwd) {
        return Err(cmd_err("DIR_MISSING", "工作目录不存在".into(), None));
    }
    match run_git(&git, &cwd, &["rev-parse", "--is-inside-work-tree"]).await {
        Ok(out) if out.trim() == "true" => {}
        _ => return Ok(ChangeSet::not_repo()),
    }
    let status = run_git_timeout(&git, &cwd, &["status", "--porcelain=v1", "-b", "-z"], SLOW)
        .await
        .map_err(|e| cmd_err("STATUS_FAILED", e, None))?;
    let (header, body) = split_status_header_z(&status);
    let (upstream, ahead, behind, upstream_gone) = crate::git_commit::parse_status_header(header);
    // numstat 覆盖「已跟踪的改动」；空仓库（没有 HEAD）退到只看暂存区
    let numstat = match run_git_timeout(&git, &cwd, &["diff", "HEAD", "--numstat", "-z"], SLOW).await {
        Ok(out) => out,
        Err(_) => run_git_timeout(&git, &cwd, &["diff", "--cached", "--numstat", "-z"], SLOW).await.unwrap_or_default(),
    };
    let files = parse_status_porcelain_z(body, &numstat);
    let branch = run_git(&git, &cwd, &["symbolic-ref", "-q", "--short", "HEAD"])
        .await
        .ok()
        .and_then(|out| {
            let t = out.trim().to_string();
            (!t.is_empty()).then_some(t)
        });
    let head = if branch.is_none() {
        run_git(&git, &cwd, &["rev-parse", "--short", "HEAD"])
            .await
            .ok()
            .and_then(|out| {
                let t = out.trim().to_string();
                (!t.is_empty()).then_some(t)
            })
    } else {
        None
    };
    Ok(ChangeSet { is_repo: true, branch, head, upstream, upstream_gone, ahead, behind, files })
}

/// 切换分支（输入卡顶行的分支清单点选即切）：
/// - 用 `git switch <branch>` 而不是 `checkout`——只认分支，不会被同名路径抢语义；
/// - 脏工作区交给 git 自己裁决：改动不冲突就带着走，冲突则整条拒绝、原样回传错误
///   （前端就地显示，不做 stash / force 代劳）；
/// - 超时用 [`SLOW`]（切换要更新整个工作区，可能比只读查询慢得多）。
#[tauri::command]
pub async fn switch_branch(cwd: String, branch: String) -> Result<(), CmdError> {
    validate_branch_arg(&branch).map_err(|e| cmd_err("BAD_ARG", e, None))?;
    if !dir_exists(&cwd) {
        return Err(cmd_err("DIR_MISSING", "工作目录不存在".into(), None));
    }
    let Some(git) = git_bin().await else {
        return Err(cmd_err("GIT_MISSING", "未找到 git".into(), None));
    };
    run_git_timeout(&git, &cwd, &["switch", &branch], SLOW)
        .await
        .map_err(|e| cmd_err("GIT_SWITCH", e.trim().to_string(), None))?;
    Ok(())
}

/// 拉取 / 合并命令的前置：目录存在 + git 可用 + 确实是仓库。
async fn repo_git(cwd: &str) -> Result<String, CmdError> {
    if !dir_exists(cwd) {
        return Err(cmd_err("DIR_MISSING", "工作目录不存在".into(), None));
    }
    let Some(git) = git_bin().await else {
        return Err(cmd_err("GIT_MISSING", "未找到 git".into(), Some("请安装 git 或在终端里确认 PATH".into())));
    };
    match run_git(&git, cwd, &["rev-parse", "--is-inside-work-tree"]).await {
        Ok(out) if out.trim() == "true" => Ok(git),
        Ok(_) => Err(cmd_err("NOT_REPO", "这个目录不是 git 仓库".into(), None)),
        Err(e) => Err(cmd_err("PREFLIGHT", e, None)),
    }
}

/// 当前未合并（冲突）的路径，相对仓库根；查询失败按「没有冲突」处理（调用方有自己的失败路径）。
async fn unmerged_paths(git: &str, dir: &str) -> Vec<String> {
    run_git(git, dir, &["diff", "--name-only", "--diff-filter=U", "-z"])
        .await
        .map(|out| parse_unmerged_paths(&out))
        .unwrap_or_default()
}

async fn head_sha(git: &str, dir: &str) -> Option<String> {
    run_git(git, dir, &["rev-parse", "HEAD"])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 拉取远程更新（左栏「远程有 N 个新提交」徽章点击）。
///
/// - `--no-rebase`：分叉时走**合并**而不是变基；`--ff` 覆盖用户配置的 `pull.ff=only`
///   （能快进就快进，不能就合）——用户口径是「无冲突直接更新合并代码」；
/// - `--no-edit`：合并提交用 git 自动生成的信息，不拉起终端编辑器（这里 stdin 是 null）；
/// - 有冲突：**保留合并态**，把冲突文件（绝对路径）交回前端去编辑器解决；
/// - 其余失败（网络 / 权限 / 本地改动会被覆盖）：git 原文回传，前端显示成错误态。
#[tauri::command]
pub async fn pull_workspace(cwd: String) -> Result<PullOutcome, CmdError> {
    let git = repo_git(&cwd).await?;
    let before = head_sha(&git, &cwd).await;
    match run_git_timeout(&git, &cwd, &["pull", "--no-rebase", "--ff", "--no-edit"], PULL_TIMEOUT).await {
        Ok(out) => {
            // 有更新 = HEAD 变了（快进或合并提交）；HEAD 没动 = 远程没有新提交。
            // 不靠 stdout 文案判断：git 的输出会跟随界面语言本地化。
            let after = head_sha(&git, &cwd).await;
            let status = if before.is_some() && after == before { "up-to-date" } else { "merged" };
            Ok(PullOutcome::done(status, summarize_git(&out)))
        }
        Err(err) => {
            let unmerged = unmerged_paths(&git, &cwd).await;
            if unmerged.is_empty() {
                return Err(cmd_err(
                    "GIT_PULL",
                    err,
                    Some("请检查网络 / 远程权限，或本地是否有会被覆盖的改动".into()),
                ));
            }
            let root = work_root(&git, &cwd).await;
            Ok(PullOutcome::conflicts(absolute_paths(&root, &unmerged), summarize_git(&err)))
        }
    }
}

/// 冲突解决后继续合并：把仍未标记解决的冲突文件 `git add`（调用方点按钮 = 已解决），
/// 再用合并信息完成提交（`--no-edit` 不拉起编辑器）。不在合并态时直接拒绝。
#[tauri::command]
pub async fn continue_merge(cwd: String) -> Result<(), CmdError> {
    let git = repo_git(&cwd).await?;
    let root = work_root(&git, &cwd).await;
    if run_git(&git, &root, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).await.is_err() {
        return Err(cmd_err("NOT_MERGING", "当前没有待完成的合并".into(), None));
    }
    let unmerged = unmerged_paths(&git, &root).await;
    if !unmerged.is_empty() {
        let mut args: Vec<&str> = vec!["add", "--"];
        args.extend(unmerged.iter().map(String::as_str));
        run_git_timeout(&git, &root, &args, SLOW)
            .await
            .map_err(|e| cmd_err("MERGE_ADD", format!("标记冲突文件已解决失败：{e}"), None))?;
    }
    run_git_timeout(&git, &root, &["commit", "--no-edit", "--no-verify"], SLOW)
        .await
        .map_err(|e| cmd_err("MERGE_COMMIT", format!("完成合并失败：{e}"), None))?;
    Ok(())
}

/// 放弃这次合并（冲突解决不了时的退路）：`git merge --abort` 把工作区恢复回拉取前。
#[tauri::command]
pub async fn abort_merge(cwd: String) -> Result<(), CmdError> {
    let git = repo_git(&cwd).await?;
    run_git_timeout(&git, &cwd, &["merge", "--abort"], SLOW)
        .await
        .map_err(|e| cmd_err("MERGE_ABORT", format!("放弃合并失败：{e}"), None))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numstat_parses_plain_and_rename_entries() {
        let out = "3\t3\tAGENTS.md\099\t0\0src/new.rs\0src/old.rs\0-\t-\tbin.dat\0";
        let map = parse_numstat_z(out);
        assert_eq!(map.get("AGENTS.md"), Some(&(3, 3)));
        // 改名：两段都登记（顺序不做假设），任一段都能查到
        assert_eq!(map.get("src/new.rs"), Some(&(99, 0)));
        assert_eq!(map.get("src/old.rs"), Some(&(99, 0)));
        // 二进制（`-`）按 0 处理
        assert_eq!(map.get("bin.dat"), Some(&(0, 0)));
    }

    #[test]
    fn status_z_parses_entries_with_counts() {
        let status = " M AGENTS.md\0?? 新文件.md\0A  src/a.rs\0";
        let numstat = "3\t3\tAGENTS.md\01\t0\tsrc/a.rs\0";
        let files = parse_status_porcelain_z(status, numstat);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "AGENTS.md");
        assert_eq!((files[0].index.as_str(), files[0].worktree.as_str()), (" ", "M"));
        assert_eq!((files[0].add, files[0].del), (3, 3));
        // 中文未跟踪文件：路径原样，不计数
        assert_eq!(files[1].path, "新文件.md");
        assert!(files[1].untracked);
        assert_eq!((files[1].add, files[1].del), (0, 0));
        assert_eq!(files[2].index, "A");
    }

    #[test]
    fn status_z_rename_takes_next_token_as_orig() {
        // `-z` 下 git 把顺序反了过来：第一段是当前路径，第二段是原名
        let status = "R  src/new.rs\0src/old.rs\0";
        let files = parse_status_porcelain_z(status, "1\t0\tsrc/new.rs\0src/old.rs\0");
        assert_eq!(files.len(), 1, "改名只占一行，第二段是原名不是新条目");
        assert_eq!(files[0].path, "src/new.rs");
        assert_eq!(files[0].orig_path.as_deref(), Some("src/old.rs"));
        assert_eq!((files[0].add, files[0].del), (1, 0));
    }

    #[test]
    fn status_header_split_off_body() {
        let (head, body) = split_status_header_z("## main...origin/main [ahead 1]\0 M a.txt\0");
        assert_eq!(head, "## main...origin/main [ahead 1]");
        assert_eq!(parse_status_porcelain_z(body, "").len(), 1);
        // 没有头段（异常输入）时整段当正文
        let (head, body) = split_status_header_z(" M a.txt\0");
        assert_eq!(head, "");
        assert_eq!(body, " M a.txt\0");
    }

    #[test]
    fn stage_plan_keeps_selection_and_unstages_the_rest() {
        let selected = vec!["a.txt".to_string(), "b.txt".to_string()];
        let staged = vec!["b.txt".to_string(), "c.txt".to_string()];
        let (add, unstage) = stage_plan(&selected, &staged);
        assert_eq!(add, vec!["a.txt", "b.txt"]);
        assert_eq!(unstage, vec!["c.txt"]);
        // 空勾选只 unstage
        let (add, unstage) = stage_plan(&[], &["x".to_string()]);
        assert!(add.is_empty());
        assert_eq!(unstage, vec!["x"]);
    }

    #[test]
    fn unstage_args_switch_on_head() {
        let paths = vec!["a.txt".to_string()];
        assert_eq!(unstage_args(true, &paths), ["restore", "--staged", "--", "a.txt"]);
        // 空仓库没有 HEAD，`restore --staged` 会失败 → 改用 rm --cached
        assert_eq!(unstage_args(false, &paths), ["rm", "--cached", "--force", "--", "a.txt"]);
    }

    #[test]
    fn add_args_are_force_all_with_pathspec() {
        assert_eq!(add_args(&["a.txt".into(), "b/c.txt".into()]), ["add", "-A", "--", "a.txt", "b/c.txt"]);
    }

    #[test]
    fn retain_addable_drops_vanished_and_ignored_paths() {
        let selected = vec![
            "src/a.ts".to_string(),     // 工作区仍存在（listed 里有）
            "src/ghost.ts".to_string(), // 面板打开后消失 / 新被忽略（listed 里没有）
            "docs/".to_string(),        // 未跟踪目录：listed 里是文件级路径，按前缀保留
            "empty/".to_string(),       // 已空 / 已删的目录：listed 无前缀
            "src/ab.ts".to_string(),    // 前缀不得误伤同级文件（exact 匹配）
        ];
        let listed = vec!["src/a.ts".to_string(), "docs/readme.md".to_string()];
        assert_eq!(retain_addable(&selected, &listed), vec!["src/a.ts", "docs/"]);
        // 全被剔除（都已无内容可暂）时不 panic，返回空
        assert!(retain_addable(&["gone.txt".to_string()], &[]).is_empty());
        // 覆盖判定：精确、目录、以及不得误放行同前缀的兄弟路径
        assert!(selection_covers("docs/", "docs/readme.md"));
        assert!(selection_covers("src/a.ts", "src/a.ts"));
        assert!(!selection_covers("docs", "docs/readme.md"), "没有尾随斜杠不是目录勾选");
        assert!(!selection_covers("src/", "srcx/a.ts"), "前缀必须落在目录边界上");
    }

    #[test]
    fn commit_model_args_splits_level() {
        assert_eq!(
            commit_model_args(Some("commandcode/deepseek/deepseek-v4.1-flash:low")),
            (Some("commandcode/deepseek/deepseek-v4.1-flash".into()), Some("low".into()))
        );
        // 没有层级 / 层级不合法 → 整串当选择器（模型 id 里带冒号的情况也走这里）
        assert_eq!(commit_model_args(Some("openai/gpt-5.2")), (Some("openai/gpt-5.2".into()), None));
        assert_eq!(
            commit_model_args(Some("provider/model:weird")),
            (Some("provider/model:weird".into()), None)
        );
        assert_eq!(commit_model_args(None), (None, None));
        assert_eq!(commit_model_args(Some("  ")), (None, None));
    }

    #[test]
    fn push_args_prefers_origin_then_single_remote() {
        assert_eq!(push_args("main", true, &[]).unwrap(), ["push"]);
        assert_eq!(
            push_args("feature/x", false, &["upstream".into(), "origin".into()]).unwrap(),
            ["push", "-u", "origin", "feature/x"]
        );
        assert_eq!(
            push_args("main", false, &["backup".into()]).unwrap(),
            ["push", "-u", "backup", "main"]
        );
        // 多个 remote 且没有 origin：不猜，交给用户
        assert!(push_args("main", false, &["a".into(), "b".into()]).is_err());
        assert!(push_args("main", false, &[]).is_err());
    }

    #[test]
    fn validate_branch_arg_rejects_empty_and_option_like() {
        assert!(validate_branch_arg("main").is_ok());
        assert!(validate_branch_arg("feature/中文-分支").is_ok());
        // 空 / 纯空白
        assert!(validate_branch_arg("").is_err());
        assert!(validate_branch_arg("   ").is_err());
        // 以 - 开头会被 git 当选项（`--orphan` / `-f`），必须挡在命令层之外
        assert!(validate_branch_arg("--orphan").is_err());
        assert!(validate_branch_arg("-f").is_err());
    }

    #[test]
    fn unmerged_paths_parse_nul_list_and_absolutize() {
        let out = "src/a.ts\0文档/冲突 文件.md\0\0";
        let paths = parse_unmerged_paths(out);
        assert_eq!(paths, vec!["src/a.ts", "文档/冲突 文件.md"]);
        // 相对路径拼到仓库根上；本来就是绝对路径的原样保留
        assert_eq!(
            absolute_paths("/repo", &paths),
            vec!["/repo/src/a.ts", "/repo/文档/冲突 文件.md"]
        );
        assert_eq!(absolute_paths("/repo", &["/abs/x".to_string()]), vec!["/abs/x"]);
        // 没有冲突时是空表
        assert!(parse_unmerged_paths("").is_empty());
    }

    #[test]
    fn summarize_git_trims_and_caps() {
        assert_eq!(summarize_git("  Fast-forward\n a.txt | 1 +\n  "), "Fast-forward\n a.txt | 1 +");
        assert_eq!(summarize_git("   "), "");
        let long: String = (0..50).map(|i| format!("line{i}\n")).collect();
        let summary = summarize_git(&long);
        assert_eq!(summary.lines().count(), 20, "最多 20 行");
        assert!(!summary.ends_with('\n'));
    }

    #[tokio::test]
    async fn real_repo_switch_branch_switches_and_refuses_conflicts() {
        let Some(git) = git_bin().await else { panic!("未找到 git") };
        let root = std::env::temp_dir().join(format!("omp-inn-switch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let init = std::process::Command::new(&git)
            .args(["init", "--initial-branch=main"])
            .arg(&work)
            .output()
            .unwrap();
        assert!(init.status.success());
        let w = work.to_string_lossy().to_string();
        let g = |args: &[&str]| {
            let out = std::process::Command::new(&git).arg("-C").arg(&work).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?} 失败：{}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        g(&["config", "user.email", "e2e@test.local"]);
        g(&["config", "user.name", "omp e2e"]);
        g(&["commit", "--allow-empty", "-m", "chore: init"]);
        g(&["branch", "feature/x"]);

        // 干净工作区：切出去再切回来
        switch_branch(w.clone(), "feature/x".into()).await.expect("切分支失败");
        assert_eq!(g(&["branch", "--show-current"]), "feature/x");
        switch_branch(w.clone(), "main".into()).await.unwrap();
        assert_eq!(g(&["branch", "--show-current"]), "main");

        // 不存在的分支：错误原文回传（命令失败而非 panic）
        let err = switch_branch(w.clone(), "nope".into()).await.unwrap_err();
        assert_eq!(err.code, "GIT_SWITCH");
        assert!(err.message.contains("nope"), "err={}", err.message);

        // 选项式输入在命令层就被拒（不会漏到 git 当参数）
        let err = switch_branch(w.clone(), "--orphan".into()).await.unwrap_err();
        assert_eq!(err.code, "BAD_ARG");

        // 脏工作区冲突：目标分支里该文件内容不同 → git 拒绝，工作区保持原分支
        std::fs::write(work.join("f.txt"), "main-version\n").unwrap();
        g(&["add", "f.txt"]);
        g(&["commit", "-m", "chore: f on main"]);
        g(&["switch", "-c", "other"]);
        std::fs::write(work.join("f.txt"), "other-version\n").unwrap();
        g(&["commit", "-am", "chore: f on other"]);
        g(&["switch", "main"]);
        std::fs::write(work.join("f.txt"), "uncommitted-edit\n").unwrap();
        let err = switch_branch(w.clone(), "other".into()).await.unwrap_err();
        assert_eq!(err.code, "GIT_SWITCH");
        assert!(err.message.contains("overwritten"), "err={}", err.message);
        assert_eq!(g(&["branch", "--show-current"]), "main", "冲突拒绝后必须留在原分支");
        assert_eq!(std::fs::read_to_string(work.join("f.txt")).unwrap(), "uncommitted-edit\n", "改动不得被动过");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn real_repo_pull_merges_and_stops_at_conflicts() {
        let Some(git) = git_bin().await else { panic!("未找到 git") };
        let root = std::env::temp_dir().join(format!("omp-inn-pull-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let remote = root.join("remote.git");
        std::fs::create_dir_all(&remote).unwrap();
        let run = |dir: &std::path::Path, args: &[&str]| {
            let out = std::process::Command::new(&git).arg("-C").arg(dir).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?} 失败：{}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        assert!(std::process::Command::new(&git)
            .args(["init", "--bare", "--initial-branch=main"])
            .arg(&remote)
            .output()
            .unwrap()
            .status
            .success());

        // 两个克隆（A = 本应用操作的仓库，B = 模拟同事推送）
        let a = root.join("a");
        let b = root.join("b");
        for dir in [&a, &b] {
            let out = std::process::Command::new(&git)
                .args(["clone", remote.to_str().unwrap(), dir.to_str().unwrap()])
                .output()
                .unwrap();
            assert!(out.status.success(), "clone 失败：{}", String::from_utf8_lossy(&out.stderr));
            run(dir, &["config", "user.email", "e2e@test.local"]);
            run(dir, &["config", "user.name", "omp e2e"]);
        }
        let a_str = a.to_string_lossy().to_string();

        // 首个提交（A 推上去，B 跟上）
        std::fs::write(a.join("f.txt"), "base\n").unwrap();
        run(&a, &["add", "."]);
        run(&a, &["commit", "-m", "chore: init"]);
        run(&a, &["push", "-u", "origin", "main"]);
        run(&b, &["pull", "--ff-only"]);

        // 远程有新提交 → 快进合并（状态 merged，behind 归零）
        std::fs::write(b.join("g.txt"), "from b\n").unwrap();
        run(&b, &["add", "."]);
        run(&b, &["commit", "-m", "feat: g"]);
        run(&b, &["push"]);
        let out = pull_workspace(a_str.clone()).await.expect("快进失败");
        assert_eq!(out.status, "merged");
        assert!(out.conflicts.is_empty());
        assert_eq!(std::fs::read_to_string(a.join("g.txt")).unwrap(), "from b\n");
        // 再拉一次：没有新提交（HEAD 不变）
        let out = pull_workspace(a_str.clone()).await.expect("重复拉取失败");
        assert_eq!(out.status, "up-to-date");

        // 双方改同一个文件 → 冲突：停在合并态，冲突文件是绝对路径。
        // A 的提交**只留在本地**（推上去 B 就成了快进），B 基于当前远程改同一文件并推送。
        std::fs::write(a.join("f.txt"), "a-version\n").unwrap();
        run(&a, &["commit", "-am", "chore: a"]);
        run(&b, &["pull", "--ff-only"]);
        std::fs::write(b.join("f.txt"), "b-version\n").unwrap();
        run(&b, &["commit", "-am", "chore: b"]);
        run(&b, &["push"]);
        let out = pull_workspace(a_str.clone()).await.expect("冲突应走 Ok 返回");
        assert_eq!(out.status, "conflicts");
        assert!(!out.conflicts.is_empty());
        let conflict = std::path::Path::new(&out.conflicts[0]);
        assert!(conflict.is_absolute(), "冲突文件必须是绝对路径：{}", out.conflicts[0]);
        assert_eq!(conflict.file_name().unwrap(), "f.txt");
        assert!(run(&a, &["status", "--porcelain"]).contains("UU f.txt"), "应停在未合并态");

        // 放弃合并：回到拉取前（本地那次提交还在）
        abort_merge(a_str.clone()).await.expect("放弃合并失败");
        assert_eq!(std::fs::read_to_string(a.join("f.txt")).unwrap(), "a-version\n");
        assert!(run(&a, &["status", "--porcelain"]).is_empty());
        // 不在合并态时继续合并被拒
        let err = continue_merge(a_str.clone()).await.unwrap_err();
        assert_eq!(err.code, "NOT_MERGING");

        // 冲突解决后继续合并：改文件 → 标记已解决 → 合并提交
        let out = pull_workspace(a_str.clone()).await.expect("再次拉取失败");
        assert_eq!(out.status, "conflicts");
        std::fs::write(a.join("f.txt"), "resolved\n").unwrap();
        continue_merge(a_str.clone()).await.expect("继续合并失败");
        assert!(run(&a, &["log", "-1", "--format=%P"]).split_whitespace().count() == 2, "应产生合并提交");
        assert!(run(&a, &["status", "--porcelain"]).is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }
}
