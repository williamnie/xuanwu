# ADR-XW-0089：新 Provider Adapter 接入清单（P12 scaffold）

- 关联：0089 Provider Core 多 Coding Agent 重构 [计划](0089-provider-core-multi-code-agent-refactor-plan.md) / [设计](0089-provider-core-multi-code-agent-refactor-design.md)
- 目的：把 Codex/Claude/Pi 三次接入沉淀为稳定工程路径；新 adapter 按本清单推进。

## 0. 前置 Gate（每次接入前必做）

- [ ] 同一实施周期内核验拟接入版本：`command/package version`、官方文档或类型定义、headless transport、terminal signal、Session/ref 语义、interrupt/approval、认证与本地配置来源、model/usage 能力（G0 模板见 `0089-gate-investigation-template.md`）。
- [ ] 四项硬门槛全部满足才进入 adapter 实现；缺失时只做 capability-limited Provider，不伪造能力。
- [ ] 保存 Gate 调研记录（日期、版本、官方来源、硬门槛证据）。

## 1. Adapter 实现（`src/providers/<id>/`）

- [ ] `rpcTransport.ts` 或等价 transport：headless 传输 + 事件泵 + command id 关联（参考 `pi/rpcTransport.ts`）。
- [ ] `provider.ts`：`<X>ExecutorProvider implements ExecutorProvider`：
  - `run` 两阶段：accepted（本地 invocation anchor）→ terminal 收敛（唯一终态渠道）；
  - `recover`/`createSession`/`interrupt`/`listModels` 等按实际能力实现；缺失方法不声明。
- [ ] `factory.ts`：`<x>Factory()` + `<x>Manifest()`：
  - manifest 声明**实际实现**的能力（capability 只声明 true）；未实现不声明；
  - `sessionPresentation.nativeActions`（如 "Open in App"）经 manifest action 提供；
  - `executionSettings` 首版仅 string/enum/boolean/secret-ref。
- [ ] capability-limited 原则：list/read/steer/fork/approval 无稳定官方接口时不声明（如 Pi 的 list/read、approvals）。

## 2. 注册与装配（runtime/core.ts）

- [ ] `if (config.providers.<id>) providersRegistry.registerFactory(<x>Factory(...))`。
- [ ] Provider ID 加入 `EXECUTOR_PROVIDER_IDS`（闭合联合过渡；P2 registry 后仍保持可发现）。

## 3. Conformance（`src/providers/` 测试）

- [ ] transport 协议单元测试（fake 子进程/注入流）。
- [ ] provider 行为测试（fake transport：run/recover/interrupt/model list 时序与 terminal 收敛）。
- [ ] factory/manifest 测试（capability 只声明实际实现）。
- [ ] registry 装配测试（注册后可发现；catalog/session actions 投影正确）。
- [ ] 纳入 `core/conformance.test.ts` §20 矩阵（initial execution、稳定 invocation ref、resume 拒绝/支持、interrupt 按 capability、unknown event preserve）。

## 4. Parity 与观察窗

- [ ] `core/parity.ts`：manifest detail ↔ 实例 legacy capabilities 无 drift（`compareCapabilitiesParity`）。
- [ ] W2 观察窗：`XUANWU_PROVIDER_LEGACY_PROJECTION_COMPARE=1` 运行 parity 对比；drift 记录 telemetry，不阻断。
- [ ] rollback：关闭 flag 即回退；不需要 DB 回填或删除事件。

## 5. 验收与 support level

- [ ] 本地无费用 smoke：version/status/session discovery，不发模型请求。
- [ ] 无真实账号 acceptance 前 `supportLevel` 保持 `preview`；`tested` 需独立 live acceptance 证据。
- [ ] 前端不出现 Provider ID switch（label/能力来自 `/api/providers` catalog）。
- [ ] 全量回归通过（本仓库 `bun test src/providers/ src/domain/run/ src/runner/ src/http/ src/db/`）。
