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

## 独立首启 Onboarding

用户完成认证后，若当前浏览器还没有首启记录且 Work authority 为空，App 会先进入独立 Onboarding 页面，不挂载 Dashboard、侧边栏或全局工作台。进入后会把 `xuanwu-first-run-onboarding-v1=active` 写入本地浏览器状态，因此创建首个 Work 或刷新页面不会让引导中途消失；完成后记录 `completed`，点击“稍后设置”则记录 `dismissed` 并进入指挥中心。

独立页面会实时检查六个门禁：

1. **运行环境可用**：`/api/system/doctor` 中 API alive 且 DB ok。
2. **Code Agent 已选择并就绪**：`/api/code-agents` 至少返回一个 `enabled && submittable` 的执行器，并由用户在本页明确选择。Codex 可继续选择 Codex CLI 或 Codex App app-server；选择只改变运行后端，历史 `provider=codex` 和 Session 标识不迁移，也不会静默 fallback。已有项目改选 Agent 时，本页会同步更新该项目的 Provider，并清除不再匹配的默认 Profile。
3. **Supervisor 连接测试通过**：本页只提供 OpenAI-compatible API、Anthropic-compatible API 与 Codex / ChatGPT OAuth。API 模式可在 Responses 和 Chat Completions 请求格式间选择；GLM、DeepSeek 等兼容服务填写自己的 Base URL，原生 Gemini 等其他协议留在高级设置。OAuth 复用现有 PI runtime 登录、状态和模型发现契约，不读取或回显 Codex CLI token。测试结果由现有 action event 审计；向导只在 `sessionStorage` 保留 30 分钟的成功回执用于当前 UI checklist，它不是 Provider 状态 authority，丢失后重新测试即可。
4. **已添加项目**：输入 Runner 所在机器上已存在的仓库绝对路径。向导调用现有 Projects API，默认开启 Auto Run。
5. **已创建首个 Work**：“创建并开始”通过 `/api/works` 创建 Issue-backed Work，再通过 Onboarding 专用 client 启动该项目的现有 Loop。示例先执行 `printf 'Hello Xuanwu\n'` 并把 exact stdout 作为第一条 passed Evidence，随后只读检查 README / manifest / Git 状态；不修改文件、不 commit/push/deploy。
6. **Evidence / Handoff 完整**：只有 Work 为 `done`、存在同 `work_id` 的 passed Evidence，并且 Handoff 引用了 Evidence 时才通过。如果 Evidence 已有但 Handoff 尚未产生，点击本页“完成交付检查”：服务端限定为引导创建的示例任务，要求 Work done、最新 Run 成功结束、同 Run 的非 Git Evidence 全部 passed，再采集当前 Git 快照，通过现有 append-only Handoff 服务生成只读检查凭证。页面每 5 秒只刷新目标任务、执行、证据和交付记录；成功后原地完成引导。检查失败会保留原因，可点“让玄武协助”在本页继续现有 Supervisor 会话。

## 失败恢复

- **API / DB 失败**：执行 `xuanwu doctor` 和安装版的 `xuanwu-daemon doctor`（源码部署使用 `./scripts/daemon.sh doctor`），修复后点击“重新检查”。
- **Code Agent 不可用**：先安装并登录对应执行器，再在当前页面重新发现、启用并选择运行后端。
- **Supervisor Provider 不可用**：在当前页面保留输入并重新测试；不用 Advanced 的其他协议做临时旁路。
- **项目创建失败**：确认路径是已存在的目录。Projects authority 按 CWD 复用现有项目。
- **Work 创建请求超时**：向导会禁用立即再创建。先点击“重新检查”，它会先从 Issue-backed Work authority 查找同名示例；只在确认未落库后才可重试。
- **Work failed**：从 Runs 读取错误，修复 Agent/权限后使用现有 Retry，不新建重复 Work。
- **缺 Evidence**：重试时要求 Agent 直接执行一条最小只读验证命令。
- **缺 Handoff**：点击“完成交付检查”，调用 `POST /api/onboarding/works/:id/delivery-check`。该入口使用现有认证边界，只允许带 `first-delivery-guide` 创建审计的只读示例任务；不修改 Work 状态或项目文件，不执行 commit/push/deploy。按 Work + 最新 Run 固定交付 ID，重复及并发请求返回同一份结果。
- **需要协助**：本页 Supervisor 会话绑定原 Work/项目，流中断后重新打开已持久化会话，不自动重放消息。协助操作保留现有权限与审批门禁。

每个未通过状态都会在向导底部生成可复制的恢复文本。

## Authority、兼容与回滚

- Runtime/doctor source of truth：`/api/system/doctor`。CLI 只渲染 fixes，不写诊断表。
- Project source of truth：`projects`，继续使用现有 Projects API。
- Work source of truth：`issues`，向导只调用 Issue-backed `/api/works` adapter，不双写 Work 表。
- Evidence / Handoff source of truth：现有 append-only Evidence 与 Handoff event repositories。向导只读 API 投影并严格按 `work_id` 关联。
- 没有数据库 schema/migration、没有双写/双读窗口。Handoff 的 local_changes 验证规则允许受限的零文件只读凭证（相同基线/最终快照、无交付操作且关联 Run/Evidence）；外部交付规则保持不变。回滚只需移除 App 的首启判定与独立 Onboarding 页面；所有已有 Project/Work/Evidence/Handoff 仍由原 authority 保留。

## Clean state rehearsal

自动化回归用空 `projects/works/evidence/handoffs` 快照演练首次使用，再用同 Work 的 done + passed Evidence + Handoff 快照证明成功门禁：

```bash
node --test frontend/src/pages/command-center/FirstDeliveryGuide.test.js frontend/src/pages/command-center/firstDeliveryGuideModel.test.js frontend/src/utils/firstRunOnboarding.test.js
bun test backend-ts/src/cli/command.test.ts
```

真实新机器演练时，使用一个可丢弃的本地测试仓库；不要在生产项目上为了演练创建样例 Work。
