# 前端精简验收记录

本机实施基线 `9acf05d6`；方案提交 `418966b5` 从 hermes 原样获取。远端只保留方案提交，不再写产品代码。所有写操作验证使用隔离数据或浏览器 API fixture，未对生产任务操作。

## B0 验收表（实施前）

| 检查 | 边界和用例 |
|---|---|
| 入口 | 工作台→待我处理、工作项→任务、问玄武→对话；执行记录和自动化保留；统计→底部更多 |
| 读取 | 原 API 不变 |
| 写入与副作用 | 仅导航、无新增业务写入 |
| 隐藏字段 round-trip | 不涉及表单 |
| 错误/空/部分 | 原界面保持；仅调整术语 |
| 旧深链 | route ID 与参数不变；feature flag 保持 |
| 草稿 | 不改变状态所有者 |
| 主题/断点 | 浅色、深色；980/760/680；导航更多可访问 |

验证结果待追加。

B0 结果：导航/品牌/侧栏样式 13 项通过，Bun 翻译资源 3 项通过；全前端 ESLint 与生产构建通过。真实 Chromium 已目检浅/深主题 1280、980、760、680px；移动端菜单和底部“更多”可展开。首次截图遇到 viewport 与主题切换的异步过渡，等待状态稳定后重拍复验；截图保存在 ignored `output/playwright/B0-*.png`。API fixture 的初始匹配曾拦截 `/src/api/` 模块，已收紧到 `/api/`，不属于产品回归。

## B1 验收表（实施前）

| 检查 | 边界和用例 |
|---|---|
| 入口 | 11项→项目/AI连接/通知与外部连接/通用/高级；高级6折叠节；外部连接仍为子Tab |
| 读取 | 原项目、编程工具、助手、通知、维护、技能、记忆、权限和处理记录API；高级首次展开才读目标面板 |
| 写入/副作用 | 原authorities不变；运行维护只PATCH/PUT并发字段，Codex配置只写对应字段；重启二次确认 |
| 隐藏字段 | 旧配置不因折叠或隐藏被清空；Plugin值保留于预设写模型；persona仍共用保存 |
| 错误/空/部分 | 请求失败保留错误；无就绪工具空态；诊断仍可导出完整数据 |
| 深链 | 旧11个section及advanced前缀映射；自动展开并定位目标节 |
| 草稿 | 已访问分区和已打开折叠区保留挂载；未访问不初始化 |
| 主题/断点 | 浅/深；980/760/680；折叠区、移动目录、表单不溢出 |

B1 结果：相关导航、结构、样式、项目表单、预设往返与Codex模式测试41项通过；全前端ESLint与构建通过。Chromium实测高级首次进入未请求子面板，展开维护仅请求status/token/runner/connectors，未请求技能或记忆、未预取日志；并发草稿“3”经收起重开、切换项目再回高级仍保留。刷新 `section=advanced:memory` 只展开记忆，未请求维护接口；11个旧section及前缀兼容有合同测试。明暗主题1280/980/760/680截图均无横向溢出并目检。新增执行预设入口并从项目编辑移走管理表单，项目只保留选择器；Plugin隐藏值回归通过。

B1 后端回归：runnerSettingsApi / codeAgentsApi 验证原保存、并发范围、Codex transport应用与工具开关合同；结果见后续记录。表达风格仍原地折叠，共用原handleAgentSave，C2再移到通用；外部连接仍保留原子Tab。

## C1 验收表与新增合同（实施前）

| 检查 | 边界和用例 |
|---|---|
| 入口 | 默认任务列表/可切换看板；任务/自动化子视图；详情现在怎样/结果/默认收起过程；替代可用后移除原一级入口 |
| 读取 | `/api/works`服务端项目/状态/搜索分页；可选`include_diagnostics=1`按分页项目分组只读投影依赖、暂停和工具状态；详情同事实。无需N+1HTTP或写readiness取数 |
| 新写合同 | `POST /api/works/:id/queue-state`只接受status=triage/todo、audit和expected_revision；只允许triage→todo、todo→triage、failed→triage，与原拖拽相同；Issue仍唯一authority，原PATCH白名单不扩大 |
| 既有写入 | enqueue/retry/cancel统一现有Work action并携带revision/audit；列表逐项对照workDropOperation；危险动作确认 |
| 隐藏字段 | 创建默认triage；标题/预设更多选项；不可用旧选择无损；项目上下文、单项目和上次项目 |
| 错误/空/部分 | 列表页失败不空态；分页失败保留已加载；事实不足不承诺可调度；请求冲突刷新；执行/结果分别提示缺失 |
| 深链 | B/C保持原route ID；Run可确定work_id时到详情；未知或无所属只读退路；Handoff保留 |
| Run/Attempt | 每次执行独立加载详情；每次尝试独立请求transcript/run_id+attempt_id和验证结果，保留选择，不以session全部历史替代 |
| 主题/断点 | 明暗、980/760/680；列表与三段详情、创建弹窗 |

队列状态新命令的设计原因：旧Issue PATCH没有Work revision保护，不能拿它假装与现有版本化Work action等价。该专用命令不允许直接转到done/failed/needs_user或修改运行中的任务，不扩大自动权限。只读诊断声明为事实投影，不把readiness=not_required或effective_provider当成可调度保证。

C1 结果：全前端670项通过；Work/Run/Evidence HTTP共27项，Issue adapter/依赖队列/迁移共16项通过（43项）；全前端ESLint和生产构建通过。TypeScript5.9.3全仓库153条诊断与9acf05d6临时只读源码快照逐条归一化对比一致，无新增；不把该基线噪音称为typecheck通过。

真实Chromium：列表服务端状态筛选、三段详情、Ctrl+K共用创建、单项目隐藏选择器、默认入队不勾选；创建请求明确status=triage+稳定audit.event_id，成功跳新任务。工具门禁最初正确拦住缺少issueExecution能力的fixture，补齐fixture后同一用例通过。过程关闭时验收仍在首段；展开执行默认第2次尝试，切换第1次只显示旧尝试文本且新文本消失，请求带对应attempt_id；收起重开保留选择。详情、列表、创建弹窗浅/深1280/980/760/680实测截图并目检，无横向溢出。对比发现旧详情的大渐变卡和嵌套色块与设计合同冲突，已统一为透明段落细线+标准请求卡，并重拍复核。

完整前端套件暴露10项仍断言旧UI的测试；已将其改成验证新的入口、隐藏UI但保留API、唯一状态所有者及权限/凭据边界，原业务合同断言保留，全套复验通过。未访问真实生产任务、未发送审批或创建真实任务。

## C2 验收表与聚合合同（实施前）

| 检查 | 边界和用例 |
|---|---|
| 入口 | 首页完整待处理聚合；任务详情首段同请求适配；通知+连接列表，首次打开抽屉才挂载；persona从AI移到通用 |
| 新只读合同 | `GET /api/command-center/inbox?page_size=50&cursor=...`聚合全部未结束Attention来源、开放HumanReview、失败任务和仍由助手持有的问题；完整分页，不套用25项/7天窗口，不建审批状态表 |
| 聚合一致性 | key=原始来源+请求ref；同proposal跨Attention去重；快照cursor指纹变化409要求刷新，读失败不显示空收件箱；可按work_id定位详情请求 |
| 写authority | HumanReview→原issue response带request id/revision、非accept必须意见；Attention→原actions带decision_ref及本类参数；ack/snooze才revision+audit；失败任务→原Work actions |
| GitHub | save→reload只用save response revision；reload_failed/runtime_unavailable保存待生效；config_conflict保留草稿并禁止自动用新revision重试；超时按自己的saved revision与配置对账 |
| 隐藏值 | Plugin原值、通知verbose映射、persona文本与revision、GitHub4权限false；不可用旧预设保留 |
| 懒挂载/草稿 | 抽屉关闭保持面板草稿，首次打开前无读请求；助手连接与persona独立保存/唯一状态所有者 |
| 错误/空/部分 | 超25及超7天请求都可到达；无任务审批；已失效/409各来源说明；未创建Work的GitHub Case仍可查看 |
| 深链/主题 | B/C route ID不变；section旧值定位；明暗与980/760/680，抽屉760以下全屏，焦点与Escape关闭 |

完整Attention新增读取范围只扩展只读候选覆盖：全部inbox记录、所有待处理Pi action及原Proposal，旧summary仍保留原限额。原Attention详情/动作按完整候选找到旧请求，决定仍交原authority；新来源仅描述现有pi_action_proposals表，无新业务状态或权限。

C2 结果：新增完整inbox按快照游标分页，115条来源记录读完、旧7天窗口外32个动作可读取、原提案只显示一次；保留原Authority、按原始请求ref区分，不合并同任务不同请求。旧版本缺少新读取时展示明确部分范围的Attention退路。新增task-glance使用真实done状态事件和浏览器日界，不能确认历史完成时间时不编造今日完成。当前41项相关后端测试、全前端685项（含独立保存/状态机/映射测试）通过，前端lint与构建通过；TS诊断153条与基线内容一致。

真实Chromium：无归属审批请求发送decision_ref并默认scope=turn，不带HumanReview revision。GitHub关闭重开保留draft-label；4权限均false；save gh-1返回gh-2后apply和重试均使用gh-2。reload_failed显示已保存待生效；模拟另一窗口other-99配置冲突后仍保留mine-keep草稿、保存禁用、无重试按钮且没有apply other-99。未创建任务的Case及映射冲突仍可在接管记录展开查看。

通用persona仅PATCH persona，expected_revision=3且旧个性/表达原值保留，AI未保存长期说明不变；409读取revision10后可恢复本地detailed草稿。授权状态与所选模型测试分开；读取旧连接保留openai-completions协议。首轮AI fixture把models错误写成对象数组导致option渲染失败，核对后端string[]合同后修正fixture，原用例复验成功。Playwright标签精确匹配含选项文字不一致导致选择器超时，改用新快照中的combobox角色复跑通过。

首页、GitHub抽屉（含冲突）、AI、persona、Telegram、飞书均已真实浏览器截图浅/深1280/980/760/680并目检；760及以下抽屉全屏，Escape返回入口且root.inert恢复false。输入/秘密只保存在本地草稿，测试写入均为API fixture；没有向真实GitHub、IM、任务或配置写入。通知verbose展示为及时+进展开关，历史规则不可见，当前规则操作保留；来源策略、技能运行、处理记录与权限透明度保留。
