# Agent Provider Matrix

当前 live 后端为 Bun/TypeScript，provider 以可插拔 executor 形式接入。

## Provider 状态

| Provider | 状态 | 用途 |
| --- | --- | --- |
| Codex | available | issue execution、sessions、resume、interrupt、approvals、model list |
| Claude | available | issue execution |

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
