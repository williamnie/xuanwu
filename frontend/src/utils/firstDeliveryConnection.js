export const FIRST_DELIVERY_CONNECTION_KEY = 'xuanwu-first-delivery-agent-test-v1';
const MAX_AGE_MS = 30 * 60 * 1000;

export function readFirstDeliveryConnectionTest(storage = globalThis.sessionStorage, now = Date.now()) {
  try {
    const value = JSON.parse(storage?.getItem(FIRST_DELIVERY_CONNECTION_KEY) || '{}');
    if (value?.ok !== true || !Number.isFinite(value?.tested_at_ms)) return null;
    if (now - value.tested_at_ms > MAX_AGE_MS || value.tested_at_ms > now + 60_000) return null;
    return value;
  } catch {
    return null;
  }
}

export function recordFirstDeliveryConnectionTest(result, storage = globalThis.sessionStorage, now = Date.now()) {
  if (!storage) return;
  if (result?.ok !== true) return clearFirstDeliveryConnectionTest(storage);
  storage.setItem(FIRST_DELIVERY_CONNECTION_KEY, JSON.stringify({
    ok: true,
    provider_id: String(result.provider_id || ''),
    status: String(result.status || 'connected'),
    tested_at_ms: now,
  }));
}

export function clearFirstDeliveryConnectionTest(storage = globalThis.sessionStorage) {
  storage?.removeItem(FIRST_DELIVERY_CONNECTION_KEY);
}
