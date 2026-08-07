# 10 分钟首次交付

这是玄武首次使用的 canonical 路径：安装并启动 Runner，选择 Code Agent，连接 Supervisor Provider，添加一个本地项目，然后完成一个有 passed Evidence 和同 Work Handoff 的 Work。整个路径不需要进入 Advanced。

## 开始前

1. 安装或启动 Runner，打开 `http://127.0.0.1:3008/`。
2. 确认执行器 CLI 已安装并登录；Codex 可用 `codex --version` 做本机检查。
3. 先运行只读 doctor：

   ```bash
   xuanwu doctor
   ```

   人类可读输出会列出确定性 `fix:` 步骤；`--json` 仍原样输出 `/api/system/doctor` 的 canonical JSON，不新建第二份诊断状态。

## Dashboard setup wizard

Dashboard 顶部的 **10-MINUTE FIRST DELIVERY** 会实时检查六个门禁：

1. **运行环境可用**：`/api/system/doctor` 中 API alive 且 DB ok。
2. **Code Agent 已选择并就绪**：`/api/code-agents` 至少返回一个 `enabled && submittable` 的执行器。Codex 在 **设置 → Code Agents** 中明确选择 Codex CLI 或 Codex App app-server；选择只改变运行后端，历史 `provider=codex` 和 Session 标识不迁移，也不会静默 fallback。
3. **Supervisor 连接测试通过**：当前浏览器会话内已有一次成功的 Supervisor Provider test。在 **设置 → Xuanwu Supervisor** 中执行现有连接测试。测试结果由现有 action event 审计，密钥不回显；向导只在 `sessionStorage` 保留 30 分钟的成功回执用于当前 UI checklist，它不是 Provider 状态 authority，丢失后重新测试即可。
4. **已添加项目**：输入 Runner 所在机器上已存在的仓库绝对路径。向导调用现有 Projects API，默认开启 Auto Run。
5. **已创建首个 Work**：“创建并开始”通过 `/api/works` 创建 Issue-backed Work，再启动该项目的现有 Loop。示例只读检查 README / manifest / Git 状态，不修改文件、不 commit/push/deploy。
6. **Evidence / Handoff 完整**：只有 Work 为 `done`、存在同 `work_id` 的 passed Evidence，并且 Handoff 引用了 Evidence 时才通过。如果 Evidence 已有但 Handoff 尚未产生，先从向导打开该 Work，再使用底部已附带 Work 上下文的 Ask Xuanwu，要求它针对该 Work 运行已注册 Workflow，并在确定性 Action Gate 中确认。不要手写 Handoff 或把 LLM 结论当成 Evidence。

## 失败恢复

- **API / DB 失败**：执行 `xuanwu doctor` 和安装版的 `xuanwu-daemon doctor`（源码部署使用 `./scripts/daemon.sh doctor`），修复后点击“重新检查”。
- **Code Agent 不可用**：先安装并登录对应执行器，再到设置 → Code Agents 重新发现、启用并选择运行后端。
- **Supervisor Provider 不可用**：到设置 → Xuanwu Supervisor 重新测试；不用 Advanced 的 base URL 表单做临时旁路。
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
- 本改动没有 schema/migration、没有双写/双读窗口。回滚只需移除 Dashboard 的向导入口和 CLI human formatter；所有已有 Project/Work/Evidence/Handoff 仍由原 authority 保留。

## Clean state rehearsal

自动化回归用空 `projects/works/evidence/handoffs` 快照演练首次使用，再用同 Work 的 done + passed Evidence + Handoff 快照证明成功门禁：

```bash
node --test frontend/src/pages/command-center/firstDeliveryGuideModel.test.js
bun test backend-ts/src/cli/command.test.ts
```

真实新机器演练时，使用一个可丢弃的本地测试仓库；不要在生产项目上为了演练创建样例 Work。
