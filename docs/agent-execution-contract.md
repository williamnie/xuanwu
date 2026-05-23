# Agent Execution Contract

本文定义 Codex Issue Runner 的 provider-neutral issue 执行契约。它适用于 Codex、Claude、opencode、kimicode 或其他后续 agent/provider。

## 最终状态必须显式回写

agent/provider 处理 runner issue 时，不能只依赖模型回复、turn completed、代码修改或本地验证结果。完成直接相关验证后，必须显式把 issue 更新为终态：

- 成功：`done`
- 失败或阻塞：`failed`，并写入简短 `error`

Runner 不会根据 agent/provider 的自然语言回复自动判断完成态。

## 首选 CLI 回写

成功时：

```bash
codex-issue-runner issue update --id <issue-id> --status done --json
```

失败或阻塞时：

```bash
codex-issue-runner issue update --id <issue-id> --status failed --error "<failure reason>" --json
```

## Auth/token 规则

如果 Runner API 启用了 bearer token：

1. 不要硬编码、打印、提交或粘贴 token 值。
2. 优先使用已有的 `CODEX_RUNNER_AUTH_TOKEN`。
3. 其次读取 `CODEX_RUNNER_AUTH_TOKEN_FILE` 指向的 token 文件。
4. 源码部署常见 token 文件是 `data/auth_token`。
5. release 或其他项目使用对应 runner 的 state/data 目录，不要假设都在当前仓库。
6. CLI 可用 `--token "$(cat <token-file>)"` 显式传入 token。

示例：

```bash
if [ -z "${CODEX_RUNNER_AUTH_TOKEN:-}" ]; then
  if [ -n "${CODEX_RUNNER_AUTH_TOKEN_FILE:-}" ] && [ -f "$CODEX_RUNNER_AUTH_TOKEN_FILE" ]; then
    export CODEX_RUNNER_AUTH_TOKEN="$(cat "$CODEX_RUNNER_AUTH_TOKEN_FILE")"
  elif [ -f data/auth_token ]; then
    export CODEX_RUNNER_AUTH_TOKEN="$(cat data/auth_token)"
  fi
fi

codex-issue-runner issue update --id <issue-id> --status done --json
```

## API 等价回写

如果当前 provider 不能执行 CLI，必须通过 Runner HTTP API 做等价更新。

成功时：

```bash
curl -fsS -X PATCH "http://${CODEX_RUNNER_ADDR:-127.0.0.1:3008}/api/issues/<issue-id>" \
  -H "Authorization: Bearer ${CODEX_RUNNER_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"status":"done"}'
```

失败或阻塞时：

```bash
curl -fsS -X PATCH "http://${CODEX_RUNNER_ADDR:-127.0.0.1:3008}/api/issues/<issue-id>" \
  -H "Authorization: Bearer ${CODEX_RUNNER_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"status":"failed","error":"<failure reason>"}'
```

无论使用 CLI 还是 API，agent/provider 都必须先完成直接相关验证，再回写 `done`。
