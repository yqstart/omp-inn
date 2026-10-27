//! 供应商模型发现（界面上的「获取可用模型」）：**直接问端点要模型清单**，供「挑选模型」
//! 弹窗勾选后写进 `<agentDir>/models.yml` 的 `models` 列表。
//!
//! **为什么壳侧自己发请求**：omp 的 `models.yml` 只有「静态声明」与 `discovery`
//! （`openai-models-list`，自动把端点模型全量灌进目录）两条路，两者都拿不到**候选清单**——
//! 界面要的是「先看有哪些、再决定收哪几个」，所以探测这一跳由壳侧完成，写盘仍走既有的
//! `write_models_config`（预校验 / 备份 / 原子写 / 乐观锁）。
//!
//! **口径来源（DeepSeek Harness 0.2.0-rc.2 实测，`dsh-llm-pi-ai` 的 `discoverModels`）**：
//! - 只对三种 wire API 发探测：`openai-completions` / `openai-responses` / `anthropic-messages`；
//!   其余（Azure `api-key` 头、Codex OAuth…）不猜——猜错会把鉴权失败报成「供应商没有模型」。
//! - URL：OpenAI 系 = `{baseURL 去尾斜杠}/models`（**不自动补 /v1**，按前缀拼、不做 URL 解析，
//!   保住 `https://gw.example.com/openai/v1` 这类部署路径）；Anthropic = 去掉末尾一个 `/v1`
//!   再拼 `/v1/models?limit=1000`（只读一页，不跟随 `has_more`）。
//! - 认证：Anthropic → `x-api-key` + `anthropic-version: 2023-06-01`；其余 → `Bearer`；
//!   **没有密钥就不带认证头**（本地免鉴权端点照常能探测）。
//! - 解析：`data` 数组优先，其次 `models`（对象按 map：键名优先于条目里的 `id`）；容量字段按
//!   多别名兜底（`contextWindow` / `context_length` / `max_input_tokens`…），坏行跳过、缺名回退 id。
//! - 上限：响应体 4 MiB，**超限报错而不是截断**（截断的列表不可解析）。
//! - DSH 链路里**没有超时**（UI 不传 signal、host 不加 AbortSignal），搬过来必须自己加，
//!   见 [`DISCOVERY_TIMEOUT`]。
//!
//! **apiKey 三种写法（omp 18.11 实测，与本模块口径一致）**：`!命令` 执行取 stdout、
//! 裸名字先当**环境变量名**查（命中用其值）、其余按字面量；`${VAR}` 不展开。密钥只在本进程内
//! 使用，不落盘、不进日志、不回传前端。

use std::sync::LazyLock;
use std::time::Duration;

use serde::Serialize;

use crate::commands::{cmd_err, CmdError};

/// 单次探测超时（DSH 没有超时；20s 给慢网关留余量，又不至于让界面一直转）。
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(20);
/// 响应体上限（与 DSH 同值）：超过即报错，不截断。
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
/// Anthropic 的模型列表一页上限（DSH 同款）。
const ANTHROPIC_MODEL_LIMIT: usize = 1000;
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// `!命令` 取密钥的超时。
const KEY_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
/// 探测支持的 wire API（界面上的「接口类型」三档）。
const LISTABLE_APIS: [&str; 3] = [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
];

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(DISCOVERY_TIMEOUT)
        .build()
        .expect("reqwest client 构建失败")
});

// ---------- 视图类型 ----------

/// 探测到的一个模型（只带回界面真正会预填的字段；缺的留给用户在弹窗里补）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredModel {
    pub id: String,
    /// 显示名（端点没给就用 id）。
    pub name: Option<String>,
    /// 上下文窗口（端点给了才回；omp 侧缺省 128000）。
    pub context_window: Option<u64>,
    /// 最大输出（端点给了才回；omp 侧缺省 16384）。
    pub max_tokens: Option<u64>,
    /// 输入模态（端点显式声明了才回，推断不在这里做）。
    pub input: Option<Vec<String>>,
}

// ---------- 纯函数（可测） ----------

/// 探测 URL：OpenAI 系按前缀拼 `/models`，Anthropic 归一化到 `/v1/models`。
pub fn listing_url(base_url: &str, api: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if api == "anthropic-messages" {
        let root = base.strip_suffix("/v1").unwrap_or(base);
        format!("{root}/v1/models?limit={ANTHROPIC_MODEL_LIMIT}")
    } else {
        format!("{base}/models")
    }
}

/// 该接口类型是否支持探测（三档白名单）。
pub fn supports_discovery(api: &str) -> bool {
    LISTABLE_APIS.contains(&api)
}

/// 基础地址是否是可发的 HTTP(S) 地址（前端已校验，这里兜住直连调用）。
pub fn is_http_url(value: &str) -> bool {
    let v = value.trim();
    let lower = v.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return false;
    }
    // 只做「协议 + 有主机」的粗判：探测地址按前缀拼，不用 URL 解析器改写路径。
    let rest = &v[v.find("//").map(|i| i + 2).unwrap_or(v.len())..];
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    !host.is_empty()
}

/// apiKey 字段的写法（omp 口径）；`${VAR}` 不属于任何一种，按字面量处理。
#[derive(Debug, Clone, PartialEq)]
pub enum KeySource {
    /// 没填（免鉴权端点）。
    None,
    /// 字面量密钥；取用时先按**环境变量名**查一次（命中用其值），查不到才当字面量
    /// ——与 omp 实测口径一致（`apiKey: MY_GW_KEY` + 同名环境变量 → 用环境变量的值）。
    Literal(String),
    /// `!命令`：执行并取 stdout。
    Command(String),
}

/// 判定 apiKey 的取值方式（纯函数，执行与查环境变量在调用方）。
pub fn classify_api_key(raw: &str) -> KeySource {
    let v = raw.trim();
    if v.is_empty() {
        return KeySource::None;
    }
    if let Some(cmd) = v.strip_prefix('!') {
        let cmd = cmd.trim();
        return if cmd.is_empty() {
            KeySource::None
        } else {
            KeySource::Command(cmd.to_string())
        };
    }
    KeySource::Literal(v.to_string())
}

/// 把一个候选值按「环境变量名优先、否则字面量」定型（`lookup` 注入便于测试）。
pub fn resolve_literal(value: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    match lookup(value) {
        Some(v) if !v.trim().is_empty() => v,
        _ => value.to_string(),
    }
}

/// 从响应 JSON 里读模型清单（`data[]` 优先，其次 `models` 数组 / `models` map）。
pub fn parse_listing(body: &serde_json::Value) -> Vec<DiscoveredModel> {
    let mut out: Vec<DiscoveredModel> = Vec::new();
    let entries: Vec<(Option<String>, &serde_json::Value)> = match body.get("data") {
        Some(serde_json::Value::Array(items)) => items.iter().map(|v| (None, v)).collect(),
        _ => match body.get("models") {
            Some(serde_json::Value::Array(items)) => items.iter().map(|v| (None, v)).collect(),
            // `models` 是 map：键名优先于条目自己的 id（DSH 同口径）
            Some(serde_json::Value::Object(map)) => {
                map.iter().map(|(k, v)| (Some(k.clone()), v)).collect()
            }
            _ => Vec::new(),
        },
    };
    for (key, item) in entries {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let id = key
            .or_else(|| string_at(obj.get("id")))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let Some(id) = id else { continue };
        if out.iter().any(|m| m.id == id) {
            continue;
        }
        let name = string_at(obj.get("name"))
            .or_else(|| string_at(obj.get("display_name")))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && s != &id);
        let context_window = positive_u64_at(obj, &[
            "contextWindow",
            "context_window",
            "context_length",
            "max_input_tokens",
            // vLLM / 部分自建端点的写法
            "max_model_len",
        ])
        .or_else(|| positive_u64_at_nested(obj, "limit", "context"));
        let max_tokens = positive_u64_at(obj, &[
            "maxOutputTokens",
            "max_output_tokens",
            "maxTokens",
            "max_tokens",
            "max_completion_tokens",
        ])
        .or_else(|| positive_u64_at_nested(obj, "limit", "output"))
        .or_else(|| positive_u64_at_nested(obj, "top_provider", "max_completion_tokens"));
        let input = input_modalities(obj);
        out.push(DiscoveredModel {
            id,
            name,
            context_window,
            max_tokens,
            input,
        });
    }
    out
}

fn string_at(v: Option<&serde_json::Value>) -> Option<String> {
    v.and_then(|v| v.as_str()).map(str::to_string)
}

/// 取第一个值为正整数的候选键（字符串数字也认；0 / 负数 / 非数字一律跳过）。
fn positive_u64_at(obj: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|k| positive_u64(obj.get(*k)))
}

fn positive_u64_at_nested(
    obj: &serde_json::Map<String, serde_json::Value>,
    outer: &str,
    inner: &str,
) -> Option<u64> {
    obj.get(outer)
        .and_then(|v| v.as_object())
        .and_then(|m| positive_u64(m.get(inner)))
}

fn positive_u64(v: Option<&serde_json::Value>) -> Option<u64> {
    let n = match v? {
        serde_json::Value::Number(n) => n.as_u64()?,
        serde_json::Value::String(s) => s.trim().parse::<u64>().ok()?,
        _ => return None,
    };
    (n > 0).then_some(n)
}

/// 输入模态：只认显式声明（`input_modalities` / `inputModalities` / `input` 里的字符串项）。
fn input_modalities(obj: &serde_json::Map<String, serde_json::Value>) -> Option<Vec<String>> {
    let raw = ["input_modalities", "inputModalities", "input"]
        .iter()
        .find_map(|k| obj.get(*k))?;
    let arr = raw.as_array()?;
    let items: Vec<String> = arr
        .iter()
        .filter_map(|v| v.as_str())
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    (!items.is_empty()).then_some(items)
}

// ---------- Tauri 命令 ----------

/// 探测某个端点的模型清单（界面「获取可用模型」）。
///
/// `api_key` 传表单里的原样值（可能是字面量 / 环境变量名 / `!命令`）；没有就不带认证头。
#[tauri::command]
pub async fn fetch_provider_models(
    base_url: String,
    api: String,
    api_key: Option<String>,
) -> Result<Vec<DiscoveredModel>, CmdError> {
    let base = base_url.trim();
    if !is_http_url(base) {
        return Err(cmd_err(
            "DISCOVERY_BAD_URL",
            "接口地址必须是 http(s) 开头且带主机名".into(),
            Some("先在供应商配置里填好接口地址".into()),
        ));
    }
    let api = api.trim();
    if !supports_discovery(api) {
        return Err(cmd_err(
            "DISCOVERY_UNSUPPORTED",
            format!("接口类型「{api}」不支持模型列表探测"),
            Some("改用手工添加模型".into()),
        ));
    }
    let url = listing_url(base, api);
    let key = match classify_api_key(api_key.as_deref().unwrap_or("")) {
        KeySource::None => None,
        KeySource::Literal(v) => Some(resolve_literal(&v, |name| std::env::var(name).ok())),
        KeySource::Command(cmd) => Some(run_key_command(&cmd).await?),
    };

    let mut req = HTTP
        .get(&url)
        .header("accept", "application/json");
    if let Some(key) = &key {
        req = if api == "anthropic-messages" {
            req.header("x-api-key", key)
                .header("anthropic-version", ANTHROPIC_VERSION)
        } else {
            req.header("authorization", format!("Bearer {key}"))
        };
    }
    let resp = req.send().await.map_err(|e| {
        // reqwest 的错误里可能带完整 URL（不含密钥），但仍统一收窄成一句话
        let reason = if e.is_timeout() {
            format!("请求超时（{}s）", DISCOVERY_TIMEOUT.as_secs())
        } else {
            e.to_string()
        };
        cmd_err(
            "DISCOVERY_FAILED",
            format!("无法连接 {url}：{reason}"),
            Some("检查接口地址 / 网络后重试".into()),
        )
    })?;
    let status = resp.status();
    if !status.is_success() {
        let hint = if status.as_u16() == 401 || status.as_u16() == 403 {
            Some("API Key 可能无效或权限不足".into())
        } else {
            None
        };
        return Err(cmd_err(
            "DISCOVERY_REJECTED",
            format!("{url} 返回 {status}"),
            hint,
        ));
    }
    let body = read_bounded(resp, &url).await?;
    let value: serde_json::Value = serde_json::from_str(&body).map_err(|_| {
        cmd_err(
            "DISCOVERY_NOT_JSON",
            format!("{url} 返回的不是 JSON"),
            Some("该端点可能不是 OpenAI / Anthropic 兼容接口".into()),
        )
    })?;
    Ok(parse_listing(&value))
}

/// 流式读响应体并卡上限（先看 content-length，再累计实读字节）。
async fn read_bounded(mut resp: reqwest::Response, url: &str) -> Result<String, CmdError> {
    if let Some(len) = resp.content_length() {
        if len > MAX_RESPONSE_BYTES as u64 {
            return Err(too_large(url));
        }
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| {
        cmd_err(
            "DISCOVERY_FAILED",
            format!("读取 {url} 的响应失败：{e}"),
            None,
        )
    })? {
        if buf.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(too_large(url));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&buf).to_string())
}

fn too_large(url: &str) -> CmdError {
    cmd_err(
        "DISCOVERY_TOO_LARGE",
        format!(
            "{url} 的响应超过 {} MiB",
            MAX_RESPONSE_BYTES / (1024 * 1024)
        ),
        Some("该端点的模型列表异常大，请手工添加模型".into()),
    )
}

/// 执行 `!命令` 取密钥（stdout 第一行，去空白）。
async fn run_key_command(cmd: &str) -> Result<String, CmdError> {
    let mut c = tokio::process::Command::new("sh");
    c.arg("-c")
        .arg(cmd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let out = tokio::time::timeout(KEY_COMMAND_TIMEOUT, c.output())
        .await
        .map_err(|_| {
            cmd_err(
                "DISCOVERY_KEY_FAILED",
                format!("取密钥的命令超时（{}s）", KEY_COMMAND_TIMEOUT.as_secs()),
                None,
            )
        })?
        .map_err(|e| {
            cmd_err(
                "DISCOVERY_KEY_FAILED",
                format!("取密钥的命令执行失败：{e}"),
                None,
            )
        })?;
    let value = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if value.is_empty() {
        return Err(cmd_err(
            "DISCOVERY_KEY_FAILED",
            "取密钥的命令没有输出".into(),
            Some("检查 apiKey 里的 `!命令` 写法".into()),
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---------- URL ----------

    #[test]
    fn openai_urls_keep_path_and_drop_trailing_slash() {
        assert_eq!(
            listing_url("https://gw.example.com/v1", "openai-completions"),
            "https://gw.example.com/v1/models"
        );
        assert_eq!(
            listing_url("https://gw.example.com/openai/v1/", "openai-responses"),
            "https://gw.example.com/openai/v1/models"
        );
        // 不自动补 /v1：端点自带与否由用户决定（与 DSH 同口径）
        assert_eq!(
            listing_url("http://127.0.0.1:8080", "openai-completions"),
            "http://127.0.0.1:8080/models"
        );
    }

    #[test]
    fn anthropic_url_normalizes_v1_and_limits_page() {
        assert_eq!(
            listing_url("https://api.example.com", "anthropic-messages"),
            "https://api.example.com/v1/models?limit=1000"
        );
        assert_eq!(
            listing_url("https://api.example.com/v1", "anthropic-messages"),
            "https://api.example.com/v1/models?limit=1000"
        );
    }

    #[test]
    fn supports_discovery_covers_three_apis_only() {
        assert!(supports_discovery("openai-completions"));
        assert!(supports_discovery("openai-responses"));
        assert!(supports_discovery("anthropic-messages"));
        assert!(!supports_discovery("azure-openai"));
        assert!(!supports_discovery(""));
    }

    #[test]
    fn http_url_check_requires_scheme_and_host() {
        assert!(is_http_url("https://gw.example.com/v1"));
        assert!(is_http_url("http://127.0.0.1:9999"));
        assert!(!is_http_url("gw.example.com/v1"));
        assert!(!is_http_url("https://"));
        assert!(!is_http_url("file:///tmp/x"));
        assert!(!is_http_url(""));
    }

    // ---------- apiKey 分类 ----------

    #[test]
    fn api_key_classification_matches_omp_semantics() {
        assert_eq!(classify_api_key(""), KeySource::None);
        assert_eq!(classify_api_key("   "), KeySource::None);
        assert_eq!(classify_api_key("!"), KeySource::None);
        assert_eq!(
            classify_api_key("sk-literal"),
            KeySource::Literal("sk-literal".into())
        );
        assert_eq!(
            classify_api_key("MY_GW_KEY"),
            KeySource::Literal("MY_GW_KEY".into())
        );
        assert_eq!(
            classify_api_key("!op read op://vault/gw/key"),
            KeySource::Command("op read op://vault/gw/key".into())
        );
        // `${VAR}` 不是 omp 的写法，按字面量走（不假装展开）
        assert_eq!(
            classify_api_key("${MY_GW_KEY}"),
            KeySource::Literal("${MY_GW_KEY}".into())
        );
    }

    #[test]
    fn literal_prefers_environment_variable_then_falls_back() {
        let lookup = |name: &str| (name == "MY_GW_KEY").then(|| "sk-from-env".to_string());
        assert_eq!(resolve_literal("MY_GW_KEY", lookup), "sk-from-env");
        assert_eq!(resolve_literal("sk-literal", lookup), "sk-literal");
        // 空环境变量视同没有
        let empty = |_: &str| Some("  ".to_string());
        assert_eq!(resolve_literal("MY_GW_KEY", empty), "MY_GW_KEY");
    }

    // ---------- 响应解析 ----------

    #[test]
    fn parses_openai_data_array_with_aliases() {
        let body = json!({
            "object": "list",
            "data": [
                { "id": "a", "name": "A", "context_length": 200000, "max_output_tokens": 8192 },
                { "id": "b", "limit": { "context": 1000, "output": 100 } },
                { "id": "c", "max_model_len": 4096 }
            ]
        });
        let models = parse_listing(&body);
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].id, "a");
        assert_eq!(models[0].name.as_deref(), Some("A"));
        assert_eq!(models[0].context_window, Some(200000));
        assert_eq!(models[0].max_tokens, Some(8192));
        assert_eq!(models[1].context_window, Some(1000));
        assert_eq!(models[1].max_tokens, Some(100));
        assert_eq!(models[2].context_window, Some(4096), "vLLM 的 max_model_len 也认");
    }

    #[test]
    fn parses_models_map_keyed_entries() {
        let body = json!({ "models": { "m1": { "context_window": 32000 }, "m2": {} } });
        let models = parse_listing(&body);
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["m1", "m2"]
        );
        assert_eq!(models[0].context_window, Some(32000));
        assert_eq!(models[1].name, None);
    }

    #[test]
    fn skips_bad_rows_and_dedupes_ids() {
        let body = json!({ "data": [
            { "id": "x" },
            { "name": "no id" },
            "not an object",
            { "id": "x", "name": "dupe" },
            { "id": "   " }
        ] });
        let models = parse_listing(&body);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "x");
    }

    #[test]
    fn name_falls_back_to_id_and_ignores_non_positive_capacity() {
        let body = json!({ "data": [
            { "id": "a", "name": "a" },
            { "id": "b", "context_window": 0, "max_tokens": -5, "max_output_tokens": "4096" }
        ] });
        let models = parse_listing(&body);
        assert_eq!(models[0].name, None, "显示名与 id 相同 = 没有显示名");
        assert_eq!(models[1].context_window, None);
        assert_eq!(models[1].max_tokens, Some(4096), "字符串数字也认");
    }

    #[test]
    fn reads_input_modalities_when_declared() {
        let body = json!({ "data": [
            { "id": "a", "input_modalities": ["text", "Image"] },
            { "id": "b" }
        ] });
        let models = parse_listing(&body);
        assert_eq!(
            models[0].input,
            Some(vec!["text".to_string(), "image".to_string()])
        );
        assert_eq!(models[1].input, None);
    }

    #[test]
    fn unknown_shape_yields_empty_list() {
        assert!(parse_listing(&json!({})).is_empty());
        assert!(parse_listing(&json!({ "data": "nope" })).is_empty());
        assert!(parse_listing(&json!([])).is_empty());
    }

    // ---------- 真发请求（本地 mock，不打外网） ----------

    /// 起一个只答一次的本地 HTTP server，回 `{"data":[{"id":"mock"}]}`，并把请求行与
    /// `authorization` / `x-api-key` / `anthropic-version` 头记下来给断言用。
    fn spawn_mock() -> (String, std::sync::mpsc::Receiver<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let _ = tx.send(req);
            let body = r#"{"object":"list","data":[{"id":"mock","context_length":64000}]}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        });
        (format!("http://{addr}"), rx)
    }

    fn header_value(req: &str, name: &str) -> Option<String> {
        req.lines()
            .find(|l| l.to_ascii_lowercase().starts_with(&format!("{name}:")))
            .map(|l| l.split_once(':').map(|(_, v)| v.trim().to_string()).unwrap_or_default())
    }

    #[tokio::test]
    async fn openai_probe_uses_bearer_and_reads_target_path() {
        let (base, rx) = spawn_mock();
        let got = fetch_provider_models(
            format!("{base}/v1"),
            "openai-completions".into(),
            Some("sk-probe".into()),
        )
        .await
        .unwrap();
        let req = rx.recv().unwrap();
        assert!(req.starts_with("GET /v1/models "), "请求行: {req}");
        assert_eq!(
            header_value(&req, "authorization").as_deref(),
            Some("Bearer sk-probe")
        );
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, "mock");
        assert_eq!(got[0].context_window, Some(64000));
    }

    #[tokio::test]
    async fn anthropic_probe_uses_x_api_key_and_version() {
        let (base, rx) = spawn_mock();
        let got = fetch_provider_models(
            format!("{base}/v1"),
            "anthropic-messages".into(),
            Some("sk-anthropic".into()),
        )
        .await
        .unwrap();
        let req = rx.recv().unwrap();
        assert!(
            req.starts_with("GET /v1/models?limit=1000 "),
            "请求行: {req}"
        );
        assert_eq!(
            header_value(&req, "x-api-key").as_deref(),
            Some("sk-anthropic")
        );
        assert_eq!(
            header_value(&req, "anthropic-version").as_deref(),
            Some(ANTHROPIC_VERSION)
        );
        assert_eq!(header_value(&req, "authorization"), None);
        assert_eq!(got.len(), 1);
    }

    #[tokio::test]
    async fn probe_rejects_bad_url_and_unsupported_api_without_sending() {
        let err = fetch_provider_models("gw.example.com".into(), "openai-completions".into(), None)
            .await
            .unwrap_err();
        assert_eq!(err.code, "DISCOVERY_BAD_URL");
        let err = fetch_provider_models("http://127.0.0.1:1".into(), "azure-openai".into(), None)
            .await
            .unwrap_err();
        assert_eq!(err.code, "DISCOVERY_UNSUPPORTED");
    }
}
