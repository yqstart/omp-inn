use serde::{Deserialize, Serialize};

pub const OVERLAY_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Project {
    pub id: String,
    pub path: String,
    #[serde(default)]
    pub added_at: i64,
    #[serde(default)]
    pub last_model: Option<String>,
    #[serde(default)]
    pub last_thinking: Option<String>,
    /// 所属工作区（V21 多项目容器）；None = 未分组（不参与任何工作区协作）。
    #[serde(default)]
    pub workspace_id: Option<String>,
}

/// 工作区（V21）：多项目容器。
///
/// 成员关系存在 `Project.workspace_id` 上（一个项目最多属于一个工作区），
/// 这里只存容器本身（id / 名字 / 创建时间）——删组时成员自然回归未分组，
/// 不存在「组里残留已删项目」的悬空列表要维护。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Overlay {
    pub version: u32,
    #[serde(default)]
    pub projects: Vec<Project>,
    /// 工作区容器（V21）；旧文件没有这个字段 → 默认空（全部项目未分组）。
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(default)]
    pub archived: std::collections::HashMap<String, bool>,
    #[serde(default)]
    pub notes: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub session_approval: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub omp_path: Option<String>,
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Default for Overlay {
    fn default() -> Self {
        Self {
            version: OVERLAY_VERSION,
            projects: vec![],
            workspaces: vec![],
            archived: Default::default(),
            notes: Default::default(),
            session_approval: Default::default(),
            omp_path: None,
            extra: Default::default(),
        }
    }
}

impl Overlay {
    pub fn normalize(mut self) -> (Self, bool) {
        if self.version != OVERLAY_VERSION {
            return (Self { omp_path: self.omp_path, ..Self::default() }, true);
        }
        // 去重项目（按规范化路径保留首个）
        let mut seen = std::collections::HashSet::new();
        self.projects.retain(|p| seen.insert(normalize_path(&p.path)));
        // 去重工作区（按 id 保留首个）
        let mut ws_seen = std::collections::HashSet::new();
        self.workspaces.retain(|w| ws_seen.insert(w.id.clone()));
        // 悬空归属（工作区已被删、项目还记着 id）→ 回归未分组，
        // 否则左栏会出现「渲染不出来但归属又不是 null」的幽灵成员。
        let ids: std::collections::HashSet<String> = self.workspaces.iter().map(|w| w.id.clone()).collect();
        for p in &mut self.projects {
            if let Some(w) = &p.workspace_id {
                if !ids.contains(w) {
                    p.workspace_id = None;
                }
            }
        }
        (self, false)
    }
}

pub fn normalize_path(p: &str) -> String {
    let mut s = p.trim().to_string();
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_mismatch_resets_but_keeps_omp_path() {
        let ov = Overlay { version: 99, omp_path: Some("/x/omp".into()), ..Overlay::default() };
        let (n, reset) = ov.normalize();
        assert!(reset);
        assert_eq!(n.version, 1);
        assert_eq!(n.omp_path.as_deref(), Some("/x/omp"));
    }

    #[test]
    fn dedup_projects_by_path() {
        let ov = Overlay {
            version: 1,
            projects: vec![
                Project { id: "p1".into(), path: "/a/".into(), added_at: 1, ..Default::default() },
                Project { id: "p2".into(), path: "/a".into(), added_at: 2, ..Default::default() },
            ],
            ..Overlay::default()
        };
        let (n, _) = ov.normalize();
        assert_eq!(n.projects.len(), 1);
    }

    #[test]
    fn dedup_workspaces_and_clear_dangling_membership() {
        let ov = Overlay {
            version: 1,
            projects: vec![
                Project { id: "p1".into(), path: "/a".into(), workspace_id: Some("w1".into()), ..Default::default() },
                Project { id: "p2".into(), path: "/b".into(), workspace_id: Some("ghost".into()), ..Default::default() },
            ],
            workspaces: vec![
                Workspace { id: "w1".into(), name: "全栈".into(), created_at: 1 },
                Workspace { id: "w1".into(), name: "重复".into(), created_at: 2 },
            ],
            ..Overlay::default()
        };
        let (n, reset) = ov.normalize();
        assert!(!reset);
        assert_eq!(n.workspaces.len(), 1);
        assert_eq!(n.workspaces[0].name, "全栈");
        // 有效归属保留，悬空归属清掉
        assert_eq!(n.projects[0].workspace_id.as_deref(), Some("w1"));
        assert_eq!(n.projects[1].workspace_id, None);
    }
}
