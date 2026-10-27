//! 提交信息快路径（V19）：一次 `omp -p` 单轮生成，不走 `omp commit` 的 agent 流水线。
//!
//! 为什么这样快（2026-09-23 实测，omp 18.2.10）：
//! - `omp commit` 是整条 agent 流水线（模型注册表刷新 → changelog 检测 → 上下文发现 →
//!   多轮 agent + 校验器 → 提交），实测 16–35s，空跑一次也要 ~10s；
//! - `omp -p`（打印模式）只加载配置 + 一次模型调用：本机实测**热启 2.28s**（冷启 5.36s），
//!   且 `--no-session` 不落会话文件、stdout 只有助手文本（stderr 只有 `Working...` 进度行）。
//!
//! 参数（实测有效；分离 token 形式，与 `runtime.rs` 的 `--cwd <dir>` 一致）：
//! `-p --no-session --no-tools --no-lsp --no-extensions --no-rules --max-time 2m --cwd <dir>`
//! + `--model <m>` / `--thinking <l>`（来自 `modelRoles.commit`）。
//!
//! **`--no-rules` 是必需的**：带上用户级规则时，模型会把「开场白」之类的规则一起执行
//! （实测输出第一行是 `OK了老铁`）——提交信息必须是干净的一段文本。格式约定改由
//! [`build_commit_prompt`] 自己写进提示词，不依赖外部规则。

use std::process::Stdio;
use std::time::Duration;

use crate::git_info::run_git;

/// 送进提示词的 diff 上限（**字符**数，不是字节）：再大就按行截断，只保留统计信息不截。
pub(crate) const DIFF_LIMIT: usize = 60_000;
/// 解析后提交信息的上限（防模型跑飞把正文写成长文）。
pub(crate) const MESSAGE_LIMIT: usize = 4000;
/// 模型目录 / 配置读取的超时（`omp config get` 实测 ~0.1s，给足余量）。
const CONFIG_TIMEOUT: Duration = Duration::from_secs(20);

// ---------- 纯函数（全部带单测） ----------

/// `omp -p` 的完整参数（顺序固定，便于单测）。
pub(crate) fn generate_args(
    model: Option<&str>,
    thinking: Option<&str>,
    cwd: &str,
    prompt: &str,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--no-session".into(),
        "--no-tools".into(),
        "--no-lsp".into(),
        "--no-extensions".into(),
        "--no-rules".into(),
        "--max-time".into(),
        "2m".into(),
        "--cwd".into(),
        cwd.to_string(),
    ];
    if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
        args.push("--model".into());
        args.push(m.to_string());
    }
    if let Some(l) = thinking.map(str::trim).filter(|l| !l.is_empty()) {
        args.push("--thinking".into());
        args.push(l.to_string());
    }
    args.push(prompt.to_string());
    args
}

/// 按**行边界**截断 diff：返回 `(保留文本, 截断信息)`；
/// 没超限时截断信息为 `None`（`(总数, 保留数)` 只在真截断时才有意义）。
pub(crate) fn truncate_diff(diff: &str, limit: usize) -> (String, Option<(usize, usize)>) {
    let total_lines = diff.lines().count();
    if diff.chars().count() <= limit {
        return (diff.to_string(), None);
    }
    let mut kept = String::new();
    let mut used = 0usize;
    let mut kept_lines = 0usize;
    for line in diff.lines() {
        let cost = line.chars().count() + 1;
        if used + cost > limit {
            break;
        }
        kept.push_str(line);
        kept.push('\n');
        used += cost;
        kept_lines += 1;
    }
    (kept, Some((total_lines, kept_lines)))
}

/// 拼提示词：格式约定写死在这里（不依赖用户的规则文件，见模块头注释）。
pub(crate) fn build_commit_prompt(
    language: Option<&str>,
    stat: &str,
    diff: &str,
    truncated: Option<(usize, usize)>,
) -> String {
    let lang = language
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .unwrap_or("（无额外要求，按上面的仓库约定）");
    let mut prompt = format!(
        "你是提交信息生成器。下面是本次 git 提交的全部变更。\
只输出提交信息本身——不要解释、不要前后缀、不要 Markdown 代码块，也不要任何开场白或问候语。\n\
\n\
格式（仓库约定）：\n\
- 第一行：<type>: <摘要> 或 <type>(<scope>): <摘要>；type ∈ feat|fix|refactor|perf|docs|test|build|ci|chore|style|revert\n\
- 摘要首词必须是英文过去式动词（Added / Fixed / Removed / Updated …），摘要不超过 30 个字符（不含 type 前缀）\n\
- 摘要其余部分与正文用简体中文（下面的「语言要求」优先）\n\
- 正文（可选）：空一行后写 1–3 行要点，每行以 \"- \" 开头，写「改了什么、为什么」\n\
\n\
语言要求：{lang}\n\
\n\
变更统计：\n{stat}\n\
\n\
diff：\n{diff}"
    );
    if let Some((total, kept)) = truncated {
        prompt.push_str(&format!(
            "\n…（diff 过长已截断：共 {total} 行，仅展示前 {kept} 行；统计信息仍是全部变更）"
        ));
    }
    prompt
}

/// 把模型输出洗成提交信息：
/// 去 ANSI → 去首尾空白 → 去掉整体包裹的代码围栏 → 去掉「提交信息：」这类标签首行 →
/// 行尾去空白 → 连续空行压成一空行 → 截到 [`MESSAGE_LIMIT`] 字符（行边界）。
pub(crate) fn parse_commit_message(raw: &str) -> String {
    let text = crate::git_commit::strip_ansi(raw);
    let mut lines: Vec<String> = text.lines().map(|l| l.trim_end().to_string()).collect();
    // 去掉整体包裹的围栏（``` / ```bash 之类）：首尾行同时匹配才删
    if lines.len() >= 2 {
        let first = lines.first().map(|l| l.trim().to_string()).unwrap_or_default();
        let last = lines.last().map(|l| l.trim().to_string()).unwrap_or_default();
        let fence = |l: &str| l.starts_with("```") && l.len() <= 16 && l[3..].chars().all(|c| c.is_ascii_alphanumeric());
        if fence(&first) && fence(&last) {
            lines.remove(0);
            lines.pop();
        }
    }
    // 去掉「提交信息：」/「Commit message:」这类标签行（只认第一行，且必须是纯标签）
    if let Some(first) = lines.first() {
        let t = first.trim();
        let labelled = (t.ends_with('：') || t.ends_with(':'))
            && (t.contains("提交信息") || t.to_ascii_lowercase().contains("commit message"));
        if labelled && t.chars().count() <= 40 {
            lines.remove(0);
        }
    }
    let mut out: Vec<String> = vec![];
    let mut blank = 0usize;
    for line in lines {
        if line.trim().is_empty() {
            blank += 1;
            continue;
        }
        if !out.is_empty() && blank > 0 {
            out.push(String::new());
        }
        blank = 0;
        out.push(line);
    }
    let joined = out.join("\n");
    let trimmed = joined.trim();
    if trimmed.chars().count() <= MESSAGE_LIMIT {
        return trimmed.to_string();
    }
    let (kept, _) = truncate_diff(trimmed, MESSAGE_LIMIT);
    kept.trim_end().to_string()
}

// ---------- 运行时 ----------

/// 读 `modelRoles.commit`（在**仓库目录**里读，拿到该项目生效的那份配置）。
/// 读不到一律 `None`（不传 `--model`，跟随 omp 默认），不报错。
pub(crate) async fn read_commit_role(bin: &str, cwd: &str) -> Option<String> {
    let fut = tokio::process::Command::new(bin)
        .args(["config", "get", "modelRoles", "--json"])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output();
    let out = match tokio::time::timeout(CONFIG_TIMEOUT, fut).await {
        Ok(Ok(o)) if o.status.success() => o,
        _ => return None,
    };
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    v.get("value")?.get("commit")?.as_str().map(str::to_string)
}

/// 暂存区统计（`git diff --cached --stat`，给提示词用）；失败返回空串（提示词里留空）。
pub(crate) async fn staged_stat(git: &str, cwd: &str) -> String {
    run_git(git, cwd, &["diff", "--cached", "--stat"]).await.unwrap_or_default()
}

/// 暂存区完整 diff（`git diff --cached`；失败返回空串）。
pub(crate) async fn staged_diff(git: &str, cwd: &str) -> String {
    run_git(git, cwd, &["diff", "--cached"]).await.unwrap_or_default()
}

/// spawn `omp -p …`：继承登录 shell 的 PATH（GUI .app 的 PATH 缺 Homebrew）、
/// 新进程组（取消时打 `-pid` 覆盖子进程）、`kill_on_drop`——与 `git_commit.rs` 同口径。
pub(crate) fn spawn_generate(
    bin: &str,
    args: &[String],
    cwd: &str,
) -> std::io::Result<tokio::process::Child> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(path) = crate::proc::login_path() {
        cmd.env("PATH", path);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.as_std_mut().process_group(0);
    }
    cmd.spawn()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_args_shape_is_fixed() {
        let args = generate_args(Some("provider/model"), Some("low"), "/tmp/repo", "写提交信息");
        assert_eq!(
            args,
            vec![
                "-p",
                "--no-session",
                "--no-tools",
                "--no-lsp",
                "--no-extensions",
                "--no-rules",
                "--max-time",
                "2m",
                "--cwd",
                "/tmp/repo",
                "--model",
                "provider/model",
                "--thinking",
                "low",
                "写提交信息",
            ]
        );
    }

    #[test]
    fn generate_args_drop_blank_model_and_thinking() {
        let args = generate_args(None, Some("  "), "/repo", "p");
        assert!(!args.contains(&"--model".to_string()));
        assert!(!args.contains(&"--thinking".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("p"));
    }

    #[test]
    fn truncate_diff_keeps_whole_lines_and_reports_counts() {
        let diff = (1..=10).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        let (kept, info) = truncate_diff(&diff, 1000);
        assert_eq!(info, None);
        assert_eq!(kept, diff);

        // 每行 8 字符（含换行），40 字符只放得下 5 行
        let (kept, info) = truncate_diff(&diff, 40);
        assert_eq!(info, Some((10, 5)));
        assert_eq!(kept.lines().count(), 5);
        assert!(diff.starts_with(&kept));
    }

    #[test]
    fn prompt_carries_language_and_truncation_note() {
        let p = build_commit_prompt(Some("请用英文撰写提交信息。"), " a | 1 +", "diff 内容", None);
        assert!(p.contains("语言要求：请用英文撰写提交信息。"));
        assert!(p.contains("变更统计：\n a | 1 +"));
        assert!(p.contains("diff：\ndiff 内容"));
        assert!(!p.contains("已截断"));
        // 系统默认档：语言要求写成「无额外要求」，不空着
        let p = build_commit_prompt(None, "", "", Some((120, 40)));
        assert!(p.contains("语言要求：（无额外要求，按上面的仓库约定）"));
        assert!(p.contains("…（diff 过长已截断：共 120 行，仅展示前 40 行；统计信息仍是全部变更）"));
        // 不带规则文件也要求不要开场白（实测带规则时模型会输出「OK了老铁」）
        assert!(p.contains("不要任何开场白"));
    }

    #[test]
    fn parse_message_strips_fences_labels_and_noise() {
        assert_eq!(parse_commit_message("feat: Added 新面板\n"), "feat: Added 新面板");
        assert_eq!(
            parse_commit_message("```\nfeat: Added 新面板\n\n- 说明\n```\n"),
            "feat: Added 新面板\n\n- 说明"
        );
        assert_eq!(
            parse_commit_message("提交信息：\nfix: Fixed 崩溃\n"),
            "fix: Fixed 崩溃"
        );
        assert_eq!(
            parse_commit_message("Commit message:\n\nchore: Updated 依赖\n"),
            "chore: Updated 依赖"
        );
        // 行尾空白去掉、连续空行压成一个
        assert_eq!(
            parse_commit_message("feat: Added a  \n\n\n\n- x   \n"),
            "feat: Added a\n\n- x"
        );
        // ANSI 颜色码：omp 输出带颜色时不能进提交信息
        assert_eq!(
            parse_commit_message("\u{1b}[38;2;1;2;3mfix: Fixed 颜色\u{1b}[39m\n"),
            "fix: Fixed 颜色"
        );
        // 空输入 / 只有空白 → 空串（调用方按「生成失败」处理）
        assert_eq!(parse_commit_message("   \n\n"), "");
        assert_eq!(parse_commit_message(""), "");
        // 正文里的 `- ` 列表不会被当成围栏或标签删掉
        assert_eq!(parse_commit_message("feat: Added x\n\n- a\n- b\n").lines().count(), 4);
    }

    #[test]
    fn parse_message_caps_length_on_line_boundary() {
        let body = (0..500).map(|i| format!("- 第 {i} 行说明")).collect::<Vec<_>>().join("\n");
        let msg = format!("feat: Added 长正文\n\n{body}");
        let parsed = parse_commit_message(&msg);
        assert!(parsed.chars().count() <= MESSAGE_LIMIT);
        assert!(msg.starts_with(parsed.as_str()));
        assert!(parsed.starts_with("feat: Added 长正文"));
    }
}
