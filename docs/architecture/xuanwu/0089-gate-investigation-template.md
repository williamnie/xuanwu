# ADR-XW-0089：Freshness Gate 调研记录模板（G0/G10/G11）

- 关联：0089 Provider Core 多 Coding Agent 重构 [计划](0089-provider-core-multi-code-agent-refactor-plan.md)
- 用途：每次接入外部 Provider（G0 目标合同覆盖、G10 Pi、G11 Qoder）前按本模板记录证据；依赖或官方协议变化时**重跑**本 Gate，不沿用旧记录。
- 已完成示例：G10 → `0089-g10-pi-freshness-gate.md`。

## 1. 版本与官方来源

| 项 | 证据 |
| --- | --- |
| 产品 / CLI / SDK / package 名称 | |
| 精确版本 | （命令/包管理输出） |
| 官方来源 | （官方文档 URL / 类型定义路径 / npm registry） |
| 安装形态与路径 | |
| 平台与许可证边界 | |
| 调研日期 | |

## 2. headless transport

- [ ] 结构化 headless execution：传输协议（stdio-json / RPC / SDK）、framing、并发模型。
- [ ] 可信 terminal signal：终态事件/退出码/终态 JSON。
- [ ] invocation ref：稳定引用语义（command id / session id / 终态关联键）。

## 3. Session/ref 语义

- [ ] session 创建/恢复/fork（tree session? parentSession?）。
- [ ] message/turn/cursor ref 稳定性与恢复语义。
- [ ] resume 是否强制上一 message ref。

## 4. 控制流

- [ ] interrupt/abort、steer/follow_up。
- [ ] approval/permission callback（host-callback? native?）。
- [ ] model list / usage / cost 查询。

## 5. 认证与本地配置

- [ ] 本地登录/配置复用方式与 credential authority。
- [ ] 非交互权限能否等价或更严格地映射 `ExecutionPolicy`。

## 6. 硬门槛判定（计划 §17.2）

| 硬门槛 | 证据 | 通过 |
| --- | --- | --- |
| 结构化 headless execution | | ☐ |
| 可信 terminal signal | | ☐ |
| 安全 policy 映射 | | ☐ |
| 稳定 invocation ref | | ☐ |

任一缺失 → 不进入 adapter 实现；缺失能力只作为 capability-limited Provider，不伪造。

## 7. 已知版本风险

- [ ] 不支持能力、已知版本风险、fixture 方案、退出条件。
- [ ] 依赖版本变更后重跑本 Gate 的触发规则。
