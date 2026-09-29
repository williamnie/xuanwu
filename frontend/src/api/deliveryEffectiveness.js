import { request } from './base.js';

export async function getDeliveryEffectiveness(filters, { signal } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== '' && value != null) params.set(key, String(value));
  // 取消旧筛选不会立即中止服务端的有界读取；短暂忙碌时有限重试，并随新筛选取消。
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await request(`/api/system/delivery-effectiveness?${params}`, { signal }); }
    catch (error) {
      if (error.status !== 429) throw error;
      if (attempt === 2) { error.message = '统计正在处理其他查询，请稍后重试。'; throw error; }
      await waitForReadBudget(250 * (attempt + 1), signal);
    }
  }
}

function waitForReadBudget(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
