# ADR-XW-0035：Evidence API 与用户可读证据界面

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P04.09 / Runner #671
- 依赖：P04.02、P04.03、P04.04、P04.05、[ADR-XW-0033](0033-evidence-policy-completion-gate.md)
- 可执行实现：`backend-ts/src/db/repositories/evidence.ts`、`backend-ts/src/http/evidenceApi.ts`
- 用户界面：`frontend/src/components/EvidencePanel.jsx`

## 1. 决策

Evidence 以 P04.01 `EvidenceRecord` 为唯一语义合同，不增加第二套 kind、status 或可绕过 P04.06 policy 的验证模型。本期复用现有 append-only `issue_events`：completion gate 把它实际消费的完整 structured Evidence 幂等记录为 `evidence.recorded.v1`，由 Evidence repository/API 作为 W2 主读；command、Git、HTTP、browser 和 human 的原始事实 authority 仍由各自 producer 持有，structured record 通过 provenance 指回原始事实，不反向覆盖它。

公开只读接口：

| route | 行为 |
| --- | --- |
| `GET /api/evidence` | cursor pagination；按 project/Issue-backed Work/Run/provider session/kind/status 过滤；只返回 bounded summary，不内联 excerpt、facts 或 artifact bytes |
| `GET /api/evidence/:id` | 返回完整但受 P04.01 schema 上限约束的 record、provenance、artifact metadata 与兼容来源 |
| `GET /api/evidence/:id/artifacts/:index` | authenticated、on-demand artifact download；只允许 collector 的 content-addressed 本地 ref，并在返回前检查 expiry、文件类型、路径边界和 SHA-256 |

API 不提供 Evidence status mutation。Evidence terminal record 保持不可改；状态改变、人工 override 和 completion 仍经既有确定性 gate 与审计路径。

## 2. Pagination 与大输出

- list 默认 25、最大 100，cursor 只携带 opaque `issue_events.id` watermark；未知或伪造 cursor 返回明确 `400 invalid_cursor`。
- list 的 `decisive_summary` 上限 320 字符，只返回 `artifact_count`，因此 8 KiB excerpt、完整 command transcript、HTTP report 和截图不会阻塞 Work/Run 页面。
- detail 只在用户展开某条 Evidence 时加载；Raw / advanced 使用有最大高度的 scroll region。
- artifact bytes 只在用户点击下载后传输，缺失、过期、opaque/external ref 与 digest mismatch 分别 fail closed，不把本机任意路径转成下载接口。

## 3. Work / Run 界面

Work Board 每张 Work card 提供 Evidence 入口，在 dialog 中显示当前 Work 的决定性 passed/failed/blocked 事实。Runs 兼容视图复用 provider session surface，以 `session_ref` 解析 canonical Run，再显示同一 Evidence panel。

Panel 明确区分：

- status/kind/exit code/Attempt 与决定性摘要；
- failed/blocked 的失败原因优先于 Run succeeded 或 Agent 自述；
- artifact 下载可用性；
- structured / legacy human / targeted W1 projection 来源；
- loading、empty、API error、detail error 和 artifact error；
- Raw / advanced JSON drill-down。

普通 Agent comment、verifier prose 和 Run success 不会被 UI 包装成 passed Evidence。

## 4. Source of truth、兼容与迁移

| window | authority / read path |
| --- | --- |
| W2（P04.09 起） | `evidence.recorded.v1` 是 structured Evidence repository/API 主读；事实 authority 仍是 producer observation；`issues` 仍是 Work status write authority |
| W2 compatibility（最多两个正式 release window） | 指定 Work/Run/Issue/session 且 structured record 缺失时，API 可只读投影当前 Run command observation；既有 `issue.verification_human_evidence.v1` 可带 `legacy_human` provenance 读取，不提升为新 authority |
| W3 | structured-only consumer；legacy human event、V0 与 raw event 只按 retention/audit 保留，不再作为 Evidence API fallback 或 completion 输入 |

- **双写：** 没有 Evidence 双主。raw observation 保存原始事实，`evidence.recorded.v1` 保存 completion/policy 消费的结构化投影，两者职责不同且由 provenance 绑定；同一 Evidence ID 的 structured replay 必须 byte-semantically equal，否则 fail closed。
- **双读期限：** W1/W2 compatibility 总计最多两个正式 release window；延期必须有 superseding ADR、owner、退出日期和 parity 指标。
- **回滚：** 注销 Evidence routes，并停止新 `evidence.recorded.v1` projection；恢复 W1 on-demand read/legacy view。已写 append-only event、原始日志和 artifact 不删除、不反写。
- **最终删除门禁：** 仅 P11.03/P11.06 在 G7、legacy producer/consumer 连续一个正式 release 为零、override 抽审、artifact backup/restore 演练和 retention 观察窗通过后，才能删除 targeted fallback、V0 adapter 或 legacy human read。

本期不新增 table、column 或 status，不修改 P04.01 schema/shared state machine，也不删除既有 Issue/Session/Guardian/PI 能力。

## 5. 验证

Focused gates：

```bash
cd backend-ts
bun test src/http/evidenceApi.test.ts src/domain/evidence/completionGate.test.ts src/http/readApiContract.test.ts src/http/runApi.test.ts

cd ../frontend
node --test src/components/evidencePresentation.test.js src/components/EvidencePanel.wiring.test.js src/pages/workBoardModel.test.js
npm run build
```

API smoke 必须覆盖真实 `PATCH Issue status=done` 的通过与失败 command observation，证明前者产生 passed Evidence 并完成 Work，后者产生 failed Evidence、保留失败原因并进入 failed；同时验证 pagination、detail/download、empty/error 和大 excerpt 不进入 list payload。
