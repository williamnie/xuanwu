# Agent Execution Contract

agent/provider 处理 runner issue 时，不能只依赖模型回复、turn completed、代码修改或本地验证结果。完成直接相关验证后，必须显式把 issue 更新为终态：

- `done`：直接相关验证通过。
- `failed`：执行失败、验证失败或明确无法完成。
- `pending_verification`：代码/文档修改已完成，但仍需要外部验证或人工验收。
- `cancelled`：用户或系统取消。

## 基本规则

1. provider run completed 不等于 issue done。
2. issue 最终状态必须通过 Runner CLI 或 HTTP API 显式回写。
3. 回写前必须完成当前任务直接相关的最小验证。
4. 验证证据应写入 issue comment、status error 字段或运行日志摘要。
5. token 只能通过 `--token-file`、`XUANWU_AUTH_TOKEN_FILE`、临时 curl config 或内存环境变量传递，不得输出实际 token。

## Runtime target

Bun live 默认入口：

```bash
export XUANWU_ADDR=${XUANWU_ADDR:-127.0.0.1:3008}
```

常用只读状态检查：

```bash
curl -fsS http://127.0.0.1:3008/health
./dist/xuanwu system status --addr 127.0.0.1:3008 --token-file <state-dir>/auth_token --json
```

## CLI 回写示例

```bash
./dist/xuanwu issue update \
  --addr "${XUANWU_ADDR:-127.0.0.1:3008}" \
  --token-file "$XUANWU_AUTH_TOKEN_FILE" \
  --id <issue-id> \
  --status done \
  --json
```

失败：

```bash
./dist/xuanwu issue update \
  --addr "${XUANWU_ADDR:-127.0.0.1:3008}" \
  --token-file "$XUANWU_AUTH_TOKEN_FILE" \
  --id <issue-id> \
  --status failed \
  --error "<failure reason>" \
  --json
```

## API 回写示例

```bash
curl -fsS -X PATCH "http://${XUANWU_ADDR:-127.0.0.1:3008}/api/issues/<issue-id>" \
  -H "Authorization: Bearer ${XUANWU_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"status":"done"}'
```

开启 verification gate 时，先回写 `pending_verification`：

```bash
curl -fsS -X PATCH "http://${XUANWU_ADDR:-127.0.0.1:3008}/api/issues/<issue-id>" \
  -H "Authorization: Bearer ${XUANWU_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"status":"pending_verification","error":"<verification evidence summary>"}'
```

无论使用 CLI 还是 API，agent/provider 都必须先完成直接相关验证，再回写 `done`。
