import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'

const DEFAULT_API_TARGET = 'http://127.0.0.1:3008'
const FALLBACK_APP_VERSION = 'unknown'

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

function resolveAppVersion(mode) {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  return firstValue(
    env.VITE_APP_VERSION,
    env.XUANWU_VERSION,
    tagRefVersion(env),
    gitDescribeVersion(),
    FALLBACK_APP_VERSION
  )
}

function tagRefVersion(env) {
  return env.GITHUB_REF_TYPE === 'tag' ? env.GITHUB_REF_NAME : ''
}

function gitDescribeVersion() {
  try {
    return execFileSync('git', ['describe', '--tags', '--dirty', '--always'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

function firstValue(...values) {
  return values.map(value => `${value || ''}`.trim()).find(Boolean) || FALLBACK_APP_VERSION
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const proxy = createApiProxy(resolveApiTarget(mode))
  const appVersion = resolveAppVersion(mode)

  return {
    define: {
      __XUANWU_APP_VERSION__: JSON.stringify(appVersion),
    },
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
