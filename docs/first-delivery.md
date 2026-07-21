# 10 分钟首次交付

这是玄武首次使用的 canonical 路径：安装并启动 Runner，连接 Agent，添加一个本地项目，然后完成一个有 passed Evidence 和同 Work Handoff 的 Work。整个路径不需要进入 Advanced。

## 开始前

1. 安装或启动 Runner，打开 `http://127.0.0.1:3008/`。
2. 确认执行器 CLI 已安装并登录；Codex 可用 `codex --version` 做本机检查。
3. 先运行只读 doctor：

   ```bash
   codex-issue-runner doctor
   ```

   人类可读输出会列出确定性 `fix:` 步骤；`--json` 仍原样输出 `/api/system/doctor` 的 canonical JSON，不新建第二份诊断状态。

## Dashboard setup wizard

Command Center 顶部的 **10-MINUTE FIRST DELIVERY** 会实时检查五个门禁：

1. **运行环境可用**：`/api/system/doctor` 中 API alive 且 DB ok。
2. **Agent 连接测试通过**：doctor 至少识别一个可用执行器，且当前浏览器会话内已有一次成功的 provider test。“打开连接向导”会进入 **Connections → AI Providers**，在推荐 provider 卡片中执行现有的“测试连接并发现模型”。测试结果由现有 `provider_connection_tested` action event 审计，密钥不回显；向导只在 `sessionStorage` 保留 30 分钟的成功回执用于当前 UI checklist，它不是 provider 状态 authority，丢失后重新测试即可。
3. **已添加项目**：输入 Runner 所在机器上已存在的仓库绝对路径。向导调用现有 Projects API，默认开启 Auto Run。
4. **已创建首个 Work**：“创建并开始”通过 `/api/works` 创建 Issue-backed Work，再启动该项目的现有 Loop。示例只读检查 README / manifest / Git 状态，不修改文件、不 commit/push/deploy。
5. **Evidence / Handoff 完整**：只有 Work 为 `done`、存在同 `work_id` 的 passed Evidence，并且 Handoff 引用了 Evidence 时才通过。如果 Evidence 已有但 Handoff 尚未产生，先从向导打开该 Work，再使用底部已附带 Work 上下文的 Ask Xuanwu，要求它针对该 Work 运行已注册 Workflow，并在确定性 Action Gate 中确认。不要手写 Handoff 或把 LLM 结论当成 Evidence。

## 失败恢复

- **API / DB 失败**：执行 `codex-issue-runner doctor` 和安装版的 `codex-issue-runner-daemon doctor`（源码部署使用 `./scripts/daemon.sh doctor`），修复后点击“重新检查”。
- **Agent 不可用**：先安装/登录 CLI，再到 Connections → AI Providers 重新测试；不用 Advanced 的 base URL 表单做临时旁路。
- **项目创建失败**：确认路径是已存在的目录。Projects authority 按 CWD 复用现有项目。
- **Work 创建请求超时**：向导会禁用立即再创建。先点击“重新检查”，它会先从 Issue-backed Work authority 查找同名示例；只在确认未落库后才可重试。
- **Work failed**：从 Runs 读取错误，修复 Agent/权限后使用现有 Retry，不新建重复 Work。
- **缺 Evidence**：重试时要求 Agent 直接执行一条最小只读验证命令。
- **缺 Handoff**：由 Ask Xuanwu 对同 Work 运行已注册 Workflow，并经 Action Gate 确认；不平行写第二份交付记录。

每个未通过状态都会在向导底部生成可复制的恢复文本。

## Authority、兼容与回滚

- Runtime/doctor source of truth：`/api/system/doctor`。CLI 只渲染 fixes，不写诊断表。
- Project source of truth：`projects`，继续使用现有 Projects API。
- Work source of truth：`issues`，向导只调用 Issue-backed `/api/works` adapter，不双写 Work 表。
- Evidence / Handoff source of truth：现有 append-only Evidence 与 Handoff event repositories。向导只读 API 投影并严格按 `work_id` 关联。
- 本改动没有 schema/migration、没有双写/双读窗口。回滚只需移除 Command Center 的向导入口和 CLI human formatter；所有已有 Project/Work/Evidence/Handoff 仍由原 authority 保留。

## Clean state rehearsal

自动化回归用空 `projects/works/evidence/handoffs` 快照演练首次使用，再用同 Work 的 done + passed Evidence + Handoff 快照证明成功门禁：

```bash
node --test frontend/src/pages/command-center/firstDeliveryGuideModel.test.js
bun test backend-ts/src/cli/command.test.ts
```

真实新机器演练时，使用一个可丢弃的本地测试仓库；不要在生产项目上为了演练创建样例 Work。
