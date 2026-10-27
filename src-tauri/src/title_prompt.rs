//! 会话标题语言（`<agentDir>/TITLE_SYSTEM.md`）：把壳的界面语言同步成 omp 的**标题生成 prompt**。
//!
//! **上游事实（omp 18.2.10：源码 + 官方文档核对 + 本机实测）**
//!
//! - omp 的自动会话标题（含 replan 刷新）可以用 `TITLE_SYSTEM.md` 覆盖生成 prompt：
//!   **项目级 `<cwd>/.omp/TITLE_SYSTEM.md` 优先，其次用户级 `<agentDir>/TITLE_SYSTEM.md`**
//!   （`packages/coding-agent/src/system-prompt.ts` 的 `discoverTitleSystemPromptFile`；
//!   `docs/system-prompt-customization.md` 的 "Customize automatic session titles"）。
//! - **上游没有 CLI / 设置项能改标题 prompt**：`omp --help` 只有 `--no-title`（关自动标题），
//!   `omp config list` 只有 `title.refreshOnReplan`；`SYSTEM.md` / `APPEND_SYSTEM.md` 明确
//!   不影响标题生成——写用户级 `TITLE_SYSTEM.md` 是壳侧唯一的路径。
//! - 内置标题 prompt（`prompts/system/title-system.md`）只说 `Write a ~5 word title …`，
//!   **不指定语言**；壳侧按界面语言把「用简体中文 / 用英文」写进同一文件。
//! - 文件是 **plain text**（不是 Handlebars），整份作为标题请求的 system prompt，
//!   随后 omp 自己追加 `<title>` 标记指令——所以这里只写「写什么语言的标题」。
//! - 标题输出仍有上游归一契约（`tiny/text.ts`）：只取首行、去引号与 `<title>` 标记，
//!   超过 80 字符或 12 个词整体拒绝（会话留名给下一次尝试）——两端文本都远小于上限。
//! - 生效时机：omp 在**会话启动**与 move / 重启时重读该文件（`interactive-mode.ts` 的
//!   `refreshTitleSystemPrompt`）——所以语言切换对**新开的终端**生效，已开的会话保持
//!   原语言（与 `cycleOrder` 同一口径，壳侧不代偿）。
//!
//! **谁的文件归谁**：只认「不存在」或「内容恰好是壳的 zh / en 两种文本之一」的文件
//! （见 [`sync_title_prompt_in`]）——用户自己写过的一律跳过，永不覆盖。

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::commands::{cmd_err, AppState, CmdError};
use crate::models_config::write_atomic;

/// 壳写入的简体中文标题 prompt（`TITLE_SYSTEM.md` 全文）。
pub const TITLE_PROMPT_ZH: &str = "\
写一个约 5 个词的简体中文标题，只描述下一条用户消息里的任务。
- 只输出标题本身，包在 <title> 标签中。
- 如果这条消息只是问候，输出 `<title/>`。
";

/// 壳写入的英文标题 prompt（与内置口径一致，只补上「用英文」）。
pub const TITLE_PROMPT_EN: &str = "\
Write a ~5 word title in English using only the task described in the next user message.
- You MUST ONLY answer with the title, inside the <title> tag.
- If the message is only a greeting, answer `<title/>`.
";

/// 语言档（壳的 `Locale` 归一而来：`zh-CN` → `zh`）→ 标题 prompt 文本；未知档 `None`。
pub fn prompt_for(lang: &str) -> Option<&'static str> {
    match lang {
        "zh" => Some(TITLE_PROMPT_ZH),
        "en" => Some(TITLE_PROMPT_EN),
        _ => None,
    }
}

/// 用户级标题 prompt 的路径：`<agentDir>/TITLE_SYSTEM.md`（项目级同名文件优先级更高，壳侧不碰）。
pub fn title_prompt_path(agent_dir: &Path) -> PathBuf {
    agent_dir.join("TITLE_SYSTEM.md")
}

/// 同步结果：`written` 已写入 / `unchanged` 内容一致未写 / `skipped` 用户自管（不碰）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TitlePromptAction {
    Written,
    Unchanged,
    Skipped,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TitlePromptOutcome {
    pub path: String,
    pub action: TitlePromptAction,
}

/// 同步实现（与 Tauri 状态解耦，便于用临时目录做真实行为测试）。
///
/// 判定：文件不存在 → 写；内容与目标文本一致 → 不写；内容是壳的另一语言或用户自写
/// （既不是 zh 也不是 en 文本）→ 前者重写、后者跳过。
pub fn sync_title_prompt_in(agent_dir: &Path, lang: &str) -> Result<TitlePromptOutcome, String> {
    let text = prompt_for(lang).ok_or_else(|| format!("未知标题语言档：{lang}"))?;
    let path = title_prompt_path(agent_dir);
    let existing = match std::fs::read_to_string(&path) {
        Ok(cur) => Some(cur),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("读取 {} 失败：{e}", path.display())),
    };
    let action = match existing {
        Some(cur) if cur == text => TitlePromptAction::Unchanged,
        // 既不是壳的中文文本、也不是壳的英文文本 = 用户自写的：跳过，永不覆盖。
        Some(cur) if cur != TITLE_PROMPT_ZH && cur != TITLE_PROMPT_EN => TitlePromptAction::Skipped,
        _ => {
            write_atomic(&path, text)?;
            TitlePromptAction::Written
        }
    };
    Ok(TitlePromptOutcome {
        path: path.to_string_lossy().to_string(),
        action,
    })
}

/// 把壳的界面语言同步成 omp 的标题生成 prompt（`<agentDir>/TITLE_SYSTEM.md`）。
#[tauri::command]
pub async fn sync_title_prompt(
    state: State<'_, AppState>,
    lang: String,
) -> Result<TitlePromptOutcome, CmdError> {
    let agent = state.agent_dir.lock().await.clone();
    sync_title_prompt_in(&agent, &lang).map_err(|e| cmd_err("TITLE_PROMPT_FAILED", e, None))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omp-inn-tp-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn writes_zh_when_missing_then_switches_to_en() {
        let dir = tmp("switch");
        let path = title_prompt_path(&dir);
        let first = sync_title_prompt_in(&dir, "zh").unwrap();
        assert_eq!(first.action, TitlePromptAction::Written);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), TITLE_PROMPT_ZH);
        // 同一语言再同步：内容一致，不再写文件
        let again = sync_title_prompt_in(&dir, "zh").unwrap();
        assert_eq!(again.action, TitlePromptAction::Unchanged);
        // 换英文：壳管理的文件被重写
        let switched = sync_title_prompt_in(&dir, "en").unwrap();
        assert_eq!(switched.action, TitlePromptAction::Written);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), TITLE_PROMPT_EN);
        assert!(!dir.join("TITLE_SYSTEM.md.tmp").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn leaves_user_authored_file_alone() {
        let dir = tmp("user-file");
        let path = title_prompt_path(&dir);
        std::fs::write(&path, "Always answer `<title>chore: x</title>`.\n").unwrap();
        let out = sync_title_prompt_in(&dir, "zh").unwrap();
        assert_eq!(out.action, TitlePromptAction::Skipped);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "Always answer `<title>chore: x</title>`.\n"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn creates_missing_agent_dir_and_rejects_unknown_lang() {
        let dir = tmp("nested").join("agent");
        let out = sync_title_prompt_in(&dir, "en").unwrap();
        assert_eq!(out.action, TitlePromptAction::Written);
        assert!(title_prompt_path(&dir).exists());
        let err = sync_title_prompt_in(&dir, "ja").unwrap_err();
        assert!(err.contains("ja"), "未知语言档要说明是哪个：{err}");
        std::fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }
}
