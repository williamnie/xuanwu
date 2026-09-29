# Issue #976：仓库接管设置与隔离验证

## 范围

设置 → Integrations → GitHub 仓库接管。复用 `integrations.github.issueSync`、`runner-settings.local.json`、GitHub Case、Work 状态与既有 Bearer 认证。配置只保存凭据引用或认证方式，不接收 token/私钥，不授予 merge/deploy 权限，不修改 Action Gate 或项目授权。

起始分支 `codex/pi-memory-phase1`，HEAD `f46804e103321aff1d870283b71c34911bf1e61e`。开工已有 16 项 Pi 授权/验收相关修改，保存了清单、diff 和 SHA-256 基线；逐项校验未变。本 Issue 不涉及受保护的 SSE 文件及 fixtures/。

## 配置与状态契约

- `GET /api/integrations/trackers/github/settings`：返回设置版本、保存版本与生效版本、已注册项目、凭据引用、轮询状态和每个仓库最近 100 个 Case。Case 阶段、当前 Work 状态、外部状态和 PR 编号分别展示；`needs_user` 显示求助，不把 Work done 解释为已合并。
- `PUT .../settings`：提交 `{ revision, settings }`，完整校验 issueSync 草稿并保存。配置冲突或 Case 项目迁移冲突为 409；未知项目、额外权限、明文凭据和错误类型为 400；文件权限不足为 403。保留现有连接器凭据、旧 Jev 配置和其他设置。
- `POST .../test`：提交 `{ settings }`，只读探测仓库元数据和指定标签；不调用同步、不创建 Work、不写评论、不保存。区分正常、认证失败、凭据不可用、无权限、仓库不可见、标签不匹配及限流。GitHub App 仍使用既有临时安装令牌获取流程。读取成功不证明评论、推送或 PR 写权限，页面明确标为尚未验证。
- `POST .../reload`：提交 `{ revision }`，明确应用保存版本。未应用显示 pending；运行时缺失为 503；轮询正在执行或服务已停止时拒绝重载并返回 `reload_failed` 409，保存版本保留、现有运行配置不变。重载不打断已有 Work/Run；停用/移除仓库不会取消已有 Work。更换标签时完整扫描新标签范围，保留仓库身份校验。
- 设置写入在同一 Host 内按路径串行，使用权限 0600 的临时文件原子替换；revision 检查在锁内完成。直接由外部进程编辑文件仍须避免与 Host 写入同时进行；不提供跨进程文件编辑锁。
- 前端刷新保留未保存草稿；冲突后展示最新保存版本，由用户选择采用保存版本或保留草稿重试。应用按钮只应用无草稿变动的保存版本。新仓库四项自动操作均默认关闭。

## 自动验证（2026-09-29）

均在临时 DB、临时设置目录、内存 GitHub transport 或本机 Git 沙箱运行；未保存真实接管配置、未发送真实 IM、未调用真实 GitHub 写入及 Actions。

| 验证 | 命令/操作与结果 |
| --- | --- |
| 初始红灯 | `bun test backend-ts/src/http/githubSettingsApi.test.ts`，exit 1：新增模块尚不存在，记录缺失入口 |
| API 最终验证 | `bun test backend-ts/src/http/githubSettingsApi.test.ts`，exit 0，10 pass；含并发冲突、文件权限失败后恢复、凭据保留/不回显、无权限、标签不匹配、过期应用、运行时缺失、重载失败及创建流程 |
| 配置及运行时回归 | `bun test --timeout 15000 backend-ts/src/http/githubSettingsApi.test.ts backend-ts/src/integrations/github/issueSyncRuntime.test.ts backend-ts/src/config/env.test.ts backend-ts/src/http/feishuSettingsApi.test.ts backend-ts/src/http/telegramSettingsApi.test.ts backend-ts/src/http/runnerSettingsApi.test.ts backend-ts/src/skills/jev/jevSkill.test.ts backend-ts/src/http/readApiContract.test.ts backend-ts/src/xuanwu/capabilityDispositionInventory.test.ts`，exit 0，75 pass（API 后补两项已另跑上行 10 pass） |
| GitHub/Tracker 回归 | 初次共 95 项，93 pass；新增页面清单检查失败已修复并通过上述回归。Git 沙箱 `blocks publication when files change after verification` 超过默认 5000ms，原断言不变，以 `bun test --timeout 15000 backend-ts/src/integrations/github/issueDelivery.test.ts` 复跑，exit 0，12 pass。其余 GitHub client/provider/workflow/native question 和 Tracker 用例初次均通过 |
| 前端组件/状态/样式及设置回归 | `bun test frontend/src/pages/githubSettingsModel.test.js frontend/src/pages/GitHubSettingsPanel.styles.test.js frontend/src/pages/githubSettingsTests/panel.test.jsx frontend/src/pages/settingsLayout.test.js frontend/src/pages/settingsNavigation.test.js frontend/src/pages/settingsProductModels.test.js frontend/src/pages/JevSkillSettings.styles.test.js frontend/src/pages/feishuSettingsPanel.test.js frontend/src/pages/telegramSettingsPanel.test.js`，exit 0，40 pass |
| Code Agents 设置回归 | `bun test backend-ts/src/http/codeAgentsApi.test.ts`，exit 0，5 pass |
| lint/build | `npm --prefix frontend run lint && npm --prefix frontend run build`，exit 0 |
| hygiene | `node scripts/repository-hygiene-audit.mjs`，exit 0，8 checks pass |
| TypeScript | TypeScript 5.9.3，`tsc --noEmit -p backend-ts/tsconfig.json`；临时源码副本回退本 Issue 文件、保留开工既有修改，作为基线。基线和当前各 153 个既有错误，均 exit 2，按路径/行号归一化后无新增；不宣称全仓类型检查通过 |

创建流程的 API 测试使用保存的仓库映射，显式应用后执行隔离轮询，创建 canonical 调查 Work，读回 Case 的 investigate/triage/matched 状态；`autoEnqueue=false`，没有启动 Provider Run。阶段展示另覆盖 investigate、repair、needs_user、review、paused、resolved，标签撤回和项目映射冲突。

## 本地浏览器 fixture

用 Playwright CLI 启动独立 Chrome，入口仅 `127.0.0.1`；加载实际 React 组件与运行时 CSS，`fetch` 替换为内存 fixture，无真实服务请求。

操作记录：添加仓库 → 填写 owner/repo、选择 fixture 项目、启用接管 → 测试连接正常且提示写权限未验证 → 保存显示“已保存 · 未生效” → 应用显示“已生效” → 刷新显示调查、修复、求助和 PR 四阶段。随后模拟保存 409，页面显示 config_conflict，保留 fixture-new-label 草稿并禁用保存，提供采用保存版本/保留草稿重试入口。

明暗主题分别检查宽度 1280、980、760、680、375：10 组均无横向溢出，760 及以下表单单列，以上双列，按钮直角。等待主题色过渡结束后断言浅色主按钮为黑底米白字、深色为荧光绿底黑字，均通过。截图保存在本地忽略目录 `output/playwright/issue-976/{light,dark}-{1280,375}.png`。这是隔离布局/交互检查，不替代真实页面与主观视觉验收。

## 交给 #980

真实凭据权限、真实仓库接管配置的保存与应用、真实 IM、登录态页面及主观视觉验收均未执行。没有 push、tag、PR、发布、部署或生产服务/DB/配置写入；没有调整本 Issue/Run 生命周期。

## 文件归属

- 后端：`src/http/githubSettingsApi.ts` 与测试；`src/http/server.ts` 路由装配；`src/config/localSettings.ts` 串行原子写入；`src/integrations/github/issueSyncRuntime.ts` 与测试；`src/xuanwu/capabilityDispositionInventory.ts` 与对应清单测试。
- 前端：`src/api/githubSettings.js`；`src/pages/GitHubSettingsPanel.jsx`、CSS、样式测试；`githubSettingsModel.js` 与测试；`githubSettingsTests/panel.test.jsx`；`AssistantSettingsSections.jsx` 入口。
- 文档：本验证记录。
