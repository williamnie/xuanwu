# PI Assistant CLI Connector Manifest v0

> 状态：P02.01 v0 规范。范围只覆盖 manifest 解析与校验，不包含 CLI 执行器、注册到 Tool Registry、健康 UI/API。

## 目标

任何本地或沙箱内 CLI 都可以通过同一份 manifest 描述为 PI Assistant 的 `cli` Tool Provider。manifest 不绑定钉钉、飞书、GitHub 或其它具体供应商；供应商语义应留在 CLI 自己的命令和输出 JSON 中。

## 顶层字段

```ts
type CliConnectorManifest = {
  manifest_version: 'pi-cli-connector.v0'
  id: string
  name: string
  kind: 'cli'
  description?: string
  auth?: { type: 'none' | 'env' | 'oauth' | 'custom'; env?: string[] }
  env?: Array<{ name: string; required?: boolean; secret?: boolean; description?: string }>
  timeout?: { default_ms?: number; max_ms?: number }
  health: CliConnectorHealth
  commands: CliCommand[]
}
```

- `id` 使用小写字母、数字、`.`、`_`、`-`，作为 provider id。
- `auth` 只声明认证方式和需要的 env 名称，不保存 token/value/default。
- `env` 只声明变量名、是否必填、是否 secret；真实值由运行环境提供。
- `timeout.default_ms` 是默认执行超时；`timeout.max_ms` 是单命令允许的上限。
- `health` 是轻量健康检查命令，必须输出 JSON。
- `commands` 至少一项，每项会在后续阶段映射为 `AssistantTool`。

## 命令字段

```ts
type CliCommand = {
  name: string
  description: string
  permission: 'read' | 'write' | 'dangerous'
  command: { executable: string; args?: string[] }
  input_schema: object
  output_schema: object
  stdout: { mode: 'json' }
  exit_codes: {
    success: number[]
    retryable?: number[]
    auth_required?: number[]
    usage_error?: number[]
  }
  stderr?: { summary: 'first_line' | 'last_line' | 'tail' | 'none'; max_bytes?: number }
  cursor?: { input_field?: string; output_field?: string }
  idempotency?: { input_field: string }
  timeout_ms?: number
}
```

## Command template 安全规则

- `command.executable` 是可执行文件名或路径，不是 shell 字符串；不得依赖 `sh -c`。
- `command.args` 是 argv 数组；执行器必须以参数数组启动进程，不做 shell 拼接。
- 参数模板只允许 `{{input.field}}`，且 `field` 必须存在于 `input_schema.properties`。
- 模板渲染后的值作为单个 argv 参数传递，由执行器做安全转义/无 shell 调用；manifest 不允许绕过 schema 直接拼命令。

## CLI 输出契约

- stdout 必须是结构化 JSON；`stdout.mode` 当前只支持 `json`。
- 成功 exit code 必须稳定，`exit_codes.success` 必须包含 `0`。
- 常见非成功 exit code 应分类到：
  - `retryable`：临时错误、限流、网络波动。
  - `auth_required`：缺 token、token 失效、权限不足。
  - `usage_error`：参数错误、schema 与 CLI 不兼容。
- stderr 只作为摘要和诊断，不承载业务数据；执行器只应保存 `stderr.summary` 指定的短摘要。
- 增量同步命令应通过 `cursor.input_field` / `cursor.output_field` 暴露 cursor/watermark。
- 可能重复调用的命令必须支持 idempotency；manifest 用 `idempotency.input_field` 声明输入字段。

## Fixture

示例 manifest：`docs/fixtures/pi-cli-connector-manifest-v0.fixture.json`。

解析/校验入口：`backend-ts/src/pi/cliConnectorManifest.ts`。
