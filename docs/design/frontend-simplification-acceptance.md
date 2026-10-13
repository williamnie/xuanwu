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

## D 验收表与合同（实施前）

| 检查 | 边界和用例 |
|---|---|
| 来源查询 | source=github同时用于Issue adapter同一where计数/分页/cursor指纹；external_links每轮调查修复历史均匹配，兼容旧tracker link/current Case；不对前端已加载数据假筛选 |
| 创建恢复 | 新只读creation-result按稳定audit.event_id对账；created返回原任务，不存在只能显式重试相同event id；批量逐条成功/失败/未知，不自动拆多行，不自动重试未知 |
| 路径校验 | 新GET项目路径校验只stat和git rev-parse，不导入、不启动执行；项目导入POST仅用户点击，说明既有项目开启自动执行 |
| 引导 | 准备AI/选项目/开始首任务；后台健康失败才插入修复；已就绪工具自动预选，助手仍独立授权且连接测试有效；同任务done+通过验证+交付才能结束 |
| 飞书发现 | 显式启动短期挑战，仅已验证入站消息中匹配挑战的来源标识可被发现；只存临时标识，不放开allowlist、不保存消息正文；确认时版本校验并只加入选中来源 |
| 路由 | 写入前覆盖旧work/path/workId/issueId/Handoff、Run优先Session、无归属只读、conversation/project/filter、workBoard flag、settings section、history刷新复制；新inbox/tasks映射保持全部旧入口 |
| 隐藏字段 | batch只映射已有agent_profile_id；triage默认；预设Plugin原值；未知/不可用旧选择无隐式清空；配置与草稿保持 |
| 错误/主题 | 409/404/超时/部分结果明确，无false empty；浅深主题980/760/680真实浏览器回归；相关前后端与style/lint/build/hygiene/Golden Journeys |


D 结果：新来源筛选由同一数据库谓词完成计数/分页/游标，历史调查与修复轮次均可见；只读创建对账以原审计 ID 返回已创建任务。飞书挑战有效期两分钟、易失有界、只捕获最小 ID，绑定启动时配置 revision；换应用或跨窗口保存后不能借新 revision 授权旧候选。原事件认证、名单和秘密引用保持，挑战消息不写普通入站库。

真实 Chromium（API fixture）：代码围栏和多行段落未被拆散；两条批量任务分别使用稳定审计 ID，均为 triage。第二条模拟提交后超时，未知项重试禁用；切换单个/批量保持原结果，核对后找到原任务，POST 总数仍为 2。飞书未保存草稿禁用发现，空发现明确提示；授权 body 只含 candidate_id/scope/expected_revision，旧群名单保留。旧 work 链接保留 project/focus/query/source，改动后生成 tasks 链接；后退、前进、复制再刷新仍保持筛选，API 实际收到 q/source/status/project_id。三步引导自动识别已配置连接，路径提示可见，显式创建的示例为 todo，未伪造交付完成。

明暗主题 1280/980/760/680 的批量弹窗、飞书发现、任务列表及引导已截图目检，无横向溢出。初轮截图捕获主题过渡，等待稳定后重拍；初次路由改名误改了图标 key，浏览器发现后修复并复跑。一次脚本使用 UI query 名查询后端请求而超时，核对 API 的 q 参数后重跑成功；一次移动断点下点击桌面侧栏入口不在视口，恢复桌面宽度后复跑成功。截图和 fixture 仅在 ignored output/playwright，不作为在线 IM/GitHub 或真实编程工具执行验收。

全量后端 2780 项通过（6 snapshots）；前端 691 项通过；lint/生产构建、仓库卫生与 Golden Journeys 通过。TypeScript 5.9.3 仍为原基线 153 条诊断，规范化内容一致，没有新增；不能声明全仓 typecheck 通过。新增飞书 revision 绑定后相关 170 项与定向 5 项再次通过。能力清单和 API route snapshots 已逐项同步，严格覆盖断言保留；移走的旧展示组件已删除，安全/状态/helper 测试迁到现有承接入口，避免旧 UI 留成孤儿。

最终自查补回已关联任务的 Run 中断/继续/重试入口：位于过程的“执行操作”，复用既有 RunContextBar、run/attempt revision 和审计接口；历史 Attempt 或没有确定归属时保持只读。Run 切换立即清空旧记录并使旧请求失效。最终评审按精确分支与 commit 进行，由 Claude 自行 fetch/diff；不传输整份代码。

最终前端 692 项（172 文件）通过，lint/build 再次通过。浏览器补验：旧 Attempt 不出现执行操作；当前 Attempt 的中断请求提交 run revision=9、attempt revision=7 与新审计 ID，返回后显示审计已提交。第一次 control fixture 漏了 API 的 actions 路径段，修正精确路径并刷新后原用例通过。


## 最终 Claude 评审及修复

Claude 在 hermes 只读 fetch/show/diff 评审了 `7f11f96b`，没有修改工作区、没有运行测试。发现 3 个需修复项，另有 4 个低风险观察和 1 个方案层面差异。

| 项目 | 处理和证据 |
|---|---|
| 1：all 链接丢失，旧 work 默认变 active | tasks 显式写 focus；旧 work/issue 无 focus 保持 all，新 tasks 默认 active。合同测试及 Chromium 复制/刷新、旧默认值复验通过 |
| 2：日志刷新覆盖后续页、全量读取过频 | 仅订阅状态/审核事件，2 秒合并；追加页与正在加载时标记更新；定时刷新只作用于未追加页的空闲列表。相同保护应用任务列表。真实 EventSource fixture 发出 40 条 issue.log 与状态事件，两处 105 行均保留；追加两页只发两次读取，显式刷新后才重置 |
| 3：无盐秘密摘要公开 | 使用服务端进程私有 randomBytes(32) 密钥进行 HMAC，不公开密钥；同一进程 revision 稳定，秘密变化仍触发版本冲突。进程重启时旧 revision 失效，需重新读取；发现会话本身也是易失状态 |
| 4：时间格式混用 | 排序和同 key 新旧比较先将 SQLite UTC 与 ISO 时区时间转换为 epoch；UTC/offset 混用测试通过 |
| 5：Run 失败/无 Attempt 保持 loading | 响应不匹配、读取错误、无尝试均结束加载；Chromium 500/空尝试用例不再出现持续 spinner |
| 6：单 Attention 查询仍做完整来源读取 | 低风险性能观察已记录；本次保留完整 alias/authority 解析，避免引入定点查询漏项。减少自动全量查询触发后，不再随 provider 日志反复扫描；大历史下定点查询优化另行处理 |
| 7：Git 归属错误误报非仓库 | 区分 dubious ownership/safe.directory、Git 不可用、超时、非仓库与未知检查失败；定向测试通过 |
| 8：部分 HumanReview kind 的按钮少于底层三种动作 | 按已确认方案 5.3 的每种请求按钮保持实现；底层 API 未收窄。评审确认属于方案差异，非本轮阻塞，未自行改变产品决定 |

修复后前端 695 项通过，后端相关 32 项通过；lint/build/仓库卫生通过，TS 153 条基线诊断无新增。所有浏览器请求仍为隔离 fixture，没有向在线服务提交业务操作。修复 commit 推送后，仅发送 commit/diff 引用给原 Claude 会话复核。

补充传输边界：只有接收器的已认证 WebSocket 消息，或已通过 token/签名校验的 HTTP 回调，能捕获发现候选。长连接配置下空 token 的 HTTP 请求不能冒充 WebSocket（包括伪造 authenticated=true）；挑战消息仍不入普通消息库。发现/授权请求期间禁用同一配置表单，防止响应覆盖中途编辑。新增安全用例及全部飞书相关 171 项通过。

修复版最终完整后端 2783 项（486 文件、6 snapshots）通过；前端 695 项（173 文件）与 lint/build 通过。Golden Journeys、仓库卫生、diff check 通过；TS 153 条诊断与原基线一致。浏览器延迟授权用例确认写入期间表单不可编辑、返回后恢复，避免覆盖中途草稿。
