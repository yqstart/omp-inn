//! 远程 RPC 白名单。
//!
//! **不做通用 Tauri 桥**：每个命令单独反序列化参数、单独校验、单独调用现有
//! `commands::*` 函数。手机端永远碰不到文件 / 终端 / 设置 / git / 插件这些面。
//!
//! 会话 id 一律要求完整 uuid（36 字符）：项目里已经踩过「uuid 前 8 位同一分钟相同」
//! 的坑，远程入口再退回前缀就会读错历史 / 删错文件。

use serde::Deserialize;
use serde_json::Value;
use tauri::Manager;

use super::server::Ctx;
use crate::commands::{cmd_err, CmdError, ImageAttachment};

pub const MAX_MESSAGE_CHARS: usize = 64 * 1024;
pub const MAX_COMMAND_CHARS: usize = 2 * 1024;
pub const MAX_IMAGES: usize = 4;
pub const MAX_IMAGE_B64: usize = 14 * 1024 * 1024;
pub const MAX_ANSWERS_BYTES: usize = 128 * 1024;

pub fn is_full_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    for (i, c) in b.iter().enumerate() {
        let ok = match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit() && !c.is_ascii_uppercase(),
        };
        if !ok {
            return false;
        }
    }
    true
}

fn bad(msg: &str) -> CmdError {
    cmd_err("BAD_ARG", msg.to_string(), None)
}

fn forbidden(msg: &str) -> CmdError {
    cmd_err("REMOTE_FORBIDDEN", msg.to_string(), None)
}

fn session_id(id: &str) -> Result<String, CmdError> {
    if is_full_uuid(id) {
        Ok(id.to_string())
    } else {
        Err(bad("会话 id 必须是完整 uuid"))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdArgs {
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HashArgs {
    hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SendArgs {
    id: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    images: Option<Vec<ImageAttachment>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SlashArgs {
    id: String,
    command: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApproveArgs {
    id: String,
    ui_id: String,
    decision: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RespondArgs {
    id: String,
    ui_id: String,
    kind: String,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    confirmed: Option<bool>,
    #[serde(default)]
    answers: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompactArgs {
    id: String,
    #[serde(default)]
    custom_instructions: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateArgs {
    cwd: String,
}

fn check_images(images: &Option<Vec<ImageAttachment>>) -> Result<(), CmdError> {
    let Some(list) = images else { return Ok(()) };
    if list.len() > MAX_IMAGES {
        return Err(bad("图片最多 4 张"));
    }
    for img in list {
        if !img.mime_type.starts_with("image/") {
            return Err(bad("只支持图片附件"));
        }
        if img.data_base64.len() > MAX_IMAGE_B64 {
            return Err(bad("单张图片过大"));
        }
        if img.name.as_deref().is_some_and(|n| n.chars().count() > 200) {
            return Err(bad("图片名过长"));
        }
    }
    Ok(())
}

fn json<T: serde::Serialize>(v: T) -> Result<Value, CmdError> {
    serde_json::to_value(v).map_err(|e| cmd_err("SERIALIZE", format!("序列化失败：{e}"), None))
}

/// 新建会话的 cwd 必须是已登记项目根或其子目录（按路径组件边界，不做字符串前缀）。
async fn check_create_cwd(ctx: &Ctx, cwd: &str) -> Result<String, CmdError> {
    if cwd.chars().count() > 4096 {
        return Err(bad("目录路径过长"));
    }
    let target = std::fs::canonicalize(cwd).map_err(|_| cmd_err("DIR_MISSING", "目录不存在".into(), None))?;
    if !target.is_dir() {
        return Err(cmd_err("NOT_DIR", "所选路径不是目录".into(), None));
    }
    let state = ctx.app.state::<crate::commands::AppState>();
    let projects = crate::commands::list_projects(state).await?;
    for p in projects {
        let Ok(root) = std::fs::canonicalize(&p.path) else { continue };
        if target == root || target.starts_with(&root) {
            return Ok(target.to_string_lossy().to_string());
        }
    }
    Err(forbidden("只能在本应用已登记的项目目录里新建会话"))
}

pub async fn dispatch(ctx: &Ctx, cmd: &str, args: Value) -> Result<Value, CmdError> {
    let state = ctx.app.state::<crate::commands::AppState>();
    match cmd {
        "get_health" => {
            let out = crate::commands::get_health(ctx.app.clone(), state).await?;
            json(out)
        }
        "list_projects" => {
            let out = crate::commands::list_projects(state).await?;
            json(out)
        }
        "open_session" => {
            let a: IdArgs = serde_json::from_value(args).map_err(|e| bad(&format!("参数不合法：{e}")))?;
            let id = session_id(&a.id)?;
            let out = crate::commands::open_session(ctx.app.clone(), state, id).await?;
            json(out)
        }
        "get_history" => {
            let a: IdArgs = serde_json::from_value(args).map_err(|e| bad(&format!("参数不合法：{e}")))?;
            let id = session_id(&a.id)?;
            crate::commands::get_history(state, id).await
        }
        // 历史回放里的图片引用：只读 omp 的 `blobs/<sha256>`（hash 形状由后端校验），
        // 手机端也要能看到会话图片；写剪贴板 / 另存为不在远程白名单里。
        "read_blob_image" => {
            let a: HashArgs = serde_json::from_value(args).map_err(|e| bad(&format!("参数不合法：{e}")))?;
            let out = crate::images::read_blob_image(state, a.hash).await?;
            json(out)
        }
        "get_session_runtime" => {
            let a: IdArgs = serde_json::from_value(args).map_err(|e| bad(&format!("参数不合法：{e}")))?;
            let id = session_id(&a.id)?;
            let out = crate::commands::get_session_runtime(state, id).await?;
            json(out)
        }
        "get_subagents" => {
            let a: IdArgs = serde_json::from_value(args).map_err(|e| bad(&format!("参数不合法：{e}")))?;
            let id = session_id(&a.id)?;
            crate::commands::get_subagents(ctx.app.clone(), state, id).await
        }
        "send_message" | "steer_message" | "follow_up_message" => {
            let a: SendArgs = serde_json::from_value(args).map_err(|e| bad(&format!("参数不合法：{e}")))?;
            let id = session_id(&a.id)?;
            if a.message.chars().count() > MAX_MESSAGE_CHARS {
                return Err(bad("消息过长"));
            }
            check_images(&a.images)?;
            if a.message.trim().is_empty() && a.images.as_ref().map_or(true, |v| v.is_empty()) {
                return Err(bad("消息不能为空"));
            }
            match cmd {
                "send_message" => crate::commands::send_message(ctx.app.clone(), state, id, a.message, a.images).await?,
                "steer_message" => crate::commands::steer_message(ctx.app.clone(), state, id, a.message, a.images).await?,
                _ => crate::commands::follow_up_message(ctx.app.clone(), state, id, a.message, a.images).await?,
            }
            Ok(Value::Null)
        }
        "run_slash" => {
            let a: SlashArgs = serde_json::from_value(args).map_err(|e| bad(&format!("参数不合法：{e}")))?;
            let id = session_id(&a.id)?;
            if a.command.chars().count() > MAX_COMMAND_CHARS {
                return Err(bad("命令过长"));
            }
            crate::commands::run_slash(ctx.app.clone(), state, id, a.command).await?;
            Ok(Value::Null)
        }
        "stop_session" => {
            let a: IdArgs = serde_json::from_value(args).map_err(|e| bad(&format!("参数不合法：{e}")))?;
            let id = session_id(&a.id)?;
            crate::commands::stop_session(ctx.app.clone(), state, id).await?;
            Ok(Value::Null)
        }
        "compact_session" => {
            let a: CompactArgs = serde_json::from_value(args).map_err(|e| bad(&format!("参数不合法：{e}")))?;
            let id = session_id(&a.id)?;
            crate::commands::compact_session(ctx.app.clone(), state, id, a.custom_instructions).await?;
            Ok(Value::Null)
        }
        "approve" => {
            let a: ApproveArgs = serde_json::from_value(args).map_err(|e| bad(&format!("参数不合法：{e}")))?;
            let id = session_id(&a.id)?;
            if a.decision == "always" {
                return Err(forbidden("手机端不支持「总是允许」，请在电脑上操作"));
            }
            if a.decision != "once" && a.decision != "deny" {
                return Err(bad("审批 decision 只能是 once / deny"));
            }
            if a.ui_id.is_empty() || a.ui_id.chars().count() > 200 {
                return Err(bad("审批 id 不合法"));
            }
            crate::commands::approve(ctx.app.clone(), state, id, a.ui_id, a.decision).await?;
            Ok(Value::Null)
        }
        "respond_ui" => {
            let a: RespondArgs = serde_json::from_value(args).map_err(|e| bad(&format!("参数不合法：{e}")))?;
            let id = session_id(&a.id)?;
            if a.ui_id.is_empty() || a.ui_id.chars().count() > 200 {
                return Err(bad("UI 请求 id 不合法"));
            }
            if !matches!(a.kind.as_str(), "value" | "confirm" | "cancel" | "answers") {
                return Err(bad("UI 回包类型非法"));
            }
            if let Some(v) = &a.value {
                if v.chars().count() > MAX_MESSAGE_CHARS {
                    return Err(bad("回包内容过长"));
                }
            }
            if let Some(v) = &a.answers {
                if serde_json::to_string(v).map(|s| s.len()).unwrap_or(0) > MAX_ANSWERS_BYTES {
                    return Err(bad("回答内容过大"));
                }
            }
            crate::commands::respond_ui(ctx.app.clone(), state, id, a.ui_id, a.kind, a.value, a.confirmed, a.answers).await?;
            Ok(Value::Null)
        }
        "create_session" => {
            let a: CreateArgs = serde_json::from_value(args).map_err(|e| bad(&format!("参数不合法：{e}")))?;
            let cwd = check_create_cwd(ctx, &a.cwd).await?;
            let out = crate::commands::create_session_in(&ctx.app, &state, cwd).await?;
            json(out)
        }
        _ => Err(forbidden(&format!("命令不在远程白名单里：{cmd}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_requires_complete_identity() {
        assert!(is_full_uuid("019a0c1e-7f00-7000-8000-000000000001"));
        assert!(!is_full_uuid("019a0c1e"));
        assert!(!is_full_uuid("019a0c1e-7f00-7000-8000-00000000000"));
        assert!(!is_full_uuid("../019a0c1e-7f00-7000-8000-000000000001"));
        assert!(!is_full_uuid("019A0C1E-7F00-7000-8000-000000000001"));
    }

    #[test]
    fn image_limits() {
        let img = ImageAttachment {
            data_base64: "a".into(),
            mime_type: "image/png".into(),
            name: Some("a.png".into()),
            bytes: Some(1),
        };
        assert!(check_images(&Some(vec![img.clone()])).is_ok());
        assert!(check_images(&Some(vec![img.clone(); MAX_IMAGES + 1])).is_err());
        let mut bad = ImageAttachment { mime_type: "text/plain".into(), ..img };
        assert!(check_images(&Some(vec![bad.clone()])).is_err());
        bad.mime_type = "image/png".into();
        bad.data_base64 = "a".repeat(MAX_IMAGE_B64 + 1);
        assert!(check_images(&Some(vec![bad])).is_err());
    }
}
