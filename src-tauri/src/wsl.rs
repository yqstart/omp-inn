//! WSL 桥接（P1）：识别 `\\wsl$\<distro>\...` 项目，构造 `wsl.exe` 启动命令。
//!
//! 口径（与 DSH 的取舍一致）：Windows 壳不假装能在 Windows 侧“驱动 WSL 里的
//! 工具链”——它只在用户**把项目放在 WSL 里**时，把会话 / 终端切到该发行版：
//!
//! - 终端：`wsl.exe -d <distro> -- bash -lc "cd -- '<linux>' && exec bash -l"`
//! - 会话：同样包一层 bash，在里面 `exec omp ...`（omp 必须在 WSL 的 PATH 里）
//! - 文件树 / 引用：`\\wsl$\...` 是普通 UNC 路径，Windows 侧直接读，无需转换
//! - 会话历史：omp 在 WSL 内把 jsonl 写进它自己的 `~/.omp`；Windows 侧列表暂不合并
//!   （已知边界，不是静默丢数据）
//!
//! 纯字符串逻辑，不依赖 `cfg(windows)`：在 macOS / Linux 上也能编译与单测；
//! 只有真正命中 WSL UNC 路径时才会 spawn `wsl.exe`（非 Windows 上不会命中）。

/// 一个 WSL UNC 路径拆出来的发行版与 Linux 侧路径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslPath {
    pub distro: String,
    /// Linux 侧绝对路径（`/home/u/proj`；根为 `/`）。
    pub linux: String,
}

/// 解析 WSL UNC 路径：`\\wsl$\Ubuntu\home\u\proj` / `\\wsl.localhost\Ubuntu\home\u\proj`。
///
/// 也接受正斜杠写法（`//wsl$/Ubuntu/home`）；其余 UNC（`\\server\share`）返回 None。
/// `..` 段一律拒绝——命令会进 shell，不做路径穿越。
pub fn parse_unc(path: &str) -> Option<WslPath> {
    let normalized = path.replace('/', "\\");
    let rest = normalized.strip_prefix("\\\\")?;
    let (host, rest) = rest.split_once('\\')?;
    if !host.eq_ignore_ascii_case("wsl$") && !host.eq_ignore_ascii_case("wsl.localhost") {
        return None;
    }
    let (distro, tail) = rest.split_once('\\').unwrap_or((rest, ""));
    let distro = distro.trim();
    if distro.is_empty() {
        return None;
    }
    let tail = tail.trim_matches('\\');
    let linux = if tail.is_empty() { "/".to_string() } else { format!("/{}", tail.replace('\\', "/")) };
    if linux.split('/').any(|part| part == "..") {
        return None;
    }
    Some(WslPath { distro: distro.to_string(), linux })
}

/// POSIX shell 单引号转义：`it's` → `'it'\''s'`。
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 构造 `wsl.exe` 的 bash 启动参数：先 cd 到 Linux 项目目录，再 `exec program args...`。
///
/// 为什么用 `bash -lc` 而不是 `wsl.exe --cd`：`--cd` 需要 Windows 10 1903+，
/// 而 `bash -lc` 在所有 WSL 版本上都能用，并且会加载登录 shell 的 PATH
/// （用户把 omp 装在 `~/.local/bin` / `~/.bun/bin` 时尤其重要）。
pub fn bash_launch(distro: &str, linux_cwd: &str, program: &str, args: &[String]) -> (String, Vec<String>) {
    // WSL 默认不透传 Windows 的 `TERM` / `COLORTERM`（除非用 WSLENV 显式声明），
    // 所以在脚本里重新导出，xterm.js 的换行与颜色才正常。
    let mut line = format!(
        "cd -- {} && export TERM=xterm-256color COLORTERM=truecolor && exec {}",
        shell_quote(if linux_cwd.is_empty() { "/" } else { linux_cwd }),
        shell_quote(program)
    );
    for a in args {
        line.push(' ');
        line.push_str(&shell_quote(a));
    }
    (
        "wsl.exe".to_string(),
        vec![
            "-d".to_string(),
            distro.to_string(),
            "--".to_string(),
            "bash".to_string(),
            "-lc".to_string(),
            line,
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_wsl_unc_paths() {
        assert_eq!(
            parse_unc(r"\\wsl$\Ubuntu\home\yanqi\proj"),
            Some(WslPath { distro: "Ubuntu".into(), linux: "/home/yanqi/proj".into() })
        );
        assert_eq!(
            parse_unc(r"\\wsl.localhost\Debian\srv\app"),
            Some(WslPath { distro: "Debian".into(), linux: "/srv/app".into() })
        );
        assert_eq!(
            parse_unc("//wsl$/Ubuntu/home/u"),
            Some(WslPath { distro: "Ubuntu".into(), linux: "/home/u".into() })
        );
        assert_eq!(
            parse_unc(r"\\wsl$\Ubuntu"),
            Some(WslPath { distro: "Ubuntu".into(), linux: "/".into() })
        );
    }

    #[test]
    fn rejects_non_wsl_and_traversal() {
        assert_eq!(parse_unc(r"C:\proj"), None);
        assert_eq!(parse_unc(r"\\server\share\dir"), None);
        assert_eq!(parse_unc(r"\\wsl$\Ubuntu\home\..\etc"), None);
        assert_eq!(parse_unc(r"\\wsl$\"), None);
    }

    #[test]
    fn builds_quoted_bash_launch() {
        let (bin, args) = bash_launch("Ubuntu", "/home/u/my proj", "omp", &["--mode".into(), "rpc-ui".into()]);
        assert_eq!(bin, "wsl.exe");
        assert_eq!(args[..5], ["-d", "Ubuntu", "--", "bash", "-lc"]);
        assert_eq!(
            args[5],
            "cd -- '/home/u/my proj' && export TERM=xterm-256color COLORTERM=truecolor && exec 'omp' '--mode' 'rpc-ui'"
        );
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
    }
}
