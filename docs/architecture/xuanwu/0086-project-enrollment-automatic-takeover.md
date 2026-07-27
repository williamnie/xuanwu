# ADR-XW-0086：Project 注册即自动接管

- 状态：Accepted
- 日期：2026-07-27
- 依赖：[ADR-XW-0001](0001-product-positioning.md)
- 决策范围：Project 注册、Supervisor 绑定与 Issue Loop 默认状态

## 决策

玄武不提供脱离 Supervisor 的 inert Project。Project 一旦通过 UI、CLI、REST API 或 Codex workspace 同步注册，即表示用户将该工程目录交给玄武控制面：

1. 自动创建 `project_pi_settings` 绑定；
2. 自动设置 `projects.auto_run=1`，进入 Issue Loop；
3. 确保 singleton Supervisor 已启用；
4. UI 和 CLI 不再提供 PI 接管或 `auto-run` 开关；
5. 需要阻止推进时使用 project hold、Attention、Approval 或删除 Project，不再靠“保留 Project 但关闭产品核心能力”的半接入状态。

当前兼容期内，`project_pi_settings` 的 presence 与 `projects.auto_run` 仍是运行时 authority。Project create、update 和 Codex sync 必须原子地重申这两个事实，不能依赖前端创建后再补第二次绑定写入。

## 迁移与兼容

`061_project_mandatory_takeover` 将现有 Project 全部设为 `auto_run=1`，并为缺失的 Project 补齐 presence-only PI binding；迁移幂等，不创建新的项目状态机。

历史 `/loop/start`、`/loop/stop` 与 `DELETE /pi-settings` 暂作为 compatibility routes 保留，但不再由产品 UI 或 CLI 暴露，也不构成新的产品合同。后续只有通过 consumer-zero、route inventory、回滚观察窗和 P11 删除门禁后才能物理移除。

## 回滚与验证

- 数据库回滚遵循 [0070 数据库迁移演练与兼容门禁](0070-db-migration-rehearsal-gate.md)，从 forward 前 fresh backup 恢复，不在 live SQLite 上逆向猜测旧状态。
- 定向验证必须覆盖：API create/update 强制接管、Codex sync 创建与修复、旧 Project 迁移、CLI 不再发送 `auto_run`、Projects 页面无 opt-out 控件。
- 部署前仍需在隔离 DB 副本完成 migration preflight/forward/rollback；本 ADR 不授权隐式 live 迁移或无备份部署。
