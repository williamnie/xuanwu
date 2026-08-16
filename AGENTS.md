# 仓库 Agent 规则

- 除非用户明确表示要使用 git worktree，否则不要创建、切换或依赖额外 worktree；默认在当前工作区完成排查、修改、验证与提交。

## 前端设计系统

- 凡新增或修改 `frontend/` 下的页面、组件、布局、主题或样式，开工前必须完整阅读 `docs/design-system/README.md` 与 `docs/design-system/spec.md`。
- `docs/design-system/spec.md` 是视觉与交互设计合同；实现必须复用既有令牌和组件，不得自行引入新的颜色、圆角、字号、阴影、图标体系或动效语言。
- 设计规范、`docs/design-system/tokens.css`、运行时令牌和样式测试必须保持一致；发现冲突时在同一改动中对齐，不得静默选择其中一套。
- 完成 UI 修改后，必须检查浅色、深色及相关响应式断点，并运行对应前端样式测试。
- 只有用户显式调用 `$xuanwu-ui` 或明确要求启用玄武 UI 风格时才使用全局 `xuanwu-ui` skill；不得把该风格自动套用到其他项目。
