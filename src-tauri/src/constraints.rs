//! 设置 ›「omp 约束」：可视化编辑 omp 的**全局**约束文件与规则文件。
//!
//! 上游事实（omp 18.11.1：官方文档 `docs/context-files.md` /
//! `docs/rulebook-matching-pipeline.md` + 本机实测）：
//!
//! - **全局约束** = `<agentDir>/AGENTS.md`（native provider 的用户级上下文文件，priority 100，
//!   每次会话启动注入 `<repo-rules>`）；
//! - **全局硬规则** = `<agentDir>/RULES.md`（sticky rule，按 always-apply 每轮重挂；
//!   frontmatter 不能把它改成按需规则）；
//! - **独立规则** = `<agentDir>/rules/*.{md,mdc}`（文件名即规则名；`enabled: false` 在发现
//!   阶段就被排除；frontmatter 支持 description / globs / alwaysApply / condition /
//!   astCondition / question / scope / agents / interruptMode / enabled）；
//! - `omp ttsr list --json` **只列有 TTSR 条件（condition / astCondition / question）的规则**，
//!   规则手册规则（只有 description / globs）根本不在里面——所以壳侧不拿它当保存门槛，
//!   规则语义的校验在设置页前端（`src/lib/constraints.ts`，`yaml` 库解析 + 字段类型校验）。
//!
//! 壳侧的边界：
//!
//! - **只写全局层**：只认上面三处路径；项目级 `.omp/AGENTS.md` / `.omp/RULES.md` /
//!   `.omp/rules/*.md` 由 omp 从项目目录自己发现，本页不碰；
//! - **文件名白名单**：`AGENTS.md` / `RULES.md` 固定；规则文件只允许 `rules/` 下单层、
//!   以 `.md` / `.mdc` 结尾、不以 `.` 开头、不含路径分隔符与控制字符的名字；
//! - **写前校验**：大小上限 2 MiB、拒绝 NUL、规则 frontmatter 必须有结束行（`---` / `...`）；
//! - **乐观锁**：`expectHash` = 打开时的内容哈希；文件被外部改过（或从「不存在」变成存在）
//!   就拒绝写入，前端提示重新加载——绝不静默覆盖用户手改的内容；
//! - **备份 + 原子写**：写前把旧文件备份到 `<appData>/omp-inn/backups/constraints/`
//!   （按文件名保留最近 10 份，复用 `models_config::backup_file`），再同目录临时文件 + rename；
//! - **删除规则**先备份再删（不可逆，界面二次确认），备份失败直接拒绝删除。
//!
//! 写入是否立刻影响**已打开**的会话未实测（omp 在会话启动 / `/clear` / `/new` 时重新发现
//! 规则与上下文文件），界面上的表述只做必然为真的那一句：「新建的会话一定读到」。

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::commands::{cmd_err, AppState, CmdError};
use crate::models_config::{backup_file, hash_text, write_atomic};

/// 单份约束 / 规则文件的文本上限：这些是 Markdown 指令文件，2 MiB 已远超合理体量。
pub const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

/// 规则文件名上限（含扩展名）：给文件名留出余量，避免异常长的路径。
pub const MAX_RULE_NAME_LEN: usize = 96;

// ---------- 视图类型 ----------

/// 一份全局约束 / 规则文件的当前状态（列表与写入回包共用）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintFile {
    /// `agents`（AGENTS.md）/ `rules`（RULES.md）/ `rule`（rules/*.md）。
    pub kind: String,
    /// 完整文件名（`AGENTS.md` / `RULES.md` / `no-any.md`）。
    pub name: String,
    pub path: String,
    pub exists: bool,
    pub content: String,
    /// 内容哈希（FNV-1a，与 `models_config` 同一口径）；不存在时为空串。
    pub hash: String,
    pub modified_ms: Option<u64>,
    pub size: u64,
    /// 读取失败的原文（非 UTF-8 / 超上限 / 权限），成功时为 `None`——坏文件也在列表里露脸，
    /// 不因为一份读不了就把整页变成空。
    pub error: Option<String>,
}

/// 「omp 约束」页的文件清单：固定两份全局文件（不存在也占位）+ `rules/` 下的独立规则。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintsView {
    pub agent_dir: String,
    pub rules_dir: String,
    pub files: Vec<ConstraintFile>,
    /// 规则目录列举失败（权限 / 非目录）时的说明；正常为 `None`。
    pub rules_error: Option<String>,
}

// ---------- 纯逻辑（单测锁着） ----------

/// 规则文件名是否合法：`<stem>.md` / `<stem>.mdc`，单层、非隐藏、无控制字符。
///
/// 规则名就是文件名（omp 的 `name = filename without extension`），所以这里把路径形状
/// 钉死：`..` / `/` / `\` 一律进不来；点只允许出现在 stem 中间（`foo.bar.md` 合法）。
pub fn valid_rule_name(name: &str) -> bool {
    if name.is_empty() || name.len() > MAX_RULE_NAME_LEN || name.trim() != name {
        return false;
    }
    if name.starts_with('.')
        || name
            .chars()
            .any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return false;
    }
    if name.chars().any(char::is_control) {
        return false;
    }
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    !stem.is_empty() && (ext == "md" || ext == "mdc")
}

/// 新建规则时把用户输入的「规则名」规范化成文件名：没写扩展名就补 `.md`。
///
/// 用户输入带 `.md` / `.mdc` 时原样保留（避免出现 `foo.md.md`）。
pub fn rule_name_from_stem(stem: &str) -> Result<String, String> {
    let stem = stem.trim();
    if stem.is_empty() {
        return Err("规则名不能为空".into());
    }
    let name = if stem.ends_with(".md") || stem.ends_with(".mdc") {
        stem.to_string()
    } else {
        format!("{stem}.md")
    };
    if !valid_rule_name(&name) {
        return Err(
            "规则名只能包含一层文件名：不能以 `.` 开头，不能含 `/`、`\\` 或控制字符，扩展名只能是 .md / .mdc"
                .into(),
        );
    }
    Ok(name)
}

/// 规则 frontmatter 的结构校验：以 `---` 开头时必须有**独占一行**的结束行。
///
/// 只查分隔符，不解析 YAML——YAML 的完整解析在前端（`yaml` 库），这里防的是「分隔符
/// 没写全导致整份规则被 omp 当成正文」这种结构性坏文件。AGENTS.md 不调用它
/// （普通 Markdown 里的 `---` 可能只是分隔线）。
pub fn validate_frontmatter(text: &str) -> Result<(), String> {
    let text = text.trim_start_matches('\u{feff}');
    let mut lines = text.lines();
    let Some(first) = lines.next() else {
        return Ok(());
    };
    if first.trim_end() != "---" {
        return Ok(());
    }
    for line in lines {
        let line = line.trim_end();
        if line == "---" || line == "..." {
            return Ok(());
        }
    }
    Err("frontmatter 没有结束行：需要独占一行的 `---`（或 `...`）".into())
}

/// 乐观锁判定：`expect = None` 是「强制覆盖」（冲突对话框的显式选择）。
///
/// `expect = Some("")` 表示打开时文件**不存在**——现在若已存在（外部创建）就冲突；
/// `Some(hash)` 要求文件仍存在且内容哈希一致（外部删除也算冲突）。
pub fn check_expect(exists: bool, current: &str, expect: Option<&str>) -> Result<(), String> {
    let Some(expect) = expect else {
        return Ok(());
    };
    let ok = if expect.is_empty() {
        !exists
    } else {
        exists && hash_text(current) == expect
    };
    if ok {
        Ok(())
    } else {
        Err("文件已被外部修改（未写入）".into())
    }
}

/// kind + name → 磁盘路径。`agents` / `rules` 的 name 被忽略（路径固定），
/// `rule` 的 name 必须是 [`valid_rule_name`]。
pub fn constraint_path(agent: &Path, kind: &str, name: &str) -> Result<PathBuf, String> {
    match kind {
        "agents" => Ok(agent.join("AGENTS.md")),
        "rules" => Ok(agent.join("RULES.md")),
        "rule" => {
            if !valid_rule_name(name) {
                return Err(format!("非法的规则文件名：{name}"));
            }
            Ok(agent.join("rules").join(name))
        }
        other => Err(format!("未知的约束类型：{other}")),
    }
}

/// 读一份文件：不存在返回 `(false, "")`；存在但不是文件 / 非 UTF-8 / 超上限返回错误。
fn read_text(path: &Path) -> Result<(bool, String, Option<u64>, u64), String> {
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok((false, String::new(), None, 0))
        }
        Err(e) => return Err(format!("读取失败：{e}")),
    };
    if !meta.is_file() {
        return Err("路径不是文件".into());
    }
    if meta.len() > MAX_TEXT_BYTES as u64 {
        return Err(format!(
            "文件过大（{} 字节，上限 {MAX_TEXT_BYTES} 字节）",
            meta.len()
        ));
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("读取失败（{e}）；文件不是 UTF-8 文本？"))?;
    Ok((true, text, modified_ms(&meta), meta.len()))
}

fn modified_ms(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis().min(u64::MAX as u128) as u64)
}

/// 一份文件的视图（读失败时 `exists` 仍按磁盘上的事实给，`error` 带原因）。
fn file_view(kind: &str, name: &str, path: &Path) -> ConstraintFile {
    let exists = path.is_file();
    match read_text(path) {
        Ok((exists, content, modified, size)) => ConstraintFile {
            kind: kind.into(),
            name: name.into(),
            path: path.display().to_string(),
            exists,
            hash: hash_text(&content),
            content,
            modified_ms: modified,
            size,
            error: None,
        },
        Err(error) => ConstraintFile {
            kind: kind.into(),
            name: name.into(),
            path: path.display().to_string(),
            exists,
            hash: String::new(),
            content: String::new(),
            modified_ms: None,
            size: 0,
            error: Some(error),
        },
    }
}

/// 列全部全局约束与规则（固定两份文件在前，规则按名称排序）。
pub fn list_constraints(agent: &Path) -> ConstraintsView {
    let rules_dir = agent.join("rules");
    let mut files = vec![
        file_view("agents", "AGENTS.md", &agent.join("AGENTS.md")),
        file_view("rules", "RULES.md", &agent.join("RULES.md")),
    ];
    let mut rules_error = None;
    let mut names: Vec<String> = Vec::new();
    match std::fs::read_dir(&rules_dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let Ok(ft) = entry.file_type() else { continue };
                if !ft.is_file() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if valid_rule_name(&name) {
                    names.push(name);
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => rules_error = Some(format!("读取规则目录失败：{e}")),
    }
    names.sort_by_cached_key(|n| n.to_lowercase());
    files.extend(names.iter().map(|n| file_view("rule", n, &rules_dir.join(n))));
    ConstraintsView {
        agent_dir: agent.display().to_string(),
        rules_dir: rules_dir.display().to_string(),
        files,
        rules_error,
    }
}

/// 写入前的内容校验（大小 / NUL / 规则 frontmatter 分隔符）。
pub fn validate_content(kind: &str, content: &str) -> Result<(), String> {
    if content.len() > MAX_TEXT_BYTES {
        return Err(format!(
            "内容过大（{} 字节，上限 {MAX_TEXT_BYTES} 字节）",
            content.len()
        ));
    }
    if content.contains('\0') {
        return Err("内容不能包含 NUL 字符".into());
    }
    if kind == "rule" || kind == "rules" {
        validate_frontmatter(content)?;
    }
    Ok(())
}

// ---------- 文件事务（与 Tauri 状态解耦，单测直接调） ----------

/// 写一份约束 / 规则文件：校验 → 乐观锁 → 备份 → 原子写 → 回读。
pub fn write_constraint_file(
    agent: &Path,
    backup_root: Option<&Path>,
    kind: &str,
    name: &str,
    content: &str,
    expect_hash: Option<&str>,
) -> Result<ConstraintFile, CmdError> {
    validate_content(kind, content).map_err(|e| cmd_err("CONSTRAINT_INVALID", e, None))?;
    let path = constraint_path(agent, kind, name).map_err(|e| cmd_err("CONSTRAINT_INVALID", e, None))?;
    let (exists, current, _, _) =
        read_text(&path).map_err(|e| cmd_err("CONSTRAINT_READ_FAILED", e, None))?;
    check_expect(exists, &current, expect_hash).map_err(|e| {
        cmd_err(
            "CONSTRAINT_CONFLICT",
            e,
            Some("重新加载后再试；确实要覆盖就选「强制覆盖」".into()),
        )
    })?;
    // 内容没变就不写、不备份——避免每次点保存都堆一份备份。
    if exists && current == content {
        return Ok(file_view(kind, &display_name(kind, name), &path));
    }
    if exists {
        if let Some(root) = backup_root {
            // 备份失败不阻断保存（与 models_config 同口径）；写入本身是原子的。
            let _ = backup_file(&path, &root.join("backups").join("constraints"));
        }
    }
    write_atomic(&path, content)
        .map_err(|e| cmd_err("CONSTRAINT_WRITE_FAILED", format!("写入失败：{e}"), None))?;
    let (_, written, _, _) =
        read_text(&path).map_err(|e| cmd_err("CONSTRAINT_READ_FAILED", e, None))?;
    if written != content {
        return Err(cmd_err(
            "CONSTRAINT_WRITE_FAILED",
            "写入后回读的内容与提交内容不一致".into(),
            Some("请检查文件系统权限或磁盘状态".into()),
        ));
    }
    Ok(file_view(kind, &display_name(kind, name), &path))
}

/// 固定两份文件在磁盘上的真实文件名（kind 决定名字，忽略前端传来的 name）。
fn display_name(kind: &str, name: &str) -> String {
    match kind {
        "agents" => "AGENTS.md".into(),
        "rules" => "RULES.md".into(),
        _ => name.into(),
    }
}

/// 新建一份独立规则（空文件；`rules/` 目录随原子写自动创建）。
pub fn create_rule_file(agent: &Path, stem: &str) -> Result<ConstraintFile, CmdError> {
    let name = rule_name_from_stem(stem).map_err(|e| cmd_err("CONSTRAINT_INVALID", e, None))?;
    let path = agent.join("rules").join(&name);
    if path.exists() {
        return Err(cmd_err(
            "CONSTRAINT_EXISTS",
            format!("规则文件已存在：{name}"),
            Some("换一个名字，或直接在列表里打开它".into()),
        ));
    }
    write_atomic(&path, "").map_err(|e| cmd_err("CONSTRAINT_WRITE_FAILED", format!("创建失败：{e}"), None))?;
    Ok(file_view("rule", &name, &path))
}

/// 删除一份独立规则：先备份再删；备份失败拒绝删除（不可逆操作不赌）。
pub fn delete_rule_file(
    agent: &Path,
    backup_root: Option<&Path>,
    name: &str,
) -> Result<(), CmdError> {
    let path = constraint_path(agent, "rule", name).map_err(|e| cmd_err("CONSTRAINT_INVALID", e, None))?;
    if !path.is_file() {
        return Err(cmd_err(
            "CONSTRAINT_NOT_FOUND",
            format!("规则文件不存在：{name}"),
            None,
        ));
    }
    if let Some(root) = backup_root {
        backup_file(&path, &root.join("backups").join("constraints")).map_err(|e| {
            cmd_err(
                "CONSTRAINT_BACKUP_FAILED",
                format!("备份失败，未删除：{e}"),
                Some("检查磁盘空间与备份目录权限后重试".into()),
            )
        })?;
    }
    std::fs::remove_file(&path)
        .map_err(|e| cmd_err("CONSTRAINT_DELETE_FAILED", format!("删除失败：{e}"), None))
}

// ---------- Tauri 命令 ----------

/// 全局约束 / 规则清单（含文件内容；本页一次读全，规则文件体量很小）。
#[tauri::command]
pub async fn get_omp_constraints(state: State<'_, AppState>) -> Result<ConstraintsView, CmdError> {
    let agent = state.agent_dir.lock().await.clone();
    Ok(list_constraints(&agent))
}

/// 写一份全局约束 / 规则（`expectHash = null` = 强制覆盖；见 [`check_expect`]）。
#[tauri::command]
pub async fn write_omp_constraint(
    state: State<'_, AppState>,
    kind: String,
    name: String,
    content: String,
    expect_hash: Option<String>,
) -> Result<ConstraintFile, CmdError> {
    let _guard = state.constraints_edit.lock().await;
    let agent = state.agent_dir.lock().await.clone();
    write_constraint_file(
        &agent,
        state.overlay_path.parent(),
        &kind,
        &name,
        &content,
        expect_hash.as_deref(),
    )
}

/// 新建独立规则（输入规则名；没写扩展名就补 `.md`）。
#[tauri::command]
pub async fn create_omp_rule(
    state: State<'_, AppState>,
    stem: String,
) -> Result<ConstraintFile, CmdError> {
    let _guard = state.constraints_edit.lock().await;
    let agent = state.agent_dir.lock().await.clone();
    create_rule_file(&agent, &stem)
}

/// 删除独立规则（先备份；界面负责二次确认）。
#[tauri::command]
pub async fn delete_omp_rule(state: State<'_, AppState>, name: String) -> Result<(), CmdError> {
    let _guard = state.constraints_edit.lock().await;
    let agent = state.agent_dir.lock().await.clone();
    delete_rule_file(&agent, state.overlay_path.parent(), &name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "omp-inn-constraints-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rule_names_accept_flat_markdown_files() {
        assert!(valid_rule_name("no-any.md"));
        assert!(valid_rule_name("rust.lints.mdc"));
        assert!(valid_rule_name("中文规则.md"));
        assert!(valid_rule_name("rule_1.md"));
        assert!(!valid_rule_name(""));
        assert!(!valid_rule_name(".hidden.md"));
        assert!(!valid_rule_name("../escape.md"));
        assert!(!valid_rule_name("dir/rule.md"));
        assert!(!valid_rule_name("dir\\rule.md"));
        assert!(!valid_rule_name("a:b.md"));
        assert!(!valid_rule_name("a*b.md"));
        assert!(!valid_rule_name("a?b.md"));
        assert!(!valid_rule_name("a|b.md"));
        assert!(!valid_rule_name("\"a\".md"));
        assert!(!valid_rule_name("rule.txt"));
        assert!(!valid_rule_name("rule"));
        assert!(!valid_rule_name(".md"));
        assert!(!valid_rule_name(" rule.md"));
        assert!(!valid_rule_name("rule.md "));
        assert!(!valid_rule_name("bad\nrule.md"));
        assert!(!valid_rule_name(&format!("{}.md", "a".repeat(MAX_RULE_NAME_LEN))));
    }

    #[test]
    fn rule_name_from_stem_adds_default_extension() {
        assert_eq!(rule_name_from_stem("no-any").unwrap(), "no-any.md");
        assert_eq!(rule_name_from_stem("no-any.md").unwrap(), "no-any.md");
        assert_eq!(rule_name_from_stem("no-any.mdc").unwrap(), "no-any.mdc");
        assert_eq!(rule_name_from_stem("  中文  ").unwrap(), "中文.md");
        assert!(rule_name_from_stem("").is_err());
        assert!(rule_name_from_stem("../x").is_err());
    }

    #[test]
    fn frontmatter_must_be_closed() {
        assert!(validate_frontmatter("").is_ok());
        assert!(validate_frontmatter("# 正文\n---\n分隔线不算 frontmatter").is_ok());
        assert!(validate_frontmatter("---\ndescription: x\n---\n正文").is_ok());
        assert!(validate_frontmatter("---\ndescription: x\n...\n正文").is_ok());
        assert!(validate_frontmatter("---\r\ndescription: x\r\n---\r\n正文").is_ok());
        assert!(validate_frontmatter("---\ndescription: x\n正文").is_err());
        assert!(validate_frontmatter("---\n").is_err());
    }

    #[test]
    fn expect_hash_guards_external_edits() {
        assert!(check_expect(false, "", Some("")).is_ok());
        assert!(check_expect(true, "x", Some(&hash_text("x"))).is_ok());
        // 打开时不存在，之后被外部创建 → 冲突
        assert!(check_expect(true, "x", Some("")).is_err());
        // 打开时存在，之后被外部修改 / 删除 → 冲突
        assert!(check_expect(true, "y", Some(&hash_text("x"))).is_err());
        assert!(check_expect(false, "", Some(&hash_text("x"))).is_err());
        // None = 强制覆盖
        assert!(check_expect(true, "whatever", None).is_ok());
    }

    #[test]
    fn content_validation_rejects_bad_shape() {
        assert!(validate_content("agents", "---\n不是规则 frontmatter 也允许\n").is_ok());
        assert!(validate_content("rule", "---\ndescription: x\n---\n正文").is_ok());
        assert!(validate_content("rule", "---\ndescription: x\n").is_err());
        assert!(validate_content("rule", "正文\n\0").is_err());
        assert!(validate_content("rule", &"a".repeat(MAX_TEXT_BYTES + 1)).is_err());
    }

    #[test]
    fn list_constraints_reports_fixed_files_and_rules() {
        let dir = tmp("list");
        std::fs::write(dir.join("AGENTS.md"), "# 约束\n").unwrap();
        std::fs::write(dir.join("RULES.md"), "---\nalwaysApply: true\n---\n规则\n").unwrap();
        std::fs::create_dir_all(dir.join("rules")).unwrap();
        std::fs::write(dir.join("rules/no-any.md"), "正文").unwrap();
        std::fs::write(dir.join("rules/zeta.mdc"), "正文").unwrap();
        std::fs::write(dir.join("rules/notes.txt"), "不是规则").unwrap();
        std::fs::write(dir.join("rules/.hidden.md"), "隐藏文件").unwrap();
        std::fs::create_dir_all(dir.join("rules/sub.md")).unwrap();

        let view = list_constraints(&dir);
        let names: Vec<&str> = view.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["AGENTS.md", "RULES.md", "no-any.md", "zeta.mdc"]);
        assert_eq!(view.files[0].kind, "agents");
        assert_eq!(view.files[1].kind, "rules");
        assert_eq!(view.files[2].kind, "rule");
        assert!(view.files.iter().all(|f| f.exists && f.error.is_none()));
        assert!(view.files[0].content.contains("# 约束"));
        assert_eq!(view.files[0].hash, hash_text("# 约束\n"));
        assert!(view.rules_error.is_none());
    }

    #[test]
    fn list_constraints_tolerates_missing_agent_dir() {
        let dir = tmp("missing").join("not-yet");
        let view = list_constraints(&dir);
        assert_eq!(view.files.len(), 2);
        assert!(view.files.iter().all(|f| !f.exists && f.content.is_empty()));
        assert!(view.rules_error.is_none());
    }

    #[test]
    fn write_constraint_backs_up_and_returns_written_truth() {
        let dir = tmp("write");
        let backups = tmp("write-backups");
        let first = write_constraint_file(
            &dir,
            Some(&backups),
            "agents",
            "AGENTS.md",
            "# 第一版\n",
            Some(""),
        )
        .unwrap();
        assert!(first.exists);
        assert_eq!(first.content, "# 第一版\n");
        assert!(std::fs::read_dir(backups.join("backups/constraints")).is_err());

        let second = write_constraint_file(
            &dir,
            Some(&backups),
            "agents",
            "AGENTS.md",
            "# 第二版\n",
            Some(&first.hash),
        )
        .unwrap();
        assert_eq!(second.content, "# 第二版\n");
        let backup_dir = backups.join("backups/constraints");
        assert_eq!(std::fs::read_dir(&backup_dir).unwrap().count(), 1);
        let backed = std::fs::read_dir(&backup_dir)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(std::fs::read_to_string(backed).unwrap(), "# 第一版\n");
    }

    #[test]
    fn write_constraint_rejects_conflicts() {
        let dir = tmp("conflict");
        write_constraint_file(&dir, None, "rules", "RULES.md", "a", Some("")).unwrap();
        // 用旧哈希再写 → 冲突
        let err = write_constraint_file(&dir, None, "rules", "RULES.md", "b", Some("deadbeef")).unwrap_err();
        assert_eq!(err.code, "CONSTRAINT_CONFLICT");
        // 未变化的内容是幂等的（不写、不报错）
        let same = write_constraint_file(&dir, None, "rules", "RULES.md", "a", Some(&hash_text("a"))).unwrap();
        assert_eq!(same.content, "a");
        // 强制覆盖
        let forced = write_constraint_file(&dir, None, "rules", "RULES.md", "c", None).unwrap();
        assert_eq!(forced.content, "c");
    }

    #[test]
    fn create_and_delete_rules() {
        let dir = tmp("create");
        let backups = tmp("create-backups");
        let created = create_rule_file(&dir, "no-any").unwrap();
        assert_eq!(created.name, "no-any.md");
        assert!(created.exists);
        assert!(dir.join("rules/no-any.md").is_file());
        // 重名
        let err = create_rule_file(&dir, "no-any").unwrap_err();
        assert_eq!(err.code, "CONSTRAINT_EXISTS");
        // 写入内容后删除，留下备份
        write_constraint_file(
            &dir,
            Some(&backups),
            "rule",
            "no-any.md",
            "---\ndescription: 测试\n---\n正文\n",
            Some(&created.hash),
        )
        .unwrap();
        delete_rule_file(&dir, Some(&backups), "no-any.md").unwrap();
        assert!(!dir.join("rules/no-any.md").exists());
        // 两次备份：写入前（空的旧文件）+ 删除前（有正文的版本）
        let backup_dir = backups.join("backups/constraints");
        assert_eq!(std::fs::read_dir(&backup_dir).unwrap().count(), 2);
        // 不存在再删 → NOT_FOUND
        let err = delete_rule_file(&dir, Some(&backups), "no-any.md").unwrap_err();
        assert_eq!(err.code, "CONSTRAINT_NOT_FOUND");
        // 非法名字
        let err = delete_rule_file(&dir, None, "../AGENTS.md").unwrap_err();
        assert_eq!(err.code, "CONSTRAINT_INVALID");
    }
}
