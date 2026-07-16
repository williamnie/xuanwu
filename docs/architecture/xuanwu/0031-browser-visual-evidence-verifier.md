# ADR-XW-0031：Browser / Visual Evidence verifier

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P04.05 / Runner #667
- 依赖：[ADR-XW-0027](0027-evidence-domain-contract.md)
- 可执行 verifier：`backend-ts/src/domain/evidence/browserVerifier.ts`
- canonical 级别：本文定义只读浏览器 scenario、URL/DOM 断言、截图与 console/network summary 到 `EvidenceRecord(kind=browser)` 的收集边界；共享 Evidence schema、状态与完成门禁资格仍以 ADR-XW-0027 和 `contracts.ts` 为准

## 1. 当前运行态与边界

Runner 已有 `browser-readonly:read_page_context`，从用户授权的 browser snapshot 读取 bounded page URL、DOM summary、截图 metadata/image ref 和 storage metadata。该路径服务 source context，不执行 click/type/navigation/form submit，也不把 `browser_page:sha256:*` 或 Agent 对页面的总结升级成完成证明。当前 provider 不暴露 console/network summary。

P04.05 在它之上增加 provider-neutral `BrowserEvidenceVerifier`：调用方提供 versioned scenario、Evidence/audit context 和 `permission=read` 的 `BrowserScenarioDriver`；默认 driver 复用上述 read-only browser tool。verifier 只做 observation、确定性 assertion、redaction 和 artifact write，不修改浏览器、Issue、Work、Run 或 provider adapter，不注册新的 Assistant tool。

Browser driver 不可用、未授权、超时、DOM observation 被截断，或 scenario 要求但 connector 不提供 console/network summary 时，结果固定为：

```text
Evidence.status = blocked
decisive_output.facts.outcome = inconclusive
```

不得把 unavailable summary、空截图或 Agent 声明当作 `passed`。

## 2. Scenario contract

`BrowserEvidenceScenario(contract_version=xw.browser-evidence-scenario.v1)` 包含：

- `id/name`：有界 scenario 身份；
- `timeout_ms`：全 checkpoint 共用的单次 capture 上限，默认 15 秒、最大 30 秒，不做无界 retry；
- `artifact_ttl_seconds`：60 秒到 30 天；
- `checkpoints`：1–16 个，每个 checkpoint 以可选 `page_id/url` 选择已授权页面，声明 1 条以上 URL/DOM assertion 和 `disabled|optional|required` screenshot policy；
- `console`：可声明 summary required 及 `error|warning` gate；一旦声明 fail level，即使 `required=false`，summary 缺失仍是 inconclusive；
- `network`：可声明 summary required、request failure gate 和 `400..599` status threshold；一旦声明 fail condition，summary 缺失仍是 inconclusive。

Scenario 没有 action/command 字段。页面导航和交互必须先由已有授权 browser/runtime 路径完成，再把已观测 checkpoint 交给 verifier；不能借 verification contract 绕过 write/dangerous permission 或外部操作审计。

## 3. URL 与 DOM assertions

URL assertion 支持：

- `equals`：normalized absolute URL 精确相等；
- `starts_with`：bounded HTTP(S) prefix；
- `origin_equals`：scheme/host/port 相等；
- `pathname_equals`：pathname 精确相等。

DOM assertion 以 selector 对应的 browser observation 判断：

- `state=attached|detached|visible|hidden`；
- 可选 `count=equals|at_least|at_most`；
- 可选 `text=equals|contains`。

所有结果写入 artifact report；Evidence inline 只保存 bounded count/outcome。DOM summary 截断且目标 selector 未出现时不能证明元素不存在，因此结果是 inconclusive，不是 assertion pass/fail。浏览器完成了完整 observation 但 selector 未出现时，按 `count=0` 做确定性判断。

## 4. Screenshot、console 与 network

- screenshot observation 必须包含受控 `image_ref` 或实际 image bytes、capture timestamp、尺寸和 `png|jpeg|webp` media type；`required` 且无截图时 assertion failed；
- artifact store 必须为每个 screenshot 返回一一对应的 `kind=screenshot` ref；有 bytes 时 verifier 校验 SHA-256，避免“页面有截图”但 Evidence 没有关联 artifact；
- console summary 保存 available/total/error/warning/truncated 和 bounded entries；
- network summary保存 available/total/request failure/HTTP error/max status/truncated 和 bounded method/status/URL/failure entries；
- URL、console、network、DOM text 和 report 中 secret-shaped key/value 在写盘前统一 redaction。Evidence 不保存 cookie/storage value。

默认 snapshot provider 目前只能可靠给出 URL、DOM summary 和截图 ref，因此默认 driver 明确写 `console_available=false`、`network_available=false`。后续真实 browser connector 可实现同一个 read-only driver contract 提供 summary；在此之前，要求 console/network 的 scenario 会 fail closed 为 inconclusive。

## 5. Artifact TTL 与 `uploads/artifacts`

`FileSystemBrowserEvidenceArtifactStore` 把每次 verification 写为 content-addressed bundle：

```text
uploads/artifacts/evidence-browser/<sha-prefix>/<report-sha256>/report.json
uploads/artifacts/evidence-browser/<sha-prefix>/<report-sha256>/<index>-<sha256>.<png|jpg|webp>
```

目录为 `0700`、文件为 `0600`、临时目录原子 rename。report 包含 Evidence/source/audit ref、scenario、capture/assertion 结果、截图 metadata/hash、`expires_at` 和 redaction policy；Evidence facts 同时保存 `artifact_ttl_seconds`、`artifact_expires_at` 与 report SHA-256。

`evaluateBrowserArtifactFreshness()` 以 `now < expires_at` 判 current；到期 artifact 即使文件仍存在也不能满足后续 policy。P04.06 必须检查 freshness/availability，不能只看 `Evidence.status=passed`。

本期不实现 destructive sweeper，避免无独立 retention audit 的删除操作。后续 retention service 若物理删除 bundle，必须先写 append-only intent/outcome audit，并服从 legal hold/archive/restore；不能把 TTL 当成静默 `rm -rf` 授权。

## 6. Source of truth、兼容与迁移

- **事实 source of truth：** 用户授权的 live browser/session observation、只读 tool audit 和实际截图 bytes/ref；structured Evidence 是带 provenance 的 assertion record，不反向改写 browser/provider 状态。
- **现有运行路径：** `browser-readonly:read_page_context`、raw event/context bundle 和 `VerificationEvidenceV0` 保持不变；旧 `browser_page` ref 不自动升级成 passed Browser Evidence。
- **W1 写入：** 新 verification step 对一次 scenario 只生成一条 structured Evidence bundle；不批量回填旧 snapshot/raw event/V0，竞争 authority 双写窗口为 0。
- **双读期限：** structured Evidence 与 legacy V0/current event 的 W1/W2 总期限继续服从 ADR-XW-0027，最多两个正式 release window；legacy import 不能满足系统门禁。
- **回滚：** 停用 verifier caller/policy consumer，恢复现有 browser source-context/V0/event 读取；保留 additive Evidence/audit/artifact，不修改 DB/schema，不反写 browser session。
- **最终删除门禁：** 仍须 P11.03/P11.06、G7、所有 provenance/audit consumer 完成映射、legacy producer/consumer 连续一个正式 release 为零、fixture 留档及 artifact/audit 恢复演练通过。本 issue 不删除 browser tool、V0、raw event 或 provider authority。

P04.06 才声明 workflow 需要哪些 Browser Evidence 和 freshness；P04.07 才把 policy 接入 `done` mutation；P04.09 才负责 Evidence persistence/API/UI。本 verifier 的 `passed` 不能直接关闭 Work/Issue，也不能由 LLM narrative 替代确定性 permission/verification gate。

## 7. 验证

```bash
cd backend-ts
bun test src/domain/evidence/browserVerifier.test.ts src/domain/evidence/contracts.test.ts
bunx --package typescript tsc --noEmit --pretty false --target ES2022 --module ESNext \
  --ignoreConfig --moduleResolution Bundler --strict --skipLibCheck --lib ES2022,DOM \
  --types bun --allowImportingTsExtensions \
  src/domain/evidence/browserVerifier.ts src/domain/evidence/browserVerifier.test.ts \
  src/domain/evidence/contracts.ts
```

Fixtures 覆盖本地 HTTP 页面经现有 browser snapshot integration 的 URL/DOM smoke、截图关联和 TTL 边界；browser unavailable → blocked/inconclusive；console/network error → failed；required summary 缺失和 truncated DOM → inconclusive；invalid scenario 在零 browser call 前拒绝；截图/report checksum、文件权限和敏感值 redaction。
