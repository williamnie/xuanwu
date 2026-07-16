# ADR-XW-0030：HTTP/API Evidence verifier

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P04.04 / Runner #666
- 依赖：[ADR-XW-0027](0027-evidence-domain-contract.md)
- 可执行 verifier：`backend-ts/src/domain/evidence/httpVerifier.ts`
- canonical 级别：本文定义 read-only HTTP observation、断言和 bounded artifact 到 `EvidenceRecord(kind=http)` 的边界；共享 Evidence schema、状态和完成门禁资格仍以 ADR-XW-0027 与 `contracts.ts` 为准

## 1. 当前运行态与边界

Runner 已有 `http-readonly:url_fetch`，用于 PI 读取 bounded URL context，并经 `ToolInvocation` / `ToolResult` 与 tool-call audit envelope 执行。它不保存 request header、response header 或结构化断言结果，因此不能把 `evidence_ref`、HTTP 200 或 Agent 对响应的总结直接升级为完成证明。

P04.04 新增 provider-neutral 的 `HttpEvidenceVerifier`：调用方提交 canonical `ToolInvocation`、request spec、assertions 和 Evidence/audit context；verifier 只接受固定的 `http-readonly:http_evidence_verify`、`permission=read`、`GET|HEAD`，执行 bounded observation 后生成 P04.01 `EvidenceRecord`。本期不把新 verifier 注册为 Assistant tool，不修改 `url_fetch` 的公共 input/output schema，也不修改 Issue/Work/Run 状态。

这条边界避免 LLM 通过声称 permission、status、header 或业务值来伪造验证。P04.06 才声明 workflow 需要哪些 HTTP assertion，P04.07 才把 policy 接到 `done` mutation，P04.09 才负责 Evidence persistence/API/UI。

## 2. Request spec 与 permission envelope

`createHttpEvidenceInvocation()` 生成共享 `ToolInvocation` envelope；verifier 在任何网络请求前执行 `validateToolInvocation()` 并固定检查 provider、tool 与 read permission。request spec 包含：

- `url`：仅 `http|https`，长度不超过 4096；URL userinfo 拒绝；
- `method`：仅 `GET|HEAD`；POST/PUT/PATCH/DELETE 不得借验证路径绕过 write/dangerous permission、外部写审计或 approval；
- `headers`：最多 32 个，name/value/CRLF 与单值 8 KiB 上限先校验；允许调用方在既有授权边界提供 credential，但不会把值写入 Evidence；
- `timeout_ms`：每 attempt `1..30000`，且必须与 envelope timeout 一致；
- `max_response_bytes`：默认 64 KiB、最大 256 KiB；
- `max_redirects`：默认 3、最大 10；每个 hop 重新检查 scheme/userinfo，跨 origin redirect fail closed；
- `retry`：最多 3 attempts、backoff 最多 5 秒，可精确声明 retry status、network error 和 timeout。

verifier 自身不决定 host/project 是否获准。runtime caller 必须先在现有 project/delegation/tool authorization boundary 生成 invocation 和 append-only `audit_event_ref`；本 verifier 的固定 read/method gate 是必要条件，不能替代上层 scope/approval policy。

## 3. Bounded response 与重试

每 attempt 使用独立 AbortController，timeout 覆盖 redirect、headers 和 body read。redirect 手工计数；可重试 status 的 body 在重试前取消，不复制或继续读取。最终 body 只保留 `max_response_bytes`；达到上限后 cancel stream 并标记 `response_truncated=true`。

- status/header assertion 可以基于 bounded metadata 继续判定；
- JSON schema/business assertion 遇到 truncated body 必须失败并返回 `response body was truncated before JSON assertions could run`，不得对部分 JSON 猜 pass；
- timeout/network/redirect-limit 在 retry budget 用尽后生成 failed Evidence，并保存 attempt count、duration 与可行动错误；
- retry 后只以最终 response 做断言，迟到 response 或先前 503 不能覆盖最终事实。

## 4. Assertions

一次 invocation 至少 1 条、最多 32 条 assertion。所有 assertion 由确定性代码执行，结果保存为 bounded structured JSON：

| kind | 语义 |
| --- | --- |
| `health` | 默认 HTTP 2xx；也可声明精确 accepted status set |
| `status_code` | 精确匹配一个或多个 status code |
| `header` | header name 大小写不敏感，支持 `exists|equals|contains` |
| `json_schema` | 对完整 JSON body 执行 fail-closed schema validation |
| `business` | 对 bounded JSON path 执行 `exists|truthy|equals|not_equals|contains|greater_or_equal|less_or_equal` |

JSON Schema V1 支持 API contract 常用的 boolean schema、local `#/...` ref、`type`、`enum`、`const`、`allOf|anyOf|oneOf|not`、object `required|properties|additionalProperties`、array `items|minItems|maxItems|uniqueItems`、string `minLength|maxLength|pattern` 与 numeric bounds。无法解析的 local ref、非法 pattern、64 层以上 recursion 都 fail closed；不把 unsupported remote ref 当 pass。

所有 assertion passed 才产生 `Evidence.status=passed`。任一 assertion mismatch、transport timeout/network/redirect failure 都是 `failed`。这里的 passed 只证明本次 spec 对本次 bounded exchange 成立；P04.06 仍须检查 workflow kind、freshness、revision 与 artifact availability。

## 5. Redaction 与 artifact refs

Evidence 不保存 request/response header value，只保存有界 header-name 集合、status/body hash/bytes/truncation、assertion results 和安全 excerpt。以下内容在 artifact write 前清理：

- `authorization|cookie|credential|password|secret|token|api-key|access-key` 类 request/response header 整值；
- URL 敏感 query；
- JSON body 中 secret-shaped key 的 value；
- body、failure、assertion label/message 中现有 Evidence redaction policy 能识别的 credential 文本。

`FileSystemHttpEvidenceArtifactStore` 写 content-addressed JSON report 到 `artifacts/evidence-http-exchange/<prefix>/<sha256>.json`，目录 `0700`、文件 `0600`、原子 rename，并校验 bytes/digest。提供 store 时每次写一份 bounded exchange report；body 超过 inline Evidence limit 时 store 是强制项，没有 store 必须拒绝生成 Evidence，不能静默丢弃后仍 pass。artifact report 记录具体 redacted paths，但 artifact ref 不替代 retention/availability 检查。

## 6. Source of truth、兼容与迁移

- **事实 source of truth：** 实际 HTTP exchange、tool/audit intent/outcome 与其 bounded content-addressed artifact；structured Evidence 是带 provenance 的断言记录，不反向改写 endpoint 或 tool audit。
- **现有运行路径：** `url_fetch` 继续作为 PI source-context tool，公共 schema 和 audit 保持不变；其旧 `evidence_ref` 不自动投影为 passed HTTP Evidence。
- **W1 写入：** 新 verification step 对一次 exchange 只生成一条 structured Evidence；本期不批量回填 `url_fetch`、V0 或 issue log，双写窗口为 0。
- **双读期限：** legacy V0/current event 与 structured Evidence 的 W1/W2 总期限继续服从 ADR-XW-0027，最多两个正式 release window；legacy import 不能满足系统门禁。
- **回滚：** 停用 verifier caller/policy consumer，恢复现有 `url_fetch`/V0/event 读取；保留已生成的 Evidence、audit 和 artifact，不反写、不删除，无 DB/schema rollback。
- **最终删除门禁：** 仍须 P11.03/P11.06、G7、所有 provenance/audit consumer 完成映射、legacy producer/consumer 连续一个正式 release 为零、fixture 留档及 artifact/audit 恢复演练通过。本 issue 不删除 `url_fetch`、V0、raw event 或外部 provider authority。

## 7. 验证

```bash
cd backend-ts
bun test src/domain/evidence/httpVerifier.test.ts src/domain/evidence/contracts.test.ts
bunx --package typescript tsc --noEmit --pretty false --target ES2022 --module ESNext \
  --ignoreConfig --moduleResolution Bundler --strict --skipLibCheck --lib ES2022,DOM \
  --types bun --allowImportingTsExtensions \
  src/domain/evidence/httpVerifier.ts src/domain/evidence/httpVerifier.test.ts \
  src/domain/evidence/contracts.ts
```

本地 fixture server 覆盖 health/status/header/schema/business pass 与 actionable mismatch、Authorization/API key/query/response header/JSON secret redaction、503 retry、timeout budget、response truncation、artifact checksum/mode，以及 write permission/POST 在零网络请求前 fail closed。
