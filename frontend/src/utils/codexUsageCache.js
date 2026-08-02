const CODEX_USAGE_CACHE_KEY = 'ai-usage-dashboard-v2';

export function readCodexUsageCache(storage) {
  try {
    const target = storage ?? globalThis.localStorage;
    const data = JSON.parse(target?.getItem(CODEX_USAGE_CACHE_KEY) || 'null');
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

export function writeCodexUsageCache(data, storage) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  try {
    const target = storage ?? globalThis.localStorage;
    target?.setItem(CODEX_USAGE_CACHE_KEY, JSON.stringify(data));
  } catch {
    // localStorage 不可用时仍保留当前页面内的数据。
  }
}
