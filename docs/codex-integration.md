# Codex 集成说明

目标：让 Codex 通过本地 CLI 创建 issue，并交给 Codex Issue Runner 的 auto-run loop 自动执行。

## 前置条件

1. 后端服务保持运行：

```bash
codex-issue-runner serve --addr 127.0.0.1:3008 --db ~/.codex-issue-runner/app.db
```

2. 每个目标仓库先注册为 project，建议开启 auto-run：

```bash
codex-issue-runner project create \
  --id movo-web \
  --cwd /Users/xiaobei/Documents/rcrai/movo-web \
  --auto-run \
  --json
```

## Codex 创建 issue 的推荐命令

Codex 在需要把任务交给 runner 时，把完整需求写入临时 markdown 文件，然后执行：

```bash
codex-issue-runner issue create \
  --project <project-id> \
  --title "<一句话标题>" \
  --body-file /tmp/codex-issue.md \
  --run \
  --json
```

返回 JSON 中的 `id` 是 runner 内部 issue id；`status=todo` 表示已入队。如果项目开启 `auto_run=1`，后端会自动启动项目 loop 并调用 `codex app-server` 执行。

## 常用查询

```bash
codex-issue-runner issue status --id <issue-id> --json
codex-issue-runner issue logs --id <issue-id>
codex-issue-runner issue retry --id <issue-id> --json
codex-issue-runner issue cancel --id <issue-id> --json
```

## Codex 使用约定

- 只把明确可执行的任务写入 issue；不要把含糊的讨论直接入队。
- `--title` 保持短句；完整上下文放在 `--body-file`。
- 需要自动执行时必须带 `--run`，并确保 project 已开启 `auto_run`。
- CLI 默认读取 `CODEX_RUNNER_ADDR`；没有环境变量时连接 `127.0.0.1:3008`。
