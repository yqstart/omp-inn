//! 会话图片：omp blob 读取、复制到系统剪贴板、另存为本地文件。
//!
//! omp 写 jsonl 时会把图片块的 base64 外置成 `blob:sha256:<hash>`（实体在
//! `<agentDir>/blobs/<hash>`），而实时帧仍是 base64——历史回放与预览都要能把
//! 引用还原成图片字节。这里只做「读 / 复制 / 保存」，不碰会话文件本身。

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};

use crate::commands::{cmd_err, AppState, CmdError, ImageAttachment, IMAGE_MAX_BYTES};
use crate::runtime::{b64decode, b64encode};

/// blob 名 = 64 位小写十六进制 sha256。**只认这个形状**：拼路径前先校验，
/// 任何 `/`、`..`、大写或短哈希都不会走到文件系统。
fn hash_ok(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn mime_of_ext(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

/// 扩展名（供另存为与 blob 兄弟文件推断）：mime 是唯一真值，未知返回 `None`。
fn ext_of_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

/// 文件头嗅探：blob 的兄弟文件万一缺了（旧版本 / 手工清理），仍能给出 mime。
fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// blob 的 mime：优先看同目录带扩展名的硬链接（omp 会写 `<hash>.webp` 这类副本），
/// 其次读文件头。两者都没有就当损坏。
fn blob_mime(agent: &Path, hash: &str, bytes: &[u8]) -> Option<&'static str> {
    let dir = agent.join("blobs");
    for ext in ["png", "jpg", "jpeg", "webp", "gif"] {
        if dir.join(format!("{hash}.{ext}")).is_file() {
            if let Some(m) = mime_of_ext(ext) {
                return Some(m);
            }
        }
    }
    sniff_mime(bytes)
}

fn decode_attachment(data_base64: &str, what: &str) -> Result<Vec<u8>, CmdError> {
    let bytes = b64decode(data_base64)
        .ok_or_else(|| cmd_err("BAD_IMAGE", format!("{what}：图片数据损坏"), Some("重新打开会话或重发这张图".into())))?;
    if bytes.is_empty() {
        return Err(cmd_err("BAD_IMAGE", format!("{what}：图片内容为空"), None));
    }
    if bytes.len() > IMAGE_MAX_BYTES {
        return Err(cmd_err(
            "TOO_LARGE",
            format!("{what}：超过 10MB"),
            Some("图片过大，无法在应用内处理".into()),
        ));
    }
    Ok(bytes)
}

/// 读一张 omp blob（历史会话里的图片引用）为附件。
///
/// 只读 `<agentDir>/blobs/<hash>`：hash 先过形状校验，路径里不可能出现目录跳转。
/// 大小上限与附件一致（10MB）——历史回放不该把几十 MB 的图塞进 WebView。
#[tauri::command]
pub async fn read_blob_image(state: State<'_, AppState>, hash: String) -> Result<ImageAttachment, CmdError> {
    let hash = hash.trim().to_string();
    if !hash_ok(&hash) {
        return Err(cmd_err("BAD_HASH", "图片引用不合法".into(), None));
    }
    let agent = state.agent_dir.lock().await.clone();
    let path = agent.join("blobs").join(&hash);
    let meta = std::fs::metadata(&path).map_err(|_| {
        cmd_err(
            "NOT_FOUND",
            "图片已被清理，无法显示".into(),
            Some("omp 的图片缓存已被回收（`omp gc --blobs`）".into()),
        )
    })?;
    if meta.len() as usize > IMAGE_MAX_BYTES {
        return Err(cmd_err("TOO_LARGE", "图片超过 10MB，无法预览".into(), None));
    }
    let bytes = std::fs::read(&path)
        .map_err(|e| cmd_err("IO", format!("读取图片缓存失败：{e}"), Some("稍后重试".into())))?;
    let mime = blob_mime(&agent, &hash, &bytes)
        .ok_or_else(|| cmd_err("BAD_TYPE", "无法识别图片格式".into(), None))?;
    let ext = ext_of_mime(mime).unwrap_or("png");
    Ok(ImageAttachment {
        data_base64: b64encode(&bytes),
        mime_type: mime.to_string(),
        name: Some(format!("image.{ext}")),
        bytes: Some(bytes.len()),
    })
}

/// 把一张图写进系统剪贴板。
///
/// macOS 的 NSPasteboard 与 Windows 的 OLE 都优先在主线程上操作：这里切到主线程执行
/// （图片解码本身留在当前线程，只有剪贴板写入这一段在主线程），避免平台差异。
#[tauri::command]
pub async fn copy_image(app: AppHandle, data_base64: String) -> Result<(), CmdError> {
    let bytes = decode_attachment(&data_base64, "复制图片")?;
    let rgba = image::load_from_memory(&bytes)
        .map_err(|e| cmd_err("BAD_IMAGE", format!("图片解码失败：{e}"), None))?
        .to_rgba8();
    let (w, h) = rgba.dimensions();
    let pixels = rgba.into_raw();
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    app.run_on_main_thread(move || {
        let res = (|| {
            let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            cb.set_image(arboard::ImageData {
                width: w as usize,
                height: h as usize,
                bytes: Cow::Owned(pixels),
            })
            .map_err(|e| e.to_string())
        })();
        let _ = tx.send(res);
    })
    .map_err(|e| cmd_err("CLIPBOARD", format!("无法访问系统剪贴板：{e}"), None))?;
    rx.await
        .map_err(|_| cmd_err("CLIPBOARD", "复制已取消".into(), None))?
        .map_err(|e| cmd_err("CLIPBOARD", format!("写入剪贴板失败：{e}"), Some("确认系统允许本应用访问剪贴板".into())))
}

/// 把一张图写到本地文件（路径来自系统「另存为」对话框）。
///
/// 只接受图片扩展名：路径由用户选，但写之前仍校验一次，避免误写到任意文件类型。
#[tauri::command]
pub async fn save_image_file(path: String, data_base64: String) -> Result<(), CmdError> {
    let bytes = decode_attachment(&data_base64, "保存图片")?;
    let p = PathBuf::from(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if mime_of_ext(&ext).is_none() {
        return Err(cmd_err(
            "BAD_TYPE",
            "保存文件名需要 PNG / JPEG / WebP / GIF 扩展名".into(),
            Some("在文件名末尾加上 .png / .jpg / .webp / .gif".into()),
        ));
    }
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(cmd_err("NOT_FOUND", format!("目录不存在：{}", parent.display()), None));
        }
    }
    std::fs::write(&p, &bytes).map_err(|e| cmd_err("IO", format!("保存失败：{e}"), None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_shape_is_strict() {
        assert!(hash_ok(&"a".repeat(64)));
        assert!(hash_ok("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"));
        assert!(!hash_ok(&"A".repeat(64)));
        assert!(!hash_ok(&("../".repeat(21) + "x")));
        assert!(!hash_ok(&"a".repeat(63)));
        assert!(!hash_ok(&"a".repeat(65)));
    }

    #[test]
    fn sniffs_the_four_supported_formats() {
        assert_eq!(sniff_mime(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(sniff_mime(b"\xff\xd8\xff\xe0...."), Some("image/jpeg"));
        assert_eq!(sniff_mime(b"GIF89a...."), Some("image/gif"));
        assert_eq!(sniff_mime(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_mime(b"not an image"), None);
    }

    #[test]
    fn ext_and_mime_round_trip() {
        for mime in ["image/png", "image/jpeg", "image/webp", "image/gif"] {
            let ext = ext_of_mime(mime).expect("known mime");
            assert_eq!(mime_of_ext(ext), Some(mime));
        }
        assert_eq!(mime_of_ext("bmp"), None);
    }
}
