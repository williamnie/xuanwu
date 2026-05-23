# Provider-aware Sessions 信息架构评估

> Issue #42：先评估多 provider 后 Sessions 的信息架构；不实现 Claude/opencode/Kimi Code adapter，不做假跨 provider 数据。

## 短结论

- **当前 source of truth 是 Codex threads**：`GET /api/sessions` 走 `runner.ListSessions -> codex.ThreadList`，详情走 `runner.ReadSession -> codex.ThreadResume`；本仓库没有独立 Session store。
- **当前搜索已满足短期需求**：`Sessions.jsx` 只对已加载 Codex sessions 的 `name` / `preview` 做前端过滤；这足够作为临时快速过滤，但不是跨 provider / transcript 搜索。
- **多 provider IA 推荐：项目分组为主，provider 作为过滤与行级标识**。不要按 provider 拆成多个孤立 Sessions 页面；应支持 `provider + project` 双过滤。
- **Session ID 必须 provider namespace**：UI route、pin、本地状态、API action 都不应只用裸 `thread_id` / `session_id`，应使用 `{provider}:{provider_session_id}` 这样的稳定复合 key。
- **Export Markdown 应等待 transcript normalization**：不同 provider 的 transcript schema 差异会影响消息、工具调用、审批、附件和状态呈现；不应在 normalization 前做“通用导出”。
- **#42 建议关闭为架构评估，并拆后续 implementation issues**；不要改回继续做搜索/导出 v1。

## 当前实现事实

### Source of truth

当前 Sessions 页没有自己的持久化 session 表：

- `frontend/src/api/client.js` 的 `getSessions()` 调 `GET /api/sessions`。
- `backend/internal/api/sessions.go` 把 list/read/create/message/interrupt 转给 `runner`。
- `backend/internal/runner/sessions.go` 的 list/read/create/message/interrupt 都先 `prepareCodex()`，再调用 Codex client。
- `backend/internal/codex/adapter_sessions.go` 映射到 Codex RPC：`thread/list`、`thread/resume`、`thread/start`、`turn/start`、`turn/interrupt`。

因此当前“会话列表与详情”的权威数据是 Codex app-server 的 thread，而不是 SQLite。

### 当前可用于区分的字段

`backend/internal/codex/sessions_types.go` 当前保留了这些 Codex thread 字段：

- 身份：`id`、`sessionId`
- 归属/路径：`cwd`、`path`
- 展示：`name`、`preview`、`createdAt`、`updatedAt`、`status`
- Codex 运行信息：`modelProvider`、`cliVersion`、`source`、`threadSource`、`agentNickname`、`agentRole`
- 内容：`turns`
- 本仓库派生字段：`origin`、`isRunning`

当前 `origin` 只有 **Codex provider 内部来源** 语义：

- `runner`：命中正在运行的 runner thread、SQLite issues 中保存的 `codex_thread_id`，或 `source/threadSource` 以 `codex-issue-runner` 开头。
- `codex_app`：其余 Codex App / CLI sessions。

这不能等同于未来的 agent provider。`modelProvider` 也更像模型后端/模型供应商，不应当作为 Claude Code、opencode、Kimi Code 这类 **agent runtime provider** 的稳定标识。

### 当前搜索能力

`frontend/src/pages/Sessions.jsx` 当前搜索逻辑：

- 只在客户端过滤已加载的 `sessions`。
- 只匹配 `session.name` 和 `session.preview`。
- 不请求后端，不搜索 transcript，不跨分页全量索引。
- 搜索结果仍进入当前 `VirtualSessionList`，按 `cwd -> project` 分组显示。

短期这已经覆盖“在当前已加载 Codex 会话中快速找标题/摘要”的需求；不建议在 provider/session 架构未定前继续做更深搜索。

## 推荐 IA

### 列表组织

推荐顺序：

1. **全局 Sessions 页面**：保留一个统一入口，不为每个 provider 做完全独立页面。
2. **项目分组优先**：延续当前 `cwd -> project` 分组，因为用户工作流主要按 repo/project 组织。
3. **provider 过滤 + 行级标识**：顶部或侧栏提供 provider filter：`All / Codex / Claude Code / opencode / Kimi Code`；每行显示低权重 provider badge/dot。
4. **project filter 可选增强**：当项目多、provider 多时，提供 `provider + project` 双过滤；默认仍按项目组浏览。

不推荐第一版做“按 provider 分组再按 project 分组”的主 IA：这会把同一项目的多 agent 运行历史拆散，也会和当前 project-first 的 issue runner 语义冲突。

也不推荐“只有当前 provider 的 session 单独页面”：短期实现简单，但会让跨 provider 比较、搜索、issue run 回溯和后续 export 都返工。

### ID 与路由

需要引入 provider namespace：

```text
provider_id            # codex | claude-code | opencode | kimi-code
provider_session_id    # provider 原始 thread/session id
session_key            # `${provider_id}:${provider_session_id}`
```

原因：

- 不同 provider 的 `thread_id` / `session_id` 格式和冲突域不同。
- 前端当前 `selectedId`、pin localStorage、详情路由、message/interrupt action 都默认裸 id；多 provider 后会误路由。
- 后端 issue/run 记录未来也不应只存 `codex_thread_id`，而应存 provider + provider run/session metadata。

Codex 现有 `codex_thread_id` 可以先保留，新增 provider-aware 字段时再兼容迁移；不要为了 #42 大改 schema。

### 搜索范围

推荐语义：

- 搜索应遵循当前 filter scope。
- 当 provider filter 是 `All` 时，搜索跨 provider。
- 当 provider filter 选中某个 provider 时，只搜该 provider。
- transcript 搜索应等 normalized transcript / index 后再做。

短期保持当前 Codex-only、loaded-page、name/preview 搜索即可。

### Export Markdown

Export Markdown 需要 provider-specific transcript adapter，但对外应基于 normalized transcript：

```text
provider raw transcript
  -> provider adapter normalize
  -> common transcript model
  -> markdown exporter
```

原因：

- Codex 当前 UI 直接渲染 `turns/items`，并有 Codex-specific tool item 类型。
- Claude Code、opencode、Kimi Code 的消息、tool call、approval、附件、状态和 usage schema 都不会与 Codex 完全一致。
- 先做“通用 Export Markdown”会把 Codex renderer 细节固化成公共契约，后续必然返工。

如果一定要先做导出，只能做明确标注的 **Codex-only export**；但 #42 后续不建议这么做。

## Codex session watcher 与 provider-aware store 边界

当前 `backend/internal/sessionwatch` 的职责很窄：

- 监听 `~/.codex/sessions/**/*.jsonl`。
- 从文件名提取 Codex thread UUID。
- 发布 `session.created` / `session.updated` 到既有 SSE bus。
- 不解析 transcript，不落库，不判断 provider。

多 provider 后推荐边界：

- **Codex watcher**：仍只是 Codex provider 的 invalidation bridge，事件应带 `provider_id=codex` 和 raw `provider_session_id`。
- **Provider adapter**：负责 list/read/resume/interrupt/approval/transcript normalize；Codex adapter 继续包 `thread/*` RPC。
- **Provider-aware session service/store**：保存或缓存 normalized session index，包括 provider、project/cwd、title/preview、status、timestamps、capabilities、raw pointer。
- **Frontend Sessions**：消费 provider-aware API，不直接假设 Codex `thread_id` 或 Codex `turns/items`。

不要把 `sessionwatch` 扩成通用 store，也不要让前端通过 fake provider 数据模拟跨 provider。

## #42 后续建议

建议 **关闭 #42**，作为 provider-aware IA 评估完成；后续拆分，不改回继续实现搜索/导出。

建议拆出的 implementation issues：

1. **Provider-aware session identity/API contract**
   - 定义 `provider_id`、`provider_session_id`、`session_key`、`origin`、`project_id/cwd`、`capabilities`。
   - 让 `/api/sessions` 支持 provider/project filter，但第一版只返回 Codex。

2. **Codex provider wrapper for Sessions**
   - 把现有 `thread/list/read/resume/turn/interrupt` 包进 Codex provider adapter。
   - 前端切到 `session_key`，pin/selected/action 全部 provider-qualified。

3. **Normalized transcript model + Codex transformer**
   - 定义 common transcript item schema。
   - 先实现 Codex raw `turns/items` 到 normalized transcript 的 transformer 与测试。
   - Export Markdown 在这个 issue 之后再做。

4. **Provider-aware session events/watchers**
   - 让 Codex session watcher 发布 provider-qualified events。
   - 前端根据 `provider_id + provider_session_id` 精准刷新列表/详情。

5. **Search v2 after normalized index**
   - 在 provider/project filter scope 内搜索 title/preview/transcript。
   - 明确当前 filter 为 `All` 时才跨 provider。
