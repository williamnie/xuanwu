import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const DEFAULT_API_TARGET = 'http://127.0.0.1:3008'

function resolveApiTarget(mode) {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env }
  return env.VITE_API_TARGET || DEFAULT_API_TARGET
}

function createApiProxy(target) {
  return {
    '/health': {
      target,
      changeOrigin: true,
    },
    '/api': {
      target,
      changeOrigin: true,
      ws: true,
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const proxy = createApiProxy(resolveApiTarget(mode))

  return {
    plugins: [react()],
    server: {
      port: 3568,
      proxy,
    },
    preview: {
      proxy,
    },
  }
})
