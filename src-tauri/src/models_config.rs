//! 自定义模型接入（`<agentDir>/models.yml`）：omp 用户级**自定义供应商 / 模型**的可视化配置。
//!
//! **上游事实（omp 18.2.2 本机实测）**
//!
//! - 位置：`<agentDir>/models.yml` 优先；它不存在时才用 `<agentDir>/models.yaml`
//!   （实测两文件并存时 **yaml 被整体忽略**）——界面读写的必须是「当前生效的那个文件」。
//! - **上游没有任何 CLI 写入口**：`omp models` 只有 ls / find / refresh，`omp config`
//!   只管 `config.yml`——写文件是自定义模型的唯一路径，这正是本模块存在的原因。
//! - 坏配置的失败模式：`omp models --json` **退出码仍为 0**，但 stderr 打
//!   `Warning: models.yml validation failed — custom providers disabled` +
//!   `Failed to load config file models, …`，且**整个文件的自定义 provider 全部失效**。
//!   所以写入前必须预校验——拿候选文本在临时 agentDir 里问一次 omp（见 [`validate_text`]）。
//! - 空文件 / 只有注释同样非法（`Schema error: root: must be an object (was null)`）：
//!   界面删光所有自定义项后必须留下 `providers: {}`（由前端保证）。
//! - 自定义 provider 的 `apiKey` 对 `openai-completions` 会自动注入
//!   `Authorization: Bearer <key>`（实测，无需 `authHeader`）。
//!
//! **职责分工**：YAML 的保真编辑（保留注释与格式——零修改往返逐字节一致）在前端做
//! （`src/lib/customModels.ts`，npm `yaml` 包）；后端只管文件 IO：
//! 读（带 hash 乐观锁）→ 预校验 → 备份 → 原子写 → 回读。
//! 用户手改文件与界面保存并发时，hash 不再匹配，写入被拒（提示重新加载）而不是互相覆盖。

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::State;

use crate::commands::{cmd_err, AppState, CmdError};

/// 预校验的超时：比常规 CLI 超时（30s）宽——冷启动的 omp 会联网拉模型目录。
const VALIDATE_TIMEOUT: Duration = Duration::from_secs(60);
/// 候选文本上限（防呆：models.yml 正常在 KB 级）。
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
/// 备份保留份数（按文件名时序，超出删最老）。
const BACKUPS_KEEP: usize = 10;

/// `models.yml`（或回退的 `models.yaml`）的当前状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsConfigFile {
    /// 实际生效的文件绝对路径（读写的就是它）。
    pub path: String,
    /// 文件是否存在（全新 agentDir 下为 false，写入时创建）。
    pub exists: bool,
    /// 文件全文（不存在时为空串）。
    pub text: String,
    /// 写入乐观锁用的内容哈希（详见 [`hash_text`]）。
    pub hash: String,
}

/// 当前生效的配置文件路径：`models.yml` 优先，其次 `models.yaml`（都不存在则默认 yml，写入时创建）。
pub fn models_path(agent_dir: &Path) -> PathBuf {
    let yml = agent_dir.join("models.yml");
    if yml.exists() {
        return yml;
    }
    let yaml = agent_dir.join("models.yaml");
    if yaml.exists() {
        return yaml;
    }
    yml
}

/// 内容哈希（FNV-1a 64 位，16 位十六进制）：乐观锁用。
/// 不是密码学哈希——只需「改一个字节就变」和「同内容稳定」，不落盘、不跨版本比对。
pub fn hash_text(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// 从 omp 的 stderr 里提取 models.yml 的加载错误（没有则 `None` = 通过）。
///
/// 实测两种形态（`my` 为文件名占位）：
/// ```text
/// Warning: models.yml validation failed — custom providers disabled
/// Failed to load config file models, Validate(models) error: Provider x: "baseUrl" is required …
/// ```
/// ```text
/// Failed to load config file models, Schema error:
///   - providers.x.models.0.cost.cacheRead: must be a number (was missing)
/// ```
/// 提取失败行 + 其后的连续缩进行（schema 明细列表），前面的 Warning 行不含诊断信息、丢弃。
pub fn parse_models_config_error(stderr: &str) -> Option<String> {
    let lines: Vec<&str> = stderr.lines().collect();
    let start = lines
        .iter()
        .position(|l| l.contains("Failed to load config file models"))?;
    let mut out: Vec<&str> = vec![lines[start].trim_end()];
    for l in &lines[start + 1..] {
        if l.trim().is_empty() || !(l.starts_with(' ') || l.starts_with('\t')) {
            break;
        }
        out.push(l.trim_end());
    }
    Some(out.join("\n"))
}

fn read_file(path: &Path) -> Result<(bool, String), String> {
    match std::fs::read_to_string(path) {
        Ok(t) => Ok((true, t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((false, String::new())),
        Err(e) => Err(format!("读取 {} 失败：{e}", path.display())),
    }
}

fn view(path: &Path, exists: bool, text: String) -> ModelsConfigFile {
    ModelsConfigFile {
        path: path.to_string_lossy().to_string(),
        exists,
        hash: hash_text(&text),
        text,
    }
}

/// 写入乐观锁：期望哈希与实际不符 = 文件被外部改过（用户手改 / 其它工具）。
pub fn check_hash(current_text: &str, expect: Option<&str>) -> Result<(), String> {
    match expect {
        Some(e) if hash_text(current_text) != e => Err(
            "配置文件在界面之外被修改过（可能你手改过 models.yml）——请先重新加载，再应用改动"
                .into(),
        ),
        _ => Ok(()),
    }
}

/// 预校验候选文本：写进临时 agentDir，跑一次 `omp models --json` 读 stderr。
///
/// 返回 `Ok(None)` = omp 接受该配置；`Ok(Some(msg))` = omp 拒绝（msg 是原始诊断）；
/// `Err` = 校验本身跑不起来（omp 缺失 / 超时）——调用方按 fail-closed 处理（拒绝写入）。
async fn validate_text(bin: &str, file_name: &str, text: &str) -> Result<Option<String>, String> {
    let nonce = format!(
        "{}-{}",
        std::process::id(),
        chrono::Local::now().format("%Y%m%d%H%M%S%3f")
    );
    let dir = std::env::temp_dir().join(format!("omp-inn-models-validate-{nonce}"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
    std::fs::write(dir.join(file_name), text).map_err(|e| format!("写入临时配置失败：{e}"))?;

    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(["models", "--json"])
        .current_dir(&dir)
        .env("PI_CODING_AGENT_DIR", &dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let out = tokio::time::timeout(VALIDATE_TIMEOUT, cmd.output()).await;
    // 临时目录里有 omp 生成的 models.db 等，一并清掉（失败不阻断——只是临时垃圾）。
    let _ = std::fs::remove_dir_all(&dir);

    match out {
        Ok(Ok(o)) => Ok(parse_models_config_error(&String::from_utf8_lossy(
            &o.stderr,
        ))),
        Ok(Err(e)) => Err(format!("校验配置失败（omp 启动不了）：{e}")),
        Err(_) => Err("校验配置超时".into()),
    }
}

/// 备份现有文件到 `backup_dir`（按名保留最近 [`BACKUPS_KEEP`] 份）；不存在则 `None`。
pub fn backup_file(path: &Path, backup_dir: &Path) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }
    std::fs::create_dir_all(backup_dir).map_err(|e| format!("创建备份目录失败：{e}"))?;
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("models");
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("yml");
    // 时间戳只到毫秒：同一毫秒内的两次备份会撞名（Linux CI 上实测被覆盖成一份）。
    // 撞名就往后加序号——「每次都留下一份」优先于名字好看；同一时间戳内序号递增，
    // prune_backups 的「字典序即时序」仍然成立。
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S%3f").to_string();
    let mut dst = backup_dir.join(format!("{stem}-{stamp}.{ext}"));
    let mut seq = 1;
    while dst.exists() {
        dst = backup_dir.join(format!("{stem}-{stamp}-{seq}.{ext}"));
        seq += 1;
    }
    std::fs::copy(path, &dst).map_err(|e| format!("备份失败：{e}"))?;
    prune_backups(backup_dir, stem, ext, BACKUPS_KEEP);
    Ok(Some(dst))
}

/// 清掉超出保留数的旧备份（文件名形如 `<stem>-<时间戳>.<ext>`，字典序即时序）。
fn prune_backups(dir: &Path, stem: &str, ext: &str, keep: usize) {
    let prefix = format!("{stem}-");
    let suffix = format!(".{ext}");
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.starts_with(&prefix) && n.ends_with(&suffix))
        .collect();
    names.sort();
    for n in names.iter().take(names.len().saturating_sub(keep)) {
        let _ = std::fs::remove_file(dir.join(n));
    }
}

/// 原子写：同目录临时文件 + rename（避免半截文件被 omp 读到）。
/// `models_config` 与 `title_prompt` 共用。
pub(crate) fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!("{name}.tmp"));
    std::fs::write(&tmp, text).map_err(|e| format!("写入临时文件失败：{e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换配置失败：{e}"))
}

// ---------- Tauri 命令 ----------

/// 读当前生效的 models 配置（`models.yml` / `models.yaml`）。
#[tauri::command]
pub async fn read_models_config(state: State<'_, AppState>) -> Result<ModelsConfigFile, CmdError> {
    let agent = state.agent_dir.lock().await.clone();
    let path = models_path(&agent);
    let (exists, text) = read_file(&path).map_err(|e| cmd_err("MODELS_READ_FAILED", e, None))?;
    Ok(view(&path, exists, text))
}

/// 写入 models 配置：hash 乐观锁 → 预校验（临时 agentDir 问 omp）→ 备份 → 原子写 → 回读。
///
/// 预校验失败（omp 不接受候选文本）时**不落盘**并返回 omp 的原始诊断——坏配置会让
/// 整份文件的自定义 provider 失效，宁可让用户先改对再保存。
#[tauri::command]
pub async fn write_models_config(
    state: State<'_, AppState>,
    text: String,
    expect_hash: Option<String>,
) -> Result<ModelsConfigFile, CmdError> {
    let _guard = state.models_edit.lock().await;
    if text.len() > MAX_TEXT_BYTES {
        return Err(cmd_err(
            "MODELS_TOO_LARGE",
            format!("配置过大（{} 字节，上限 {MAX_TEXT_BYTES}）", text.len()),
            None,
        ));
    }
    let bin = crate::providers::omp_bin(&state)?;
    let agent = state.agent_dir.lock().await.clone();
    write_config(
        &bin,
        &agent,
        state.overlay_path.parent(),
        &text,
        expect_hash.as_deref(),
    )
    .await
}

/// 文件事务与 Tauri 状态解耦，便于用隔离目录验证预校验期间的外部编辑。
async fn write_config(
    bin: &str,
    agent: &Path,
    backup_root: Option<&Path>,
    text: &str,
    expect_hash: Option<&str>,
) -> Result<ModelsConfigFile, CmdError> {
    let path = models_path(agent);
    let (_, current) = read_file(&path).map_err(|e| cmd_err("MODELS_READ_FAILED", e, None))?;
    if let Err(e) = check_hash(&current, expect_hash) {
        return Err(cmd_err("MODELS_CONFLICT", e, Some("重新加载后再试".into())));
    }
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "models.yml".into());
    match validate_text(bin, &file_name, text).await {
        Ok(None) => {}
        Ok(Some(msg)) => {
            return Err(cmd_err(
                "MODELS_INVALID",
                format!("omp 拒绝这份配置（未写入）：\n{msg}"),
                Some("修正标出的错误后重新保存".into()),
            ))
        }
        Err(e) => {
            return Err(cmd_err(
                "MODELS_VALIDATE_FAILED",
                e,
                Some("稍后重试".into()),
            ))
        }
    }
    // 预校验可能持续 60 秒；期间外部编辑或文件优先级切换也必须拒绝。
    let (_, latest) = read_file(&path).map_err(|e| cmd_err("MODELS_READ_FAILED", e, None))?;
    if models_path(agent) != path || latest != current {
        return Err(cmd_err(
            "MODELS_CONFLICT",
            "配置文件在预校验期间被修改过（未写入）".into(),
            Some("重新加载后再试".into()),
        ));
    }
    if let Some(dir) = backup_root {
        let _ = backup_file(&path, &dir.join("backups"));
    }
    write_atomic(&path, text).map_err(|e| cmd_err("MODELS_WRITE_FAILED", e, None))?;
    let (exists, written) = read_file(&path).map_err(|e| cmd_err("MODELS_READ_FAILED", e, None))?;
    Ok(view(&path, exists, written))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("omp-inn-mc-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ---------- 路径选择 ----------

    #[test]
    fn models_path_prefers_yml() {
        let dir = tmp("prefer-yml");
        std::fs::write(dir.join("models.yml"), "providers: {}").unwrap();
        std::fs::write(dir.join("models.yaml"), "providers: {}\n").unwrap();
        assert_eq!(models_path(&dir), dir.join("models.yml"));
    }

    #[test]
    fn models_path_falls_back_to_yaml_when_yml_absent() {
        let dir = tmp("fallback-yaml");
        std::fs::write(dir.join("models.yaml"), "providers: {}").unwrap();
        assert_eq!(models_path(&dir), dir.join("models.yaml"));
    }

    #[test]
    fn models_path_defaults_to_yml_when_missing() {
        let dir = tmp("missing");
        assert_eq!(models_path(&dir), dir.join("models.yml"));
    }

    // ---------- 哈希与乐观锁 ----------

    #[test]
    fn hash_is_stable_and_sensitive() {
        assert_eq!(hash_text("providers: {}"), hash_text("providers: {}"));
        assert_ne!(hash_text("providers: {}"), hash_text("providers: { }"));
        assert_eq!(hash_text(""), "cbf29ce484222325"); // FNV-1a 64 空串基准向量
    }

    #[test]
    fn check_hash_accepts_none_and_match_rejects_mismatch() {
        assert!(check_hash("abc", None).is_ok());
        assert!(check_hash("abc", Some(&hash_text("abc"))).is_ok());
        assert!(check_hash("abc", Some(&hash_text("abd"))).is_err());
    }

    // ---------- omp stderr 解析 ----------

    #[test]
    fn error_extracted_from_validate_output() {
        let stderr = "Warning: models.yml validation failed — custom providers disabled\n\
                      Failed to load config file models, Validate(models) error: Provider bad-probe: \"baseUrl\" is required when defining custom models.\n";
        let msg = parse_models_config_error(stderr).unwrap();
        assert!(msg.contains("baseUrl"));
        assert!(!msg.contains("Warning"));
    }

    #[test]
    fn error_extracted_with_schema_detail_lines() {
        let stderr = "Warning: models.yml validation failed — custom providers disabled\n\
                      Failed to load config file models, Schema error:\n  \
                      - providers.p.models.0.cost.cacheRead: must be a number (was missing)\n  \
                      - providers.p.models.0.cost.cacheWrite: must be a number (was missing)\n";
        let msg = parse_models_config_error(stderr).unwrap();
        assert!(msg.contains("Schema error:"));
        assert!(msg.contains("cost.cacheRead"));
        assert!(msg.contains("cost.cacheWrite"));
    }

    #[test]
    fn unrelated_stderr_yields_none() {
        assert!(parse_models_config_error("").is_none());
        assert!(parse_models_config_error("Warning: something else entirely\n").is_none());
    }

    // ---------- 备份 ----------

    #[test]
    fn backup_copies_and_prunes_to_keep_limit() {
        let dir = tmp("backup");
        let file = dir.join("models.yml");
        let backups = dir.join("backups");
        std::fs::write(&file, "providers: {}").unwrap();
        // 预置 12 份旧备份 + 真实备份一次 = 13 → 应裁剪到 BACKUPS_KEEP
        std::fs::create_dir_all(&backups).unwrap();
        for i in 0..12 {
            std::fs::write(
                backups.join(format!("models-2025010{i}-000000000.{i:02}.yml")),
                "x",
            )
            .unwrap();
        }
        let dst = backup_file(&file, &backups).unwrap().unwrap();
        assert!(dst.exists());
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "providers: {}");
        let count = std::fs::read_dir(&backups).unwrap().count();
        assert_eq!(count, BACKUPS_KEEP);
        // 保留的是「名字时序」最新的——最早的那份必须已被删
        assert!(!backups.join("models-20250100-000000000.00.yml").exists());
    }

    #[test]
    fn backup_keeps_every_copy_within_one_millisecond() {
        let dir = tmp("backup-same-ms");
        let file = dir.join("models.yml");
        let backups = dir.join("backups");
        std::fs::write(&file, "providers: {}").unwrap();
        // 紧挨着的两次备份常常落在同一毫秒：早期实现会撞名互相覆盖，只剩一份（CI 上暴露）
        let first = backup_file(&file, &backups).unwrap().unwrap();
        let second = backup_file(&file, &backups).unwrap().unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read_dir(&backups).unwrap().count(), 2);
    }

    #[test]
    fn backup_returns_none_for_missing_file() {
        let dir = tmp("backup-missing");
        assert!(backup_file(&dir.join("nope.yml"), &dir.join("backups"))
            .unwrap()
            .is_none());
    }

    // ---------- 原子写 ----------

    #[test]
    fn write_atomic_replaces_content_without_leftover_tmp() {
        let dir = tmp("atomic");
        let file = dir.join("models.yml");
        std::fs::write(&file, "old").unwrap();
        write_atomic(&file, "new").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
        assert!(!dir.join("models.yml.tmp").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn validation_cannot_overwrite_external_edits_or_priority_switches() {
        use std::os::unix::fs::PermissionsExt;
        for switch_path in [false, true] {
            let dir = tmp(if switch_path {
                "priority-conflict"
            } else {
                "validation-conflict"
            });
            let original = dir.join(if switch_path {
                "models.yaml"
            } else {
                "models.yml"
            });
            let current = "providers: {}\n";
            std::fs::write(&original, current).unwrap();
            let bin = dir.join("omp-probe");
            // 假 omp 在预校验阶段模拟外部写入，不读取用户配置或发起网络请求。
            std::fs::write(&bin, "#!/bin/sh\nprintf 'providers: {external: {}}\\n' > \"$(dirname \"$0\")/models.yml\"\n").unwrap();
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
            let result = write_config(
                bin.to_str().unwrap(),
                &dir,
                Some(&dir),
                "providers: {candidate: {}}\n",
                Some(&hash_text(current)),
            )
            .await;
            assert_eq!(result.unwrap_err().code, "MODELS_CONFLICT");
            assert_eq!(
                std::fs::read_to_string(dir.join("models.yml")).unwrap(),
                "providers: {external: {}}\n"
            );
            if switch_path {
                assert_eq!(std::fs::read_to_string(original).unwrap(), current);
            }
            assert!(!dir.join("backups").exists());
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    // ---------- 预校验（真实 omp，慢：cargo test -- --ignored） ----------

    /// 预校验必须真的让 omp 说话：好配置放行、坏配置与空文件都被识别出来。
    #[tokio::test]
    #[ignore]
    async fn real_omp_validation_gates_bad_configs() {
        let good = "providers:\n  probe:\n    baseUrl: http://127.0.0.1:9999/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: m\n        name: M\n";
        assert!(
            validate_text("omp", "models.yml", good)
                .await
                .unwrap()
                .is_none(),
            "合法配置应放行"
        );

        let bad = "providers:\n  probe:\n    models:\n      - id: broken\n";
        let err = validate_text("omp", "models.yml", bad)
            .await
            .unwrap()
            .unwrap();
        assert!(err.contains("baseUrl"), "缺 baseUrl 应被 omp 拒绝：{err}");

        let empty = "";
        assert!(
            validate_text("omp", "models.yml", empty)
                .await
                .unwrap()
                .is_some(),
            "空文件非法"
        );
    }
}
