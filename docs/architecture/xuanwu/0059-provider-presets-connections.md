# Provider 推荐卡片与连接合同

- 状态：Accepted
- 日期：2026-07-17
- 依赖：[玄武产品导航与兼容路由合同](0050-product-navigation-compatibility.md)
- canonical 级别：`pi-runtime/agent/models.json` 与 `pi_agents` 继续分别作为 provider 连接配置和默认 Supervisor 选择的 source of truth；`pi-runtime/agent/auth.json` 继续作为 PI OAuth credential store

## 1. 普通设置与 Advanced

普通 `Models & Agents` 只展示 OpenAI、Codex、Anthropic 推荐卡片、脱敏连接状态、API key/OAuth 入口、模型选择和显式连接测试。provider ID、base URL、API type、thinking、User-Agent 与 runtime instructions 只在 `Advanced / Model runtime` 编辑；自定义 provider 也只从该入口维护。

推荐卡片不持久化第二份配置。`GET /api/pi/provider-settings/catalog` 从版本化 preset 与 `pi-ai` 内置 model catalog 生成只读 projection；保存仍调用现有 provider settings 与 PI agent writer。OpenAI + `gpt-5.4` 保持当前默认选择，不在读取时后台改写已有 provider/model。

## 2. 连接测试与模型发现

`POST /api/pi/provider-settings/:id/test-connection` 使用请求中的未保存配置或现有已保存配置，对 API-key provider 的 `/models` 执行一次显式只读探测；禁止 redirect，限制为 `http/https`，拒绝 URL 内凭据、query 和 fragment，并设置 10 秒超时。成功响应中的模型 ID 与本地 catalog 合并为当前页面选项，但只有用户保存后才进入 source of truth。

Codex OAuth 的连接测试只验证 PI OAuth credential store 已配置并返回本地 model catalog，不读取 Codex CLI token，也不把 credential 放进响应。API key、OAuth token、provider 错误 body 均不得出现在 HTTP response 或 audit payload；旧 key 继续以 `api_key_configured` 布尔值表示。

## 3. 审计、兼容与回滚

- provider 保存记录 `provider_settings_updated`；连接测试记录 `provider_connection_tested`；OAuth 开始、完成、失败和退出分别记录 `provider_oauth_*` 到现有 `pi_action_events`。
- 本变更没有 schema、provider adapter、共享状态机、双写或双读。运行时继续只读 `models.json`、`pi_agents` 与 PI `auth.json`；catalog 和连接测试结果只存在于请求/前端内存。
- 旧 `/api/pi/provider-settings`、OAuth API 和 Advanced 原始表单保持兼容。回滚只需恢复普通设置组件并移除两个 additive route；现有 provider、agent、OAuth 数据无需迁移或回放。
- 最终删除 Advanced 原始表单只能在自定义 provider、所有 API type、thinking/instructions 与 credential rotation 都有等价受审计入口，且一个正式 release 的 consumer-zero 证据、clean-baseline Settings journey、P11.05 与 G7 同时通过后执行。

## 4. 验证门禁

focused verification 必须覆盖：推荐默认稳定；API-key 连接成功与失败；自定义 OpenAI-compatible provider；远端模型 ID 发现；OAuth configured/not-configured；保存、连接和 OAuth audit 不含 secret；普通页面不渲染 raw base URL/API type/thinking；前端 production build 通过。
