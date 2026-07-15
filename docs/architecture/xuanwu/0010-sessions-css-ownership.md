# Sessions CSS ownership 与视觉基线

状态：canonical（XW P01.08）

## Source of truth

| 层 | 文件 | Ownership |
| --- | --- | --- |
| 设计 token | `frontend/src/GeekWorkbench.css` | 只定义全局设计 token；不持有 Sessions selector |
| 列表与 transcript primitive | `frontend/src/pages/sessions/Sessions.css` | Session 列表、runtime header、消息、Markdown、tool/diff/terminal |
| 页面 composition | `frontend/src/pages/sessions/SessionsClient.css` | App sidebar portal、Sessions workspace、新会话布局、chat 布局及断点 |
| Composer component | `frontend/src/pages/sessions/SessionComposer.css` | Composer 内部控件、editor shell、queue/interrupt 状态及 Sessions/PI context |

`frontend/src/index.css` 和 `GeekWorkbenchPages.css` 不再定义 Sessions 页面 selector。共享尺寸只从 `GeekWorkbench.css` 的 `--sessions-*` token 读取；不存在双写或第二套样式模型。

## 重复 selector 清单与处置

| 重复/覆盖 | 原位置 | Canonical owner |
| --- | --- | --- |
| `.session-item-row` / `:hover` / `.active` | `Sessions.css` + `SessionsClient.css` | `Sessions.css` |
| `.session-list-loading` | `Sessions.css` + `SessionsClient.css` | `Sessions.css` |
| `.chat-bubble-container.user` | `Sessions.css` 内两份 | `Sessions.css` 单一规则 |
| transcript/message 最大宽度 | `Sessions.css` base + `SessionsClient.css` context | `Sessions.css` + `--sessions-*-max-width` |
| `.client-chat-composer-section .session-composer` | `SessionsClient.css` + `SessionComposer.css` | `SessionComposer.css` |
| `.composer-circle-submit` | `SessionsClient.css` + `SessionComposer.css` shared group | `SessionsClient.css`（NewSessionWorkspace） |
| prompt editor shell/content | `SessionsClient.css` + `SessionComposer.css` + `GeekWorkbenchPages.css` | `SessionComposer.css` |
| Sessions workspace/theme override | `SessionsClient.css` + `GeekWorkbenchPages.css` | `SessionsClient.css`，颜色继续消费全局 token |

自动门禁：`frontend/src/pages/sessions/sessionsStylesOwnership.test.js` 检查 token 单一来源、局部 ownership、已删除 selector 的 runtime/CSS 零引用，以及全局 selector 回归。

收敛后，三份 Sessions CSS 从 3092 行降至 2622 行；production Sessions CSS chunk 从 47.33 kB（gzip 8.51 kB）降至 38.37 kB（gzip 7.20 kB）。

## 删除的无引用规则

CSS 引用审计确认下列 DOM class 已不在 live JSX 中：

- 旧双栏 shell：`sessions-page`、`sessions-shell`、`sessions-sidebar`、`sessions-client-sidebar`
- 已下线过滤器/拖拽装饰：`session-list-filter-*`、`project-group-drag-handle`
- 已下线 macOS/底栏装饰：`sidebar-mac-header`、`mac-dot*`、`sidebar-bottom-*`
- 已下线 composer/error 装饰：`new-session-composer-footer`、`composer-icon-btn`、`session-error`

删除门禁由 ownership test 固定；新增同名 DOM 时必须先恢复对应组件 owner 下的局部样式，不得写回全局 CSS。

## 视觉基线

使用本地 Vite + 当前 Runner API，在同一 Chromium/主题/数据下比较 `HEAD` 基线与本次实现：

| 场景 | Viewport | 主工作区 crop | SSIM |
| --- | --- | --- | --- |
| 新会话 workspace | 1440×900 | `x=232..1439` | `1.000000` |
| 历史会话 chat | 1440×900 | `x=232..1439` | `0.999400` |
| 历史会话 chat | 760×900 | `x=60..759` | `0.999571` |
| 历史会话 chat（dark） | 1440×900 | `x=232..1439` | `0.998618` |

chat 的非零差异仅落在实时文本/相对时间、版本标识和滚动位置；关键 computed geometry（transcript `980px`、message/composer `900px`、composer radius `20px`、mobile gutter）与基线一致。截图与差分在验证时写入临时执行产物 `output/playwright/issue-644/{before,after,diff}`，不作为 runtime 资源或提交内容。

## 迁移、回滚与删除门禁

- 本次只迁移 CSS ownership，不修改 DOM、API、状态机或运行数据；没有双读/双写期。
- 回滚：revert 本 issue commit 即可一次恢复旧 cascade。
- 最终删除门禁：frontend build、ownership/style tests、1440/760 截图对比必须同时通过；任一失败时不得继续删除 legacy rule。
