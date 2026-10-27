use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// agentDir 解析优先级：PI_CODING_AGENT_DIR > `omp config path` 末行 > ~/.omp/agent
pub fn resolve_agent_dir(config_path_out: Option<String>) -> PathBuf {
    if let Ok(v) = std::env::var("PI_CODING_AGENT_DIR") {
        let v = v.trim().to_string();
        if !v.is_empty() {
            return PathBuf::from(v);
        }
    }
    if let Some(out) = config_path_out {
        if let Some(last) = out.lines().map(str::trim).filter(|l| !l.is_empty()).last() {
            let p = PathBuf::from(last);
            if p.is_absolute() {
                return p;
            }
        }
    }
    dirs_home().join(".omp").join("agent")
}

/// 用户主目录：Windows 先 `USERPROFILE`（系统默认没有 `HOME`，只有 Git Bash 之类会设），
/// 其余平台先 `HOME`；都拿不到时退回系统临时目录（不再硬编码 `/tmp`——Windows 上它
/// 是当前盘根下的 `\tmp`，不是用户目录，会把会话扫描带到一个不存在的地方）。
fn dirs_home() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(p) = std::env::var("USERPROFILE") {
            if !p.trim().is_empty() {
                return PathBuf::from(p);
            }
        }
    }
    if let Ok(p) = std::env::var("HOME") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    std::env::temp_dir()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionHead {
    pub id: String,
    pub cwd: String,
    pub timestamp: i64,
    pub title: String,
    /// 会话里**第一条用户消息**的文本（首个 text 块，截到 200 字符）——只在标题为空时
    /// 用于显示层派生（`display_title` 的兜底），以及壳侧判断「会话已有内容、可以补标题」。
    /// `None` = 还没有用户消息（新会话 / 图片-only 首条）。
    pub first_user_text: Option<String>,
    pub file: String,
    pub corrupt: bool,
}

/// 只读文件头部取 session 行；失败标 corrupt。
/// 文件格式：每行一个 JSON，含 `{"type":"session",...}`。
///
/// 列表扫描要遍历 sessions 下所有 jsonl，**不能整个读进内存**（真实环境单文件可达几十 MB），
/// 所以小文件一次读完、大文件只读「头 64KB + 尾 64KB」两段：
/// 头段拿 `session` / `title` 行与首条用户消息，尾段拿最后一个 `title_change`（标题以最新一次为准）。
/// 两段各自跳过被切断的残行，避免半行 JSON 干扰解析。
pub fn parse_session_head(path: &std::path::Path) -> SessionHead {
    const CHUNK: usize = 64 * 1024;
    let fallback = SessionHead {
        id: path.file_stem().and_then(|s| s.to_str()).unwrap_or("unknown").to_string(),
        cwd: String::new(),
        timestamp: 0,
        title: String::new(),
        first_user_text: None,
        file: path.to_string_lossy().to_string(),
        corrupt: true,
    };
    let Ok(meta) = std::fs::metadata(path) else { return fallback };
    let size = meta.len() as usize;
    if size == 0 {
        return fallback;
    }
    let is_small = size <= CHUNK * 2;

    let mut tail_lines: Vec<String> = vec![];
    let head_text: String = if is_small {
        match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(_) => return fallback,
        }
    } else {
        use std::io::{Read, Seek, SeekFrom};
        let Ok(mut f) = std::fs::File::open(path) else { return fallback };
        let mut head = vec![0u8; CHUNK];
        if f.read_exact(&mut head).is_err() {
            return fallback;
        }
        // 尾段往前多读 1 字节：用于判断首行是不是完整行（前一个字节是否换行）
        if f.seek(SeekFrom::Start((size - CHUNK - 1) as u64)).is_err() {
            return fallback;
        }
        let mut tail = vec![0u8; CHUNK + 1];
        if f.read_exact(&mut tail).is_err() {
            return fallback;
        }
        let tail_s = String::from_utf8_lossy(&tail).to_string();
        tail_lines = split_complete_tail(&tail_s).into_iter().map(str::to_string).collect();
        String::from_utf8_lossy(&head).to_string()
    };

    // 头段：大文件时最后一行可能被窗口切断，丢掉；小文件整段都是完整行
    let head_lines: Vec<&str> = if is_small {
        head_text.split('\n').filter(|l| !l.trim().is_empty()).collect()
    } else {
        split_complete_head(&head_text)
    };

    let mut title = String::new();
    let mut last_title_change: Option<String> = None;
    let mut first_user_text: Option<String> = None;
    let mut session: Option<serde_json::Value> = None;
    for line in &head_lines {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("session") => session = Some(v),
            Some("title") => {
                if let Some(t) = v.get("title").and_then(|t| t.as_str()) {
                    if title.is_empty() {
                        title = t.to_string();
                    }
                }
            }
            Some("title_change") => {
                if let Some(t) = v.get("title").and_then(|t| t.as_str()) {
                    last_title_change = Some(t.to_string());
                }
            }
            // 首条用户消息（显示层派生标题的数据源）：取一次就够，后续消息不再解析
            Some("message") if first_user_text.is_none() => {
                first_user_text = user_message_text(&v);
            }
            _ => {}
        }
    }
    // 大文件的 title_change 在尾段（标题以最新一次为准，会覆盖头段看到的旧值）
    for line in &tail_lines {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) == Some("title_change") {
            if let Some(t) = v.get("title").and_then(|t| t.as_str()) {
                last_title_change = Some(t.to_string());
            }
        }
    }

    let Some(s) = session else { return fallback };
    title = last_title_change.unwrap_or(title);
    if title.is_empty() {
        title = s.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string();
    }
    SessionHead {
        id: s.get("id").and_then(|v| v.as_str()).unwrap_or(&fallback.id).to_string(),
        cwd: s.get("cwd").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        timestamp: s.get("timestamp").and_then(|v| v.as_str()).and_then(parse_ts).unwrap_or(0),
        title,
        first_user_text,
        file: path.to_string_lossy().to_string(),
        corrupt: false,
    }
}

/// 一条 jsonl 行是用户消息时，取它的首个 text 块（折叠空白、截到 200 字符）。
/// 图片-only / 空文本 / 非用户行 → `None`。
fn user_message_text(v: &serde_json::Value) -> Option<String> {
    let m = v.get("message")?;
    if m.get("role").and_then(|r| r.as_str()) != Some("user") {
        return None;
    }
    let text = m
        .get("content")?
        .as_array()?
        .iter()
        .find_map(|b| {
            (b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .then(|| b.get("text").and_then(|t| t.as_str()))
                .flatten()
        })?;
    // 壳侧发送时补的附件顺序注记（`[omp image order: …]`）只给模型看：派生标题不背它
    let text = strip_image_order_note(text);
    let clean = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.is_empty() {
        return None;
    }
    Some(clean.chars().take(200).collect())
}

/// 剥掉壳侧补在正文末尾的附件顺序注记（格式与 `src/lib/imageRefs.ts` 严格对应）。
/// 只有整行都是 `#<数字>=image <数字>` 才认（用户自己写的同款结尾也不展示，
/// 它只可能在末行，删掉不影响消息语义）。
fn strip_image_order_note(text: &str) -> &str {
    let Some((head, tail)) = text.rsplit_once("\n\n[omp image order: ") else {
        return text;
    };
    let Some(body) = tail.strip_suffix(']') else {
        return text;
    };
    let well_formed = !body.is_empty()
        && body.split(", ").all(|entry| {
            let Some((slot, index)) = entry.split_once("=image ") else {
                return false;
            };
            let Some(slot) = slot.strip_prefix('#') else {
                return false;
            };
            is_digits(slot) && is_digits(index)
        });
    if well_formed {
        head
    } else {
        text
    }
}

fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// 头段取完整行：文件不以换行结尾时，最后一行是被窗口切断的残行，丢掉。
fn split_complete_head(text: &str) -> Vec<&str> {
    let mut v: Vec<&str> = text.split('\n').collect();
    if !text.ends_with('\n') {
        v.pop();
    }
    v.into_iter().filter(|l| !l.trim().is_empty()).collect()
}

/// 尾段取完整行：窗口起点落在行中间时（前一个字节不是换行），首行是残行，丢掉。
fn split_complete_tail(text: &str) -> Vec<&str> {
    let mut v: Vec<&str> = text.split('\n').collect();
    if !text.starts_with('\n') && v.len() > 1 {
        v.remove(0);
    }
    v.into_iter().filter(|l| !l.trim().is_empty()).collect()
}

fn parse_ts(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).map(|d| d.timestamp_millis()).ok()
}

/// cwd 归组：按真实路径前缀匹配，不猜 slug。
/// 归一化：去首尾空白与末尾 `/`；macOS 上 `/tmp` 常为 `/private/tmp` 符号链接，
/// 两边统一展开后再比，避免“同目录不同写法”导致会话掉进未归属。
pub fn project_of(cwd: &str, projects: &[String]) -> Option<String> {
    if cwd.is_empty() {
        return None;
    }
    let norm = |p: &str| {
        let mut s = p.trim().to_string();
        while s.len() > 1 && s.ends_with('/') {
            s.pop();
        }
        // macOS 的 /tmp 是 /private/tmp 的符号链接：会话记的 cwd 可能是任一种写法。
        // 目录存在时 canonicalize 就能归一；不存在（会话目录已删 / worktree 已清）才需要
        // 这条字符串回退——**只在 macOS 生效**：Linux 上 /tmp 就是真实路径（canonicalize
        // 会成功返回 /tmp），把不存在的 /tmp/x 改写为 /private/tmp/x 会张冠李戴
        // （CI 的 Linux runner 上正是这么挂的）。
        if cfg!(target_os = "macos") && (s == "/tmp" || s.starts_with("/tmp/")) {
            if let Ok(canon) = std::fs::canonicalize(&s) {
                return canon.to_string_lossy().to_string();
            }
            return s.replacen("/tmp", "/private/tmp", 1);
        }
        // 项目侧也做一次 canonicalize（目录真实存在时），消掉一切符号链接差异
        if let Ok(canon) = std::fs::canonicalize(&s) {
            return canon.to_string_lossy().to_string();
        }
        s
    };
    let cwd = norm(cwd);
    let mut best: Option<(usize, String)> = None;
    for p in projects {
        let np = norm(p);
        let hit = cwd == np || cwd.starts_with(&format!("{np}/"));
        if hit && best.as_ref().map(|b| np.len() > b.0).unwrap_or(true) {
            best = Some((np.len(), p.clone()));
        }
    }
    best.map(|b| b.1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_by_cwd_prefix_longest_wins() {
        let ps = vec!["/a".to_string(), "/a/b".to_string()];
        assert_eq!(project_of("/a/b/c", &ps).as_deref(), Some("/a/b"));
        assert_eq!(project_of("/a/other", &ps).as_deref(), Some("/a"));
        assert_eq!(project_of("/x", &ps), None);
    }

    #[test]
    fn agent_dir_env_wins() {
        std::env::set_var("PI_CODING_AGENT_DIR", "/tmp/xyz-agent");
        assert_eq!(resolve_agent_dir(Some("/nope".into())), PathBuf::from("/tmp/xyz-agent"));
        std::env::remove_var("PI_CODING_AGENT_DIR");
    }

    // ---------- 会话头解析（M1-1 要求覆盖：正常 / 缺 title / 损坏 / 超大） ----------

    fn tmp_file(name: &str, content: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omp-scan-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, content).unwrap();
        p
    }

    #[test]
    fn parse_head_normal_takes_latest_title_change() {
        let p = tmp_file(
            "normal.jsonl",
            concat!(
                "{\"type\":\"title\",\"title\":\"初始标题\"}\n",
                "{\"type\":\"session\",\"id\":\"abc-123\",\"timestamp\":\"2026-09-15T10:00:00.000Z\",\"cwd\":\"/tmp/proj\",\"title\":\"会话标题\"}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[]}}\n",
                "{\"type\":\"title_change\",\"title\":\"改过一次\"}\n",
                "{\"type\":\"title_change\",\"title\":\"最新标题\"}\n",
            ),
        );
        let h = parse_session_head(&p);
        assert!(!h.corrupt);
        assert_eq!(h.id, "abc-123");
        assert_eq!(h.cwd, "/tmp/proj");
        assert_eq!(h.title, "最新标题");
        assert!(h.timestamp > 0, "timestamp 应被解析成毫秒");
    }

    #[test]
    fn parse_head_missing_title_yields_empty() {
        let p = tmp_file(
            "notitle.jsonl",
            "{\"type\":\"session\",\"id\":\"x1\",\"timestamp\":\"2026-09-15T10:00:00.000Z\",\"cwd\":\"/tmp/a\"}\n",
        );
        let h = parse_session_head(&p);
        assert!(!h.corrupt);
        // 空标题交给 display_title 兜「未命名 + 日期」，解析层不编造
        assert_eq!(h.title, "");
        assert_eq!(h.first_user_text, None, "没有用户消息就没有派生标题的数据源");
    }

    #[test]
    fn parse_head_captures_first_user_text() {
        let p = tmp_file(
            "firstuser.jsonl",
            concat!(
                "{\"type\":\"session\",\"id\":\"u1\",\"timestamp\":\"2026-09-15T10:00:00.000Z\",\"cwd\":\"/tmp/a\"}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"先说话的是助手\"}]}}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"image\",\"data\":\"xx\"}]}}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"  第一条   消息\\n换行  \"},{\"type\":\"text\",\"text\":\"第二块\"}]}}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"后面的消息不该覆盖\"}]}}\n",
            ),
        );
        let h = parse_session_head(&p);
        assert_eq!(
            h.first_user_text.as_deref(),
            Some("第一条 消息 换行"),
            "取首个带文本的用户消息（折叠空白、只取首个 text 块）；助手行与图片-only 消息跳过"
        );

        // 200 字符上限（显示层只取前 12 字，派生数据源不必留长文）
        let long = "字".repeat(400);
        let p2 = tmp_file(
            "firstuser-long.jsonl",
            &format!(
                "{}\n{}\n",
                serde_json::json!({"type":"session","id":"u2"}),
                serde_json::json!({"type":"message","message":{"role":"user","content":[{"type":"text","text":long}]}})
            ),
        );
        assert_eq!(parse_session_head(&p2).first_user_text.map(|s| s.chars().count()), Some(200));
    }

    /// 发送时补的附件顺序注记（`[omp image order: …]`）只给模型看：
    /// 首条用户文本 / 派生标题必须剥掉它，否则短消息的标题会变成「#1 [omp imag…」。
    #[test]
    fn user_message_text_strips_image_order_note() {
        let line = serde_json::json!({
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": "如图#1\n\n[omp image order: #1=image 1]" }]
            }
        });
        assert_eq!(user_message_text(&line).as_deref(), Some("如图#1"));
        assert_eq!(
            strip_image_order_note("如图#1\n\n[omp image order: #1=image 1, #3=image 2]"),
            "如图#1"
        );
        // 用户自己写的普通结尾不剥（格式不匹配）
        assert_eq!(
            strip_image_order_note("正文\n\n[omp image order: 手写]"),
            "正文\n\n[omp image order: 手写]"
        );
    }

    #[test]
    fn parse_head_corrupt_cases() {
        let p = tmp_file("broken.jsonl", "这不是 JSON\n{\"type\":\"message\"}\n");
        let h = parse_session_head(&p);
        assert!(h.corrupt);
        assert_eq!(h.id, "broken", "损坏文件也要能用文件名兜一个可删的 id");

        let empty = tmp_file("empty.jsonl", "");
        assert!(parse_session_head(&empty).corrupt);
        assert!(parse_session_head(std::path::Path::new("/tmp/omp-scan-definitely-missing.jsonl")).corrupt);
    }

    #[test]
    fn parse_head_reads_large_file_from_head_and_tail() {
        // >128KB：session 行在头部窗口内，title_change 只在尾部窗口内
        let mut body = String::from(
            "{\"type\":\"session\",\"id\":\"big-1\",\"timestamp\":\"2026-09-15T10:00:00.000Z\",\"cwd\":\"/tmp/big\",\"title\":\"大文件\"}\n",
        );
        let filler = format!(
            "{}\n",
            serde_json::json!({"type":"message","message":{"role":"user","content":[{"type":"text","text":"x".repeat(400)}]}})
        );
        while body.len() < 200 * 1024 {
            body.push_str(&filler);
        }
        body.push_str("{\"type\":\"title_change\",\"title\":\"尾部标题\"}\n");
        let p = tmp_file("big.jsonl", &body);
        let h = parse_session_head(&p);
        assert!(!h.corrupt);
        assert_eq!(h.id, "big-1");
        assert_eq!(h.cwd, "/tmp/big");
        assert_eq!(h.title, "尾部标题", "标题必须来自尾段窗口，而不是只看头 64KB");
    }
}
