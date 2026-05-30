# Codex Issue Runner Frontend

## API target

`vite.config.js` 的 `/api`、`/health` proxy 默认指向 Go stable：

```text
http://127.0.0.1:3008
```

切到 Bun preview 时只显式设置 `VITE_API_TARGET`，不要改默认配置：

```bash
VITE_API_TARGET=http://127.0.0.1:3018 npm run dev
```

预览已构建产物时同样使用这个变量：

```bash
npm run build
VITE_API_TARGET=http://127.0.0.1:3018 npm run preview
```

`VITE_API_BASE_URL` 仍保留给必须直连绝对 API 地址的场景；本地 Go/Bun 切换优先使用 `VITE_API_TARGET`，让前端继续走同源 proxy。

---

# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
