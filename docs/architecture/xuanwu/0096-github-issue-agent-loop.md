# ADR-XW-0096：GitHub Issue 调查、求助与修复闭环

状态：已实现并部署，受控真实 Issue 闭环验收完成；草稿 PR 等待人工评审与合并，CI 限制单独记录。

## 目标与职责

GitHub Issue → 接收和关联 → 初步分流 → 查证预期行为 → 复现 → 有界修复 → 回归 → 草稿 PR → 评审反馈续跑 → 合并/交付状态回写。

沿用 Work → Run/Attempt → Evidence → Handoff。PI 决定问题含义、证据是否充分和是否求助；Runner 校验权限、版本和执行结果。GitHub 的 open/closed 是外部事实，不能直接写入本地 done。未复现不是非 Bug，现有代码行为不是设计依据。

“不直接写 done”不代表两边状态不联动。规范化导入与生产工作流分别承担事实记录和动作执行：

| GitHub / 交付事实 | 玄武处理 |
| --- | --- |
| open，调查/修复中 | 当前 Work 按实际阶段执行，GitHub 进度评论同步阶段 |
| 等待人工决策 | needs_user；GitHub 保持 open，发出版本绑定的具体问题 |
| 手动 closed 或撤回接管标签 | 中断尚在执行的 Provider 并取消未完成 Work，保留关闭原因，不伪造修复成功 |
| 已验收修复、PR 合并且 CI 没有待定/失败项 | 交付流程 resolved；按 closeOnMerge 配置关单 |
| reopened 或恢复接管标签 | 新源版本重新调查，保留旧 Work 与关闭/取消历史 |

一个 GitHub Case 关联调查及修复 Work 的完整历史，current issue_id 指向当前阶段。调查 Work 完成不表示整个 Bug 已修复；对外以 Case 阶段与交付事实为准。

每一步都可求助，但先使用现有上下文与安全实验。沿用 HumanReviewRequest 的 request ID/revision/来源 Run；GitHub 回复只能回答当前请求。报告者可补事实，具备仓库维护权限的人才能批准范围和风险。无人回答保持等待。旧版本回复不能批准新版本问题。

GitHub 已接管的调查/修复 Work 默认在原 Issue 回写求助，不再回退到全局默认飞书会话造成双渠道重复打扰；显式绑定的飞书 Issue、会话或项目通知目标仍有效。新的有效人工回答会重新开启有界的报告修正续跑，同一回答不会反复重置次数，未通过报告校验仍不能完成。

## 接入与持久化

- 本地部署先用增量轮询，遵循分页、条件请求、限流退避；之后的 Webhook 必须验签、先持久化，再异步消费，并保留补漏对账。
- 仅接管配置仓库中带 intakeLabel 的 Issue。接管标签是管理员配置的授权边界；Issue 正文、评论、附件始终是不可信数据，不能修改执行权限。
- 使用不可变 repository/issue ID 关联，Issue number/仓库名称只作为当前位置。区分 Issue 与 PR。
- 外部内容版本、游标、处理回执和远程写意图持久化。重启、重复、乱序、响应丢失均不能导致重复 Work 或评论；自身评论不会重新触发工作。
- 每次轮询观察以 `github-snapshot:<snapshot sha256>` 保存独立 `external_events` 记录，逻辑 Issue ID 放在 `normalized_message.issue_node_id`；不能让后一次观察覆盖前一次输入。多页扫描不缓存仅代表第一页的 ETag。
- GitHub App 为推荐认证；支持已配置 connector token，以及明确配置的 gh-cli 本机认证以便现有本地安装测试。凭据只在 Host 内存中使用，不进入任务正文、日志或执行器上下文。
- 公共状态只回写脱敏、经过审核的摘要和证据链接；不上传内部会话、绝对路径或原始命令输出。

## 配置

沿用状态目录 runner-settings.local.json 的 integrations.github，新增 issueSync：

```json
{
  "integrations": {
    "github": {
      "issueSync": {
        "enabled": true,
        "pollIntervalSeconds": 60,
        "auth": { "mode": "gh-cli" },
        "repositories": [{
          "repository": "owner/repository",
          "projectId": "registered-project",
          "intakeLabel": "xuanwu",
          "autoEnqueue": true,
          "allowFix": true,
          "allowPullRequest": true,
          "closeOnMerge": false
        }],
        "jev": {
          "mode": "shadow",
          "model": "jev-latest",
          "apiKeyRef": "env://TYPESAFE_API_KEY"
        }
      }
    }
  }
}
```

App 模式使用 auth.mode=github-app，加 appId、installationId、privateKeyRef（secret:// 或 env://）。Jev 支持 apiKeyRef，也支持显式指定只对当前用户可读写的 apiKeyEnvFile，其中仅读取 TYPESAFE_API_KEY，不执行 shell 或修改进程环境。

仓库 `ciFailureMode` 默认 `repair`，检查失败时先诊断原因，仅修复本任务回归。维护者已确认 Actions 额度或其他外部限制时，可设 `ciFailureMode: "report_only"` 并填写 `ciFailureReason`。此模式保留失败状态和原因，不自动启动 CI 修复，不覆盖人工评审反馈，也不放宽合并后自动关单的 CI 门禁。检查恢复后可删除这两个配置项，恢复默认行为。当前版本评审反馈优先于自动 CI 诊断；重新验证得到相同文件树时复用原提交，避免空提交重复触发 Actions。

## Jev 的边界

Jev 负责窄问题分类：报告意图、资料完整性、评论意图。shadow 只记录建议；routing 仅启用经过实际样本评估的低风险分流。置信度不是权限或验收证据。未配置、超时、无效输出、低置信度均回退 PI。快分类不能直接关单、批准风险或认定修复成功。浏览器桥接不是此服务端 API 的依赖。

## 完成门禁

- [x] 可靠接入：自动发现真实新 Issue，重复/重启/乱序/限流/响应丢失回归通过。
- [x] 调查与求助：真 Bug、符合设计、信息不足的真实 Issue 验证通过；重复报告、旧回答/无权限回答的自动化回归通过。
- [x] 修复交付：原问题前后证据、相关回归、真实草稿 PR 与评审反馈续跑通过；自动化测试验证合并/CI/closeOnMerge 关单门禁。本轮不执行真实合并，失败不报成功。
- [x] Jev：真实 API 连通、脱敏输入、版本化决策记录、降级与 shadow 小样本评估；尚未做同样本 PI 对比，不启用 routing。
- [x] 当前 williamnie/xuanwu 仓库新建明确标注的专用测试 Issue 并逐项读回验证，保留链接与证据；不重跑或回填历史 Issue。
- [x] 相关回归、完整后端测试、必要构建、仓库 hygiene、运行环境验证通过；类型检查与原有错误基线一致。

自动合并和生产发布不属于默认授权；PR ready/merged、代码交付、发布验收分别记录。

## 2026-09-26 真实环境验收

使用专用标签与独立普通 clone，仅接管本轮新建的测试 Issue，未重跑历史 Issue：

- [Issue #1](https://github.com/williamnie/xuanwu/issues/1)：确认通用导入层将 closed 直接写成本地 done 的问题；调查 Work #957 完成后进入修复 Work #961，生成[草稿 PR #4](https://github.com/williamnie/xuanwu/pull/4)。调查和修复分别留存证据，草稿 PR 仍等待人工评审与合并。
- [版本绑定的真实评审意见](https://github.com/williamnie/xuanwu/pull/4#issuecomment-5846220205)在 CI 失败时仍自动进入同一 Work 的 Run #13；三处文档按反馈修正，相关回归 51 通过。报告字段补正后 Run #16 经 PI 验收，Work #961 为 done、GitHub Case 为 review；新提交 `fa6f581c1642153ef4fd30fefe7e6978f572acde` 已推送到原草稿 PR。此前仅重新验证、未改文件的 Run #12 复用了原 head，未增加空提交。
- [Issue #2](https://github.com/williamnie/xuanwu/issues/2)：查明“本地完成后未自动部署”符合设计，Work #958 完成，未执行部署；经核对后以 not_planned 关闭测试 Issue。
- [Issue #3](https://github.com/williamnie/xuanwu/issues/3)：真实手动关闭取消 Work #959；重新打开产生源版本 2 和新调查 Work #960。GitHub 补充具体筛选条件后自动续跑，隔离 HTTP 复现证明行为符合设计，调查完成后关闭测试 Issue。
- Jev 使用已配置的用户私有凭据文件，真实模型 `jev-1.13.0` 的 16 个中英文合成样本分类与预期一致，p50 274 ms、p95 885 ms；保留 shadow，未授予自动验收或关单权限。这不证明复杂真实问题准确率或相对 PI 的加速幅度。
- 后端全量测试 2455 通过，末次报告字段诊断调整的相关回归 27 通过。前端测试 601 通过，脚本测试 30 通过；前端 lint/build 和仓库 hygiene 通过。TypeScript 基线及当前均有 161 个错误，归一化路径/行号后无新增；不宣称全仓类型检查通过。
- 已验证三角色健康、Gateway、DB、Core→Agentic RPC 及运行/制品 stamp 一致：`20260926T124500Z-bc024032e441-dirty`。运行配置中失效的 Codex 路径已改为当前 App 内可执行文件，Provider 已恢复 ready，并实际启动同一 Work 的新 Run。

CI 限制由维护者确认，测试仓库启用 `report_only`。实际取得的 Actions 日志显示后端测试通过，随后失败于既有依赖安全审计；额度不足另按维护者说明记录。未把失败改成成功，未扩大任务去升级依赖，未自动合并或放宽关单门禁。CI、报告格式和 Provider 原生问答在初始演练中暴露的重复执行问题已修正并回归；本轮不是“全程无人干预”验收。

当前运行配置仍限定测试项目与专用 intakeLabel；通用接入需在 `runner-settings.local.json` 的 `integrations.github.issueSync.repositories` 显式填写正式项目和标签，不能通过修改 Issue 正文扩大权限。状态与手动对账入口分别为带 Bearer 认证的 `GET /api/integrations/trackers/github/status`、`POST /api/integrations/trackers/github/sync`。第一版为轮询接入，原生验签 Webhook 留待后续实现。
