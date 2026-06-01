# Session Composer v2 Contract

Session Composer v2 负责把 UI 输入、附件、引用和运行参数组合成 provider 可消费的 session/message 请求。

## 当前边界

- HTTP API 位于 Bun 后端 `backend-ts/src/http/sessionApi.ts` 等文件。
- 生成内容仍走现有 prompt 文本通道。
- 附件引用保留为 provider 输入转换层处理，避免 UI 直接耦合某个 provider 的私有协议。

## 输入约束

- `prompt` 可以为空，但必须能区分“只创建 session”和“创建后立即发消息”。
- `project_id` 可用于继承项目 cwd / provider / model / sandbox / approval policy。
- 运行参数优先级：请求显式传入 > 项目配置 > provider 默认值。

## 验证

```bash
cd backend-ts
bun test src/http/sessionApi.test.ts src/http/sessionInterruptApi.test.ts src/providers/codex
```
