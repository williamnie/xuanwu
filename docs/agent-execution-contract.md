# Agent Execution Contract

本文定义 Codex Issue Runner 的 provider-neutral issue 执行契约。它适用于 Codex、Claude、opencode、kimicode 或其他后续 agent/provider。

## 最终状态必须显式回写

agent/provider 处理 runner issue 时，不能只依赖模型回复、turn completed、代码修改或本地验证结果。完成直接相关验证后，必须显式把 issue 更新为终态：

- 成功：`done`
- 失败或阻塞：`failed`，并写入简短 `error`

Runner 不会根据 agent/provider 的自然语言回复自动判断完成态。

## 可选 verification gate

项目或执行 profile 可开启 verification gate。开启后，agent/provider 完成实现与直接相关验证时，不应把 issue 直接最终 `done`，而应提交验证证据并进入待验证：

```bash
codex-issue-runner issue update --id <issue-id> --status pending_verification --error "<verification evidence summary>" --json
```

兼容迁移规则：

- 未开启 gate 的 issue 保持原契约：成功 `done`，失败 `failed`。
- 开启 gate 且 issue 仍在 `in_progress` 时，如果旧 agent 仍回写 `done`，Runner API 会把它改写为 `pending_verification`，并保留 `error` 中的验证证据或默认待验证说明。
- `pending_verification` 会关闭当前 run，但不是最终验收态；queue claim 不会再次领取它。
- 人工或 verifier 可在 UI 中执行 Accept / Reject / Request changes，或调用 API：
  - Accept → `done`
  - Reject → `failed`
  - Request changes → `triage`
- 待验证 issue 需要重新执行时，可 retry/enqueue 回 `todo`，这会开启下一轮 run。

开启方式 v1：

- project `provider_config_json` 中设置 `{"verification_gate": true}` 或 `{"verification_required": true}`。
- 或在默认 Agent Profile instructions 中包含 `verification_gate` 标记。

## 首选 CLI 回写

成功时：

```bash
codex-issue-runner issue update --id <issue-id> --status done --json
```

开启 verification gate 时，成功路径改为：

```bash
codex-issue-runner issue update --id <issue-id> --status pending_verification --error "<verification evidence summary>" --json
```

失败或阻塞时：

```bash
codex-issue-runner issue update --id <issue-id> --status failed --error "<failure reason>" --json
```

待验证处理也可通过 CLI 操作：

```bash
codex-issue-runner issue accept --id <issue-id> --json
codex-issue-runner issue reject --id <issue-id> --comment "<reject reason>" --json
codex-issue-runner issue request-changes --id <issue-id> --comment "<changes requested>" --json
```

## Auth/token 规则

如果 Runner API 启用了 bearer token：

1. 不要硬编码、打印、提交或粘贴 token 值。
2. 优先使用已有的 `CODEX_RUNNER_AUTH_TOKEN`。
3. 其次读取 `CODEX_RUNNER_AUTH_TOKEN_FILE` 指向的 token 文件。
4. Go stable 源码部署常见 token 文件是 `data/auth_token`。
5. Bun preview 使用独立 token 环境变量 `CODEX_RUNNER_BUN_AUTH_TOKEN` / `CODEX_RUNNER_BUN_AUTH_TOKEN_FILE`，默认 token 文件是 `data-bun/auth_token`。
6. release 或其他项目使用对应 runner 的 state/data 目录，不要假设都在当前仓库。
7. CLI 可用 `--token-file <token-file>` 传路径，或用 `--token "$(cat <token-file>)"` 显式传入 token；文档、issue、日志里不要输出实际 token。

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

并行预览期运行目标必须明确区分：Go stable 仍走 `127.0.0.1:3008`、`data/`、`com.xiaobei.codex-issue-runner`；Bun preview 走 `127.0.0.1:3018`、`data-bun/runner.db`、`com.xiaobei.codex-issue-runner-bun`。不要让 Bun preview 抢占 Go stable 端口或直接写 Go stable 正在使用的 `data/runner.db`。

最小 smoke：

```bash
curl -fsS http://127.0.0.1:3008/health
codex-issue-runner system status --addr 127.0.0.1:3008 --token-file data/auth_token --json
curl -fsS http://127.0.0.1:3018/health
./dist/codex-issue-runner-bun system status --addr 127.0.0.1:3018 --token-file data-bun/auth_token --json
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

开启 verification gate 时：

```bash
curl -fsS -X PATCH "http://${CODEX_RUNNER_ADDR:-127.0.0.1:3008}/api/issues/<issue-id>" \
  -H "Authorization: Bearer ${CODEX_RUNNER_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"status":"pending_verification","error":"<verification evidence summary>"}'
```

失败或阻塞时：

```bash
curl -fsS -X PATCH "http://${CODEX_RUNNER_ADDR:-127.0.0.1:3008}/api/issues/<issue-id>" \
  -H "Authorization: Bearer ${CODEX_RUNNER_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"status":"failed","error":"<failure reason>"}'
```

无论使用 CLI 还是 API，agent/provider 都必须先完成直接相关验证，再回写 `done`。
开启 verification gate 时，上述要求对应为先完成直接相关验证，再回写 `pending_verification`。
