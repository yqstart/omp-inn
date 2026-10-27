## 摘要

简要说明本次变更解决什么问题、为什么需要。

## 变更类型

- [ ] Bug 修复
- [ ] 新功能
- [ ] 文档
- [ ] 重构（无行为变化）
- [ ] CI / 工程杂项

## 测试

- [ ] `pnpm build` 通过
- [ ] `pnpm typecheck && pnpm test && pnpm e2e:ipc` 通过
- [ ] （若改 Rust）`cargo test --manifest-path src-tauri/Cargo.toml` 通过
- [ ] 已在本地 `pnpm tauri:dev` 验证相关路径

## 关联

Closes #

## 备注

UI 变更请附截图；架构变更请同步 `docs/` 对应文档（新增硬约束同步 `AGENTS.md` 铁律）。范围外需求请先确认是否纳入。
