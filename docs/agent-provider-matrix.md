# Agent Provider Matrix

当前 live 后端为 Bun/TypeScript，provider 以可插拔 executor 形式接入。

## Provider 状态

| Provider | 状态 | 用途 |
| --- | --- | --- |
| Codex | tested | 默认完整 Provider；真实 issue execution、sessions、resume、interrupt 与交付链路已经过测试 |
| Claude / Claude Code | preview / not live-tested | SDK 与显式 CLI fallback 已实现，并有自动化测试；真实账号端到端链路尚未完成 live acceptance |

状态必须反映实际验收层级：adapter 存在或自动化测试通过，不等于真实 Provider 已完成端到端验收。
Claude / Claude Code 在 live acceptance 完成前不得标记为 `tested` 或 production-validated。

## 计划接入

| 顺序 | Provider | 当前状态 |
| --- | --- | --- |
| 1 | Kimi Code | planned / not implemented |
| 2 | Pi | planned / not implemented |
| 3 | zcode | planned / not implemented |
| 4 | OpenCode | planned / not implemented |

## 通用要求

- provider run completed 不等于 issue done。
- issue 执行必须通过 Runner CLI/API 显式回写 `done` / `failed` / `pending_verification`。
- provider status 统一从 `/api/system/status.providers` 暴露。
- token / API key 不得写入日志、issue、截图或文档。

## 验证

```bash
cd backend-ts
bun test src/providers src/http/systemStatus.test.ts
```
