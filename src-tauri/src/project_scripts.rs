//! 右栏「脚本」页签的项目脚本识别（V43）：读项目清单文件，给出可直接在终端里跑的常用命令。
//!
//! 口径：
//! - **只读**：不执行任何命令、不写任何文件；识别结果只是候选清单，跑不跑由用户点。
//! - **轻量解析**：Makefile / justfile / Taskfile / TOML 段一律行扫描——不为几个清单文件引
//!   TOML / YAML 依赖（编译时间与供应链成本都不划算），只认最常见的写法：解析不出来就是没有，
//!   不猜。（对应地：不常见的写法漏掉是**已知边界**，不是 bug。）
//! - **自定义脚本不在这里**：那是本应用偏好（前端 localStorage，按项目目录分组），后端不碰。

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::commands::{cmd_err, CmdError};

/// 单条候选脚本。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScript {
    /// 展示名（package.json 的脚本名 / target / recipe…）。
    pub name: String,
    /// 可直接在终端里跑的命令原文。
    pub command: String,
    /// 来源（展示用）：`package.json` / `Cargo.toml` / `.cargo/config.toml` / `go.mod` /
    /// `manage.py` / `pyproject.toml` / `Makefile` / `justfile` / `Taskfile.yml`。
    pub source: String,
}

/// 一次识别结果。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptCatalog {
    pub cwd: String,
    /// 识别到的生态（展示用，如 `Node (pnpm)` / `Rust` / `Go` / `Python` / `Make` / `just` / `Task`）。
    pub ecosystems: Vec<String>,
    pub scripts: Vec<ProjectScript>,
}

/// 目录里是否存在这个文件（区分大小写；macOS 默认不区分，逐个 try 即可）。
fn has(dir: &Path, name: &str) -> bool {
    dir.join(name).is_file()
}

/// 读文本文件（读不到 / 非 UTF-8 都当没有）。
fn read(dir: &Path, name: &str) -> Option<String> {
    std::fs::read_to_string(dir.join(name)).ok()
}

/// 第一个存在的候选文件名（大小写变体 / 别名）。
fn first_of(dir: &Path, names: &[&str]) -> Option<String> {
    names.iter().find(|n| has(dir, n)).map(|n| (*n).to_string())
}

/// 包管理器：锁文件优先，其次 `package.json` 的 `packageManager`，最后 npm。
pub fn package_manager(lock_names: &[String], package_manager_field: Option<&str>) -> String {
    // 顺序即优先级：一个仓库同时留多个锁文件时，以「更明确的那个」为准
    let known: [(&str, &str); 5] = [
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("bun.lockb", "bun"),
        ("bun.lock", "bun"),
        ("package-lock.json", "npm"),
    ];
    for (file, pm) in known {
        if lock_names.iter().any(|n| n == file) {
            return pm.to_string();
        }
    }
    if let Some(field) = package_manager_field {
        // `pnpm@9.15.0` → `pnpm`
        let name = field.split('@').next().unwrap_or("").trim();
        if !name.is_empty() {
            return name.to_string();
        }
    }
    "npm".into()
}

/// `package.json` 的 `scripts` 段 → （名字，脚本体）。JSON 坏 / 没有 `scripts` 都返回空。
pub fn parse_package_scripts(text: &str) -> Vec<(String, String)> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let Some(map) = value.get("scripts").and_then(|s| s.as_object()) else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
        .collect()
}

/// `package.json` 的 `packageManager` 字段。
pub fn package_manager_field(text: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(text).ok()?;
    value.get("packageManager")?.as_str().map(|s| s.to_string())
}

/// Makefile 的 target：行首无缩进、`名字:` 起头。
///
/// 排除：命令体（缩进行）、注释、变量赋值（含 `=`）、模式规则（含 `%`）、变量引用（含 `$`）、
/// 多目标行（含空白）、特殊 target（`.` 开头，如 `.PHONY`）与非名字字符。
pub fn parse_make_targets(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in text.lines() {
        if raw.starts_with(['\t', ' ']) || raw.trim_start().starts_with('#') {
            continue;
        }
        let Some((head, tail)) = raw.split_once(':') else {
            continue;
        };
        // `CC := cc` / `FOO ::= x` 是变量赋值（`::=` 也以 `=` 起头），不是 target
        if tail.trim_start().starts_with('=') {
            continue;
        }
        let name = head.trim();
        if name.is_empty()
            || name.starts_with('.')
            || name.contains('=')
            || name.contains('%')
            || name.contains('$')
            || name.contains(char::is_whitespace)
            || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
        {
            continue;
        }
        if !out.iter().any(|n| n == name) {
            out.push(name.to_string());
        }
    }
    out
}

/// justfile 的 recipe：行首无缩进、`名字 [参数…]:` 起头。
///
/// 排除：赋值（`x := …`）、内建指令（`set` / `export` / `alias` / `import` / `mod`）与注释。
pub fn parse_just_recipes(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in text.lines() {
        if raw.starts_with(['\t', ' ']) {
            continue;
        }
        // 行尾注释先剥掉（`build: # 说明`）
        let line = raw.split('#').next().unwrap_or("").trim_end();
        if line.is_empty() || line.contains(":=") {
            continue;
        }
        let Some((head, _)) = line.split_once(':') else {
            continue;
        };
        let Some(name) = head.split_whitespace().next() else {
            continue;
        };
        if matches!(name, "set" | "export" | "unexport" | "alias" | "import" | "mod")
            || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            continue;
        }
        if !out.iter().any(|n| n == name) {
            out.push(name.to_string());
        }
    }
    out
}

/// Taskfile.yml 的 task：`tasks:` 段内**统一缩进**的那一层 `名字:` 行。
///
/// YAML 行扫描：段内第一行的缩进即任务层缩进（通常 2 空格），同级才收；缩进回到 0 即段落结束。
pub fn parse_taskfile_tasks(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut in_tasks = false;
    let mut level: Option<usize> = None;
    for raw in text.lines() {
        let trimmed = raw.trim_end();
        if trimmed.trim().is_empty() || trimmed.trim_start().starts_with('#') {
            continue;
        }
        let indent = trimmed.len() - trimmed.trim_start().len();
        if !in_tasks {
            if trimmed.trim_end() == "tasks:" {
                in_tasks = true;
            }
            continue;
        }
        if indent == 0 {
            break; // 顶层下一段，tasks 结束
        }
        let current = *level.get_or_insert(indent);
        if indent != current {
            continue;
        }
        let Some((name, _)) = trimmed.trim().split_once(':') else {
            continue;
        };
        let name = name.trim().trim_matches('"').trim_matches('\'');
        if name.is_empty() || name.contains(char::is_whitespace) {
            continue;
        }
        if !out.iter().any(|n| n == name) {
            out.push(name.to_string());
        }
    }
    out
}

/// TOML 某个 `[section]` 段里的 `key = "value"`（行扫描：段名精确匹配，不含子段）。
///
/// 用于 `[alias]`（.cargo/config.toml）、`[project.scripts]` / `[tool.poetry.scripts]`（pyproject.toml）。
pub fn parse_toml_section_entries(text: &str, section: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut inside = false;
    for raw in text.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') {
            let name = line.trim_start_matches('[').trim_end_matches(']').trim();
            inside = name == section;
            continue;
        }
        if !inside {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let key = k.trim().trim_matches('"').trim_matches('\'').to_string();
        let value = v.trim().trim_matches('"').trim_matches('\'').to_string();
        if key.is_empty() || value.is_empty() || value.starts_with('[') || value.starts_with('{') {
            continue; // 数组 / 内联表不是命令，跳过
        }
        out.push((key, value));
    }
    out
}

/// 扫描一个项目目录，给出候选脚本清单（纯函数，便于单测）。
pub fn scan(dir: &Path, cwd: &str) -> ScriptCatalog {
    let mut ecosystems: Vec<String> = Vec::new();
    let mut scripts: Vec<ProjectScript> = Vec::new();

    // ---- Node / 前端 ----
    if let Some(text) = read(dir, "package.json") {
        let locks: Vec<String> = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "package-lock.json"]
            .iter()
            .filter(|n| has(dir, n))
            .map(|n| (*n).to_string())
            .collect();
        let pm = package_manager(&locks, package_manager_field(&text).as_deref());
        let entries = parse_package_scripts(&text);
        if !entries.is_empty() {
            ecosystems.push(format!("Node ({pm})"));
            for (name, _) in entries {
                scripts.push(ProjectScript {
                    command: format!("{pm} run {name}"),
                    name,
                    source: "package.json".into(),
                });
            }
        } else {
            ecosystems.push("Node".into());
        }
    }

    // ---- Rust ----
    if has(dir, "Cargo.toml") {
        ecosystems.push("Rust".into());
        for (name, command) in [
            ("build", "cargo build"),
            ("test", "cargo test"),
            ("run", "cargo run"),
            ("clippy", "cargo clippy --all-targets"),
            ("fmt", "cargo fmt"),
        ] {
            scripts.push(ProjectScript {
                name: name.into(),
                command: command.into(),
                source: "Cargo.toml".into(),
            });
        }
        if let Some(text) = first_of(dir, &[".cargo/config.toml", ".cargo/config"]).and_then(|n| read(dir, &n)) {
            for (name, _) in parse_toml_section_entries(&text, "alias") {
                scripts.push(ProjectScript {
                    command: format!("cargo {name}"),
                    name,
                    source: ".cargo/config.toml".into(),
                });
            }
        }
    }

    // ---- Go ----
    if has(dir, "go.mod") {
        ecosystems.push("Go".into());
        for (name, command) in [
            ("build", "go build ./..."),
            ("test", "go test ./..."),
            ("run", "go run ."),
            ("vet", "go vet ./..."),
        ] {
            scripts.push(ProjectScript {
                name: name.into(),
                command: command.into(),
                source: "go.mod".into(),
            });
        }
    }

    // ---- Python ----
    let manage = has(dir, "manage.py");
    let pyproject = read(dir, "pyproject.toml");
    if manage || pyproject.is_some() {
        ecosystems.push("Python".into());
        if manage {
            // macOS / Linux 现代发行版没有 `python` 别名，统一 python3
            for (name, args) in [
                ("runserver", "runserver"),
                ("migrate", "migrate"),
                ("makemigrations", "makemigrations"),
                ("test", "test"),
                ("shell", "shell"),
            ] {
                scripts.push(ProjectScript {
                    name: format!("manage.py {name}"),
                    command: format!("python3 manage.py {args}"),
                    source: "manage.py".into(),
                });
            }
        }
        if let Some(text) = &pyproject {
            for section in ["project.scripts", "tool.poetry.scripts"] {
                for (name, _) in parse_toml_section_entries(text, section) {
                    // 入口点是「安装后可直接执行的命令名」，原样给出（跑不跑得动取决于装没装）
                    scripts.push(ProjectScript {
                        name: name.clone(),
                        command: name,
                        source: "pyproject.toml".into(),
                    });
                }
            }
        }
    }

    // ---- Makefile ----
    if let Some(file) = first_of(dir, &["Makefile", "makefile", "GNUmakefile"]) {
        if let Some(text) = read(dir, &file) {
            let targets = parse_make_targets(&text);
            if !targets.is_empty() {
                ecosystems.push("Make".into());
                for name in targets {
                    scripts.push(ProjectScript {
                        command: format!("make {name}"),
                        name,
                        source: file.clone(),
                    });
                }
            }
        }
    }

    // ---- justfile ----
    if let Some(file) = first_of(dir, &["justfile", "Justfile", ".justfile"]) {
        if let Some(text) = read(dir, &file) {
            let recipes = parse_just_recipes(&text);
            if !recipes.is_empty() {
                ecosystems.push("just".into());
                for name in recipes {
                    scripts.push(ProjectScript {
                        command: format!("just {name}"),
                        name,
                        source: file.clone(),
                    });
                }
            }
        }
    }

    // ---- Taskfile ----
    if let Some(file) = first_of(dir, &["Taskfile.yml", "Taskfile.yaml", "taskfile.yml", "taskfile.yaml"]) {
        if let Some(text) = read(dir, &file) {
            let tasks = parse_taskfile_tasks(&text);
            if !tasks.is_empty() {
                ecosystems.push("Task".into());
                for name in tasks {
                    scripts.push(ProjectScript {
                        command: format!("task {name}"),
                        name,
                        source: file.clone(),
                    });
                }
            }
        }
    }

    ScriptCatalog {
        cwd: cwd.to_string(),
        ecosystems,
        scripts,
    }
}

/// 识别一个项目目录里的可跑脚本（右栏「脚本」页签的数据源）。
#[tauri::command]
pub async fn discover_scripts(cwd: String) -> Result<ScriptCatalog, CmdError> {
    let dir = PathBuf::from(&cwd);
    if !dir.is_dir() {
        return Err(cmd_err("DIR_MISSING", "目录不存在".into(), Some(cwd.clone())));
    }
    let target = cwd.clone();
    // 读若干小文件通常很快，但网络盘 / 大 Makefile 仍可能慢：放阻塞线程池
    tauri::async_runtime::spawn_blocking(move || scan(Path::new(&target), &target))
        .await
        .map_err(|e| cmd_err("SCRIPTS_SCAN", e.to_string(), None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_manager_follows_lockfile_then_field() {
        assert_eq!(package_manager(&["yarn.lock".into()], Some("pnpm@9")), "yarn");
        assert_eq!(package_manager(&[], Some("pnpm@9.15.0")), "pnpm");
        assert_eq!(package_manager(&[], None), "npm");
    }

    #[test]
    fn parse_package_scripts_reads_scripts_only() {
        let text = r#"{"name":"x","scripts":{"dev":"vite","build":"tsc && vite build"},"dependencies":{}}"#;
        let mut got = parse_package_scripts(text);
        got.sort();
        assert_eq!(
            got,
            vec![
                ("build".to_string(), "tsc && vite build".to_string()),
                ("dev".to_string(), "vite".to_string()),
            ]
        );
        assert!(parse_package_scripts("{ 坏 JSON").is_empty());
        assert!(parse_package_scripts(r#"{"name":"x"}"#).is_empty());
    }

    #[test]
    fn parse_make_targets_skips_noise() {
        let text = "\
CC := cc
.PHONY: all clean
all: build
\t$(CC) -o x x.c
build: x.c
clean:
# 注释
%.o: %.c
\t$(CC) -c $<
";
        assert_eq!(parse_make_targets(text), vec!["all".to_string(), "build".into(), "clean".into()]);
    }

    #[test]
    fn parse_just_recipes_skips_assignments_and_directives() {
        let text = "\
set shell := [\"bash\", \"-c\"]
export FOO := \"bar\"
alias b := build

build:
 cargo build

test target=\"all\": # 跑测试
 cargo test
";
        assert_eq!(parse_just_recipes(text), vec!["build".to_string(), "test".into()]);
    }

    #[test]
    fn parse_taskfile_tasks_reads_uniform_level() {
        let text = "\
version: '3'
tasks:
  build:
    desc: 构建
    cmds:
      - go build
  test:
    cmds:
      - go test ./...
vars:
  X: 1
";
        assert_eq!(parse_taskfile_tasks(text), vec!["build".to_string(), "test".into()]);
    }

    #[test]
    fn parse_toml_section_entries_matches_exact_section() {
        let text = "\
[package]
name = \"x\"

[alias]
b = \"build --release\"
t = \"test --all\"

[alias.extra]
z = \"nope\"
";
        assert_eq!(
            parse_toml_section_entries(text, "alias"),
            vec![("b".to_string(), "build --release".to_string()), ("t".to_string(), "test --all".to_string())]
        );
    }

    #[test]
    fn scan_reads_this_repo_as_rust() {
        // 用本 crate 目录当真样本：有 Cargo.toml（Rust 固定档）
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let catalog = scan(dir, "/w/omp");
        assert!(catalog.ecosystems.iter().any(|e| e == "Rust"), "{:?}", catalog.ecosystems);
        assert!(catalog.scripts.iter().any(|s| s.command == "cargo test"));
    }

    #[test]
    fn scan_missing_dir_yields_empty_catalog() {
        let catalog = scan(Path::new("/nonexistent-omp-inn-scripts"), "/w/x");
        assert!(catalog.ecosystems.is_empty());
        assert!(catalog.scripts.is_empty());
    }
}
