# Provider 推荐卡片与连接合同

- 状态：Accepted
- 日期：2026-07-17
- 依赖：[玄武产品导航与兼容路由合同](0050-product-navigation-compatibility.md)
- canonical 级别：`pi-runtime/agent/models.json` 与 `pi_agents` 继续分别作为 provider 连接配置和默认 Supervisor 选择的 source of truth；`pi-runtime/agent/auth.json` 继续作为 PI OAuth credential store

## 1. Connections 与 Advanced

顶层 `Connections → AI Providers` 展示 OpenAI、Codex、Anthropic 推荐卡片、脱敏连接状态、API key/OAuth 入口、provider 可用模型和显式连接测试；保存只写 provider authority，不改变 Supervisor 默认选择。provider ID、base URL、API type 与 User-Agent 收进同页的“自定义 / 高级 Provider”折叠入口，不再作为独立页签。`Connections → PI Agent` 维护 Supervisor 名称、provider/model 默认选择、thinking、instructions 与 enabled；`Settings → Models & Agents` 暂保留同一组件的兼容入口，两处复用同一 agent writer，不产生第二份状态。选择远端发现但尚未登记的新模型时，只把该 model ID 登记到现有 provider 后再保存 agent，不改写 credential。

推荐卡片不持久化第二份配置。`GET /api/pi/provider-settings/catalog` 从版本化 preset 与 `pi-ai` 内置 model catalog 生成只读 projection；保存仍调用现有 provider settings 与 PI agent writer。OpenAI + `gpt-5.4` 保持当前默认选择，不在读取时后台改写已有 provider/model。

## 2. 连接测试与模型发现

`POST /api/pi/provider-settings/:id/models` 使用请求中的未保存配置或现有已保存配置读取远端 model API；显式连接测试 `POST /api/pi/provider-settings/:id/test-connection` 复用同一发现链路。API-key provider 读取 `/models`，禁止 redirect，限制为 `http/https`，拒绝 URL 内凭据、query 和 fragment，并设置 10 秒超时。远端成功返回非空模型列表时，所有模型编辑控件只显示下拉选项；远端请求失败或返回空列表时才显示 model ID 手填兜底。模型发现结果只存在于当前请求和前端内存，只有用户保存后才进入 source of truth。

Codex OAuth 先验证 PI OAuth credential store，再通过当前 Codex provider 的 `model/list` 获取真实远端模型，不用 `pi-ai` 本地 catalog 充当可用模型列表，也不读取或回显 Codex CLI token。API key、OAuth token、provider 错误 body 均不得出现在 HTTP response 或 audit payload；旧 key 继续以 `api_key_configured` 布尔值表示。

## 3. 审计、兼容与回滚

- provider 保存记录 `provider_settings_updated`；连接测试记录 `provider_connection_tested`；OAuth 开始、完成、失败和退出分别记录 `provider_oauth_*` 到现有 `pi_action_events`。
- 本变更没有 schema、provider adapter、共享状态机、双写或双读。运行时继续只读 `models.json`、`pi_agents` 与 PI `auth.json`；catalog 和连接测试结果只存在于请求/前端内存。
- 旧 `/api/pi/provider-settings`、OAuth API 保持兼容；原独立 Custom Provider 页签折叠进 Connections AI Providers，PI Agent 页签与 Settings Models & Agents 复用既有 agent 表单和 writer，不迁移 provider、agent 或 OAuth 数据。
- 删除旧 `advanced:model-runtime` 内容 carrier 后仍保留确定性 redirect；最终删除该兼容输入必须有一个正式 release 的 consumer-zero 证据、旧 deep-link 测试、P11.05 与 G7。

## 4. 验证门禁

focused verification 必须覆盖：推荐默认稳定；API-key 连接成功与失败；自定义 OpenAI-compatible provider；远端模型 ID 发现；OAuth configured/not-configured；保存、连接和 OAuth audit 不含 secret；普通页面不渲染 raw base URL/API type/thinking；前端 production build 通过。
