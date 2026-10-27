//! 项目路径跟随外部改名（2026-10-27 用户口径）。
//!
//! 项目名 = 覆盖层路径的末段目录名（见 `commands::project_views`）。用户在其他应用 /
//! 终端里重命名项目目录（或它的任一上级目录）后，旧路径失效，左栏只能显示「目录缺失」
//! ——不会自己知道新名字。这里用**目录身份链**把项目找回来：
//!
//! - 每个项目在覆盖层里存一条 `path_ids`：从挂载根到项目目录，逐级记录目录身份
//!   （Unix = `dev:ino`；Windows = volume serial + file index）。
//! - 路径失联时，从根目录开始逐级扫描当前目录的子项，按身份匹配下一级——名字变了也
//!   能跟着走；不按名字猜，避免把「新目录恰好同名」错认成旧项目。
//! - 身份链只在项目路径存在时刷新；失联且找不回时保留旧链，等下一次（或用户手动重定位）。
//!
//! 边界（都是刻意的）：
//! - **只跟随改名，不跟随改变父目录的移动**：每一级都在原父目录里按身份找；把项目拖到
//!   另一个目录后链会断，按缺失处理，继续走原来的「重定位」按钮。跨卷改名同样不跟随
//!   （身份会变）。
//! - **只读目录元数据**：不碰会话 jsonl，也不改任何会话的 `cwd`。旧会话仍指向旧目录，
//!   壳侧不会替 omp 重写历史；项目本身按新路径继续用，旧会话由用户自行处理。
//! - **没有身份链的老覆盖层**（功能上线前就失联的项目）：无法证明新旧路径是同一个，
//!   保持缺失，继续走原来的「重定位」按钮。
//! - 目录身份只存本地覆盖层，不参与展示，也不写 omp 配置。

use std::path::{Component, Path, PathBuf};

use crate::overlay::{normalize_path, Overlay};

/// 目录身份：同一挂载卷内，目录改名后保持不变。
///
/// Unix 用 `dev:ino`；Windows 用卷序列号 + 文件索引。拿不到元数据 / 不是目录 → `None`。
#[cfg(unix)]
fn directory_identity(path: &Path) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let md = std::fs::metadata(path).ok()?;
    if !md.is_dir() || md.ino() == 0 {
        return None;
    }
    Some(format!("{}:{}", md.dev(), md.ino()))
}

#[cfg(windows)]
fn directory_identity(path: &Path) -> Option<String> {
    use std::os::windows::fs::MetadataExt;
    let md = std::fs::metadata(path).ok()?;
    if !md.is_dir() {
        return None;
    }
    Some(format!("{}:{}", md.volume_serial_number()?, md.file_index()?))
}

#[cfg(not(any(unix, windows)))]
fn directory_identity(_path: &Path) -> Option<String> {
    None
}

/// 从挂载根到 `path` 的逐级目录身份；任一级不是目录 / 读不到元数据 → `None`。
///
/// 相对路径不参与（覆盖层里的项目路径都来自系统目录选择器，应为绝对路径；防御式忽略）。
pub fn path_chain(path: &Path) -> Option<Vec<String>> {
    if !path.is_absolute() {
        return None;
    }
    let mut cur = PathBuf::new();
    let mut out = Vec::new();
    for comp in path.components() {
        cur.push(comp.as_os_str());
        match comp {
            Component::Normal(_) => out.push(directory_identity(&cur)?),
            Component::Prefix(_) | Component::RootDir | Component::CurDir => {}
            Component::ParentDir => return None,
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// `path` 的挂载根（`/` 或 `C:\`）。身份链从根开始逐级匹配，需要它作为起点。
fn root_of(path: &Path) -> PathBuf {
    let mut root = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Prefix(_) | Component::RootDir => root.push(comp.as_os_str()),
            _ => break,
        }
    }
    root
}

/// 按身份链从根目录逐级找回目录；任意一级找不到 → `None`。
///
/// 只扫描每级当前目录的直接子项，不做全盘递归：链长 = 路径深度，代价与目录项数量成正比。
pub fn resolve_renamed_path(old_path: &Path, chain: &[String]) -> Option<PathBuf> {
    if chain.is_empty() || !old_path.is_absolute() {
        return None;
    }
    let mut cur = root_of(old_path);
    for id in chain {
        let mut hit = None;
        let Ok(entries) = std::fs::read_dir(&cur) else {
            return None;
        };
        for entry in entries.flatten() {
            let candidate = entry.path();
            if directory_identity(&candidate).as_deref() == Some(id.as_str()) {
                hit = Some(candidate);
                break;
            }
        }
        cur = hit?;
    }
    Some(cur)
}

/// 刷新单个项目的身份链；返回是否有变化。
fn refresh_chain(project: &mut crate::overlay::Project) -> bool {
    let Some(chain) = path_chain(Path::new(&project.path)) else {
        return false;
    };
    if project.path_ids == chain {
        return false;
    }
    project.path_ids = chain;
    true
}

/// 对账一次覆盖层里的项目路径。
///
/// 1. 路径存在：不处理（稍后刷新身份链）。
/// 2. 路径失联且旧链可用：按链找回新路径；目标路径已被另一个项目占用则不动（避免两项目同路径）。
/// 3. 所有能读出目录的项目刷新 `path_ids`。
///
/// 返回**覆盖层是否被修改**（调用方据此决定是否写盘 / 是否让前端重拉）。
pub fn sync_project_paths(overlay: &mut Overlay) -> bool {
    let mut changed = false;

    // 先做只读的找回计划，避免边改边查造成借用 / 误判。
    let mut updates: Vec<(usize, String)> = Vec::new();
    for (idx, project) in overlay.projects.iter().enumerate() {
        if directory_identity(Path::new(&project.path)).is_some() {
            continue;
        }
        let Some(found) = resolve_renamed_path(Path::new(&project.path), &project.path_ids) else {
            continue;
        };
        let new_path = normalize_path(&found.to_string_lossy());
        let occupied = overlay
            .projects
            .iter()
            .any(|other| other.id != project.id && normalize_path(&other.path) == new_path);
        if !occupied {
            updates.push((idx, new_path));
        }
    }
    for (idx, new_path) in updates {
        overlay.projects[idx].path = new_path;
        changed = true;
    }

    for project in &mut overlay.projects {
        changed |= refresh_chain(project);
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overlay::{Overlay, Project};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(tag: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!(
            "omp-project-paths-{}-{tag}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn project(id: &str, path: &Path) -> Project {
        Project {
            id: id.into(),
            path: path.to_string_lossy().to_string(),
            path_ids: path_chain(path).unwrap_or_default(),
            ..Default::default()
        }
    }

    #[test]
    fn follows_leaf_rename_by_identity() {
        let root = temp_root("leaf");
        let dir = root.join("alpha");
        fs::create_dir_all(&dir).unwrap();
        let renamed = root.join("beta");
        let mut ov = Overlay {
            projects: vec![project("p1", &dir)],
            ..Default::default()
        };

        fs::rename(&dir, &renamed).unwrap();
        assert!(sync_project_paths(&mut ov));
        assert_eq!(Path::new(&ov.projects[0].path), renamed.as_path());
        assert_eq!(ov.projects[0].path_ids, path_chain(&renamed).unwrap());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn follows_renamed_ancestor() {
        let root = temp_root("ancestor");
        let old_parent = root.join("old");
        let dir = old_parent.join("proj");
        fs::create_dir_all(&dir).unwrap();
        let new_parent = root.join("new");
        let mut ov = Overlay {
            projects: vec![project("p1", &dir)],
            ..Default::default()
        };

        fs::rename(&old_parent, &new_parent).unwrap();
        assert!(sync_project_paths(&mut ov));
        assert_eq!(
            Path::new(&ov.projects[0].path),
            new_parent.join("proj").as_path()
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unrelated_same_name_dir_does_not_match() {
        let root = temp_root("same-name");
        let old = root.join("work").join("proj");
        fs::create_dir_all(&old).unwrap();
        let mut ov = Overlay {
            projects: vec![project("p1", &old)],
            ..Default::default()
        };

        // 从旧项目位置删掉，再在别处建一个同名目录：身份不同，不许认领。
        fs::remove_dir_all(root.join("work")).unwrap();
        let decoy = root.join("other").join("proj");
        fs::create_dir_all(&decoy).unwrap();
        assert!(!sync_project_paths(&mut ov));
        assert_eq!(Path::new(&ov.projects[0].path), old.as_path());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn old_overlay_without_chain_stays_missing() {
        let root = temp_root("old-overlay");
        let dir = root.join("alpha");
        fs::create_dir_all(&dir).unwrap();
        let mut ov = Overlay {
            projects: vec![Project {
                id: "p1".into(),
                path: dir.to_string_lossy().to_string(),
                path_ids: vec![],
                ..Default::default()
            }],
            ..Default::default()
        };

        fs::rename(&dir, root.join("beta")).unwrap();
        assert!(!sync_project_paths(&mut ov));
        assert_eq!(Path::new(&ov.projects[0].path), dir.as_path());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn existing_path_refreshes_chain() {
        let root = temp_root("chain");
        let dir = root.join("alpha");
        fs::create_dir_all(&dir).unwrap();
        let mut ov = Overlay {
            projects: vec![Project {
                id: "p1".into(),
                path: dir.to_string_lossy().to_string(),
                path_ids: vec![],
                ..Default::default()
            }],
            ..Default::default()
        };

        assert!(sync_project_paths(&mut ov));
        assert_eq!(ov.projects[0].path_ids, path_chain(&dir).unwrap());
        // 第二次没有变化
        assert!(!sync_project_paths(&mut ov));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn occupied_target_is_not_claimed() {
        let root = temp_root("occupied");
        let a = root.join("a");
        let b = root.join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        let b_chain = path_chain(&b).unwrap();
        let mut ov = Overlay {
            projects: vec![project("p1", &a), project("p2", &b)],
            ..Default::default()
        };

        fs::remove_dir_all(&a).unwrap();
        // 手工把 a 的链改成指向 b，模拟脏数据 / 伪造：已被 p2 占用的路径不许被 p1 认领。
        ov.projects[0].path_ids = b_chain;
        assert!(!sync_project_paths(&mut ov));
        assert_eq!(Path::new(&ov.projects[0].path), a.as_path());
        assert_eq!(Path::new(&ov.projects[1].path), b.as_path());
        let _ = fs::remove_dir_all(&root);
    }
}
