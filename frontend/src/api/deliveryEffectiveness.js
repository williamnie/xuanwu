import { request } from './base.js';

export function getDeliveryEffectiveness(filters, { signal } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== '' && value != null) params.set(key, String(value));
  return request(`/api/system/delivery-effectiveness?${params}`, { signal });
}
