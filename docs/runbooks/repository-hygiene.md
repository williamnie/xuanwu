# Repository hygiene 与最终删除门禁

状态：canonical（XW P11.10）
审计基线：`58f3159da096420eac3fbff88843b36fc5f83e5d`（2026-07-19）

## Source of truth 与边界

- Runtime source of truth 仍是 `backend-ts/src/main.ts` 注册的服务、SQLite `issues` authority 及其 Work/Run/Attention projection；本清理不改 API、schema、状态机或数据。
- `Issues/Sessions compat v1` 仍按 `docs/migrations/issues-sessions-compat-v1.md` 保留到既定 consumer-zero/release 门禁。旧 page id 只投影到 Work、Runs、Automations 或 Command Center，不再拥有第二套 JSX/CSS。
- 测试 fixture、`docs/fixtures/`、产品图片和被 canonical 文档引用的资产不是运行产物；没有逐项 reference evidence 时不得按目录名批量删除。
- Build、smoke、截图和 benchmark 输出必须写入被忽略的目录或 `$RUNNER_TEMP`，不得把一次运行结果作为产品源码提交。

## 可执行审计

```bash
node scripts/repository-hygiene-audit.mjs --json
```

审计会确定性检查：

1. 已退役 frontend component/export 路径不存在；
2. `frontend/src/main.jsx` 的 production import graph 没有孤儿模块；
3. backend runtime、测试、显式工具入口和 `scripts/` 组成的 source reference graph 没有未分类孤儿模块；
4. Git index 没有 runtime/build 产物；
5. 已退役 export/component 和 `.issue-workflow-*`、`.session-create-*`、`.cron-page` selector 在 production source 中零引用；
6. `.gitignore` 覆盖 canonical runtime output roots。

历史 snapshot/research 文档可以保留当时的路径作为 provenance；它们不是 live reference。运行入口、served bundle、当前 source graph 和 Git index 的证据优先。

## 本次 delete list 与证据

| 类别 | 删除项 | 删除证据 |
| --- | --- | --- |
| 旧 API export | `frontend/src/api/{client,index}.js` 及仅验证 flat export 的 `index.test.js` | production import graph 为零；当前页面全部直接导入 domain `*Api` |
| 旧 Issue workflow heuristic | `IssueWorkflowEvidencePanel*`、`issueWorkflowEvidence*`、`issueWorkflowSnapshot.js` | `IssueDetail` 已使用 execution truth；结构测试明确禁止旧 heuristic |
| 已合并页面 | `AutomationsRuntimePanel.jsx`、`Cron.jsx` | `App.jsx` 只渲染 canonical `Automations.jsx`；旧 page id 由 `assistantModules.js` 投影 |
| 已替换 Session UI | `SessionCreateModal.*`、`sessionComposerHelp*` | production import graph 为零；现有 Session composer/workspace 是唯一 UI |
| 重复/失效 CSS | `index.css` 的 `.issue-workflow-*`、`GeekWorkbenchPages.css` 的 `.cron-page`/`.session-create-*`，以及孤儿 `SessionCreateModal.css` | 对应 DOM component 已删除；audit 固定 selector family 零定义 |
| 迁移前测试断言 | Automations cron slice、Issue deep-link、静态 `main-content` 三项断言 | 当前 canonical source 已分别使用 project labels、Work detail 和动态 main class；更新断言而不改 runtime |
| 仓库运行产物 | `output/architecture/*` | 全仓零引用；PNG/SVG/generator 共 3,459,065 bytes，目录改为 ignore-only output root |

`client.events.test.js` 与 `client.piDelegation.test.js` 虽沿用历史文件名，但直接验证当前 domain client，仍有有效覆盖，因此保留。`Issues.jsx`/`IssueDetail.jsx` 是 Work feature flag 的 rollback surface，不能作为普通 dead code 删除。

## Live reference 与迁移证据

清理前对 launchd `com.xiaobei.xuanwu` 做了只读检查：

- active binary 与 checkout `dist/xuanwu` SHA-256 相同：`42d73b63c53dbc7956c93d71237f208b0a5d64a6ed55c3de87f17b50cd60cbee`；
- active web root 与 `frontend/dist` 逐文件一致；served assets 不包含本次删除的 component/export symbol；
- `/health`、`/api/command-center/summary`、`/api/automations`、`/api/compatibility/legacy` 均返回 `200`；
- legacy `/api/pi/attention-inbox/items` 仍返回 `200 []`，因此只删除已无 consumer 的旧页面，不删除该 API、repository 或审计数据。

回滚只需重部署基线 commit/previous release artifact；本次无数据迁移、双写或双读变化。SQLite schema 对比必须保持完全相同。

## Before / after

同一 checkout、同一 `npm run build` 命令的结果：

| 指标 | Before | After | Delta |
| --- | ---: | ---: | ---: |
| tracked source 文件 | 1,306 | 1,293 | -13 |
| tracked source LOC | 243,591 | 242,203 | -1,388 |
| CSS 文件 / LOC | 41 / 12,905 | 40 / 12,601 | -1 / -304 |
| frontend bundle bytes | 2,038,023 | 2,034,322 | -3,701 |
| main CSS raw / gzip bytes | 64,475 / 12,388 | 60,768 / 11,838 | -3,707 / -550 |
| tracked `output/` bytes | 3,459,065 | 0 | -3,459,065 |

LOC 是 Git-tracked `frontend/src`、`backend-ts/src`、`scripts` 中 JS/JSX/MJS/TS/CSS/shell/Python 的 physical lines；After 包含新的 hygiene audit。Bundle 是 Vite `frontend/dist` 全文件大小；hash 文件名会随 build 改变。

## 验证与最终删除门禁

```bash
node scripts/repository-hygiene-audit.mjs --json
find frontend/src -name '*.test.js' -print0 | xargs -0 node --test
cd backend-ts && bun test --timeout 60000
cd ../frontend && npm run build
cd ../backend-ts && ./scripts/build-binary.sh
cd .. && ./dist/xuanwu --version
git diff --check
```

完成后还必须对新 binary + 新 web bundle 运行隔离 HTTP smoke，并确认 SQLite `sqlite_master` 的规范化 SHA-256 与清理前一致。任一 reference、build、test、binary smoke 或 schema 对比失败时，不得继续删除或标记 issue done。
