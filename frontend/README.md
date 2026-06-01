# Codex Issue Runner Frontend

## API target

`vite.config.js` 的 `/api`、`/health` proxy 默认指向 Bun live：

```text
http://127.0.0.1:3008
```

临时指向其他 API 时显式设置 `VITE_API_TARGET`：

```bash
VITE_API_TARGET=http://127.0.0.1:3999 npm run dev
```

预览已构建产物时同样使用这个变量：

```bash
npm run build
VITE_API_TARGET=http://127.0.0.1:3008 npm run preview
```

`VITE_API_BASE_URL` 仍保留给必须直连绝对 API 地址的场景；本地优先使用 `VITE_API_TARGET`，让前端继续走同源 proxy。
