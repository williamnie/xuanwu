import { request } from './base.js';

export const piMemoryApi = {
  batch: ({ action, ids }) => request('/api/pi/memory/batch', {
    method: 'POST',
    body: JSON.stringify({ action, ids }),
  }),
  create: (memory) => request('/api/pi/memory', {
    method: 'POST',
    body: JSON.stringify(memory),
  }),
  disable: (id) => request(`/api/pi/memory/${encodeURIComponent(id)}/disable`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),
  forget: (id) => request(`/api/pi/memory/${encodeURIComponent(id)}/forget`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),
  list: (filter = {}) => request(`/api/pi/memory${query(filter)}`),
  pin: (id) => request(`/api/pi/memory/${encodeURIComponent(id)}/pin`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),
  enable: (id) => request(`/api/pi/memory/${encodeURIComponent(id)}/enable`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),
  remove: (id) => request(`/api/pi/memory/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  update: (id, updates) => request(`/api/pi/memory/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  }),
};

function query(filter) {
  const params = new URLSearchParams();
  addParam(params, 'scope', filter.scope);
  addParam(params, 'scope_id', filter.scopeId);
  addParam(params, 'disabled', filter.disabled);
  addParam(params, 'status', filter.status);
  addParam(params, 'memory_type', filter.memoryType);
  addParam(params, 'layer', filter.layer);
  addParam(params, 'window', filter.window);
  const text = params.toString();
  return text ? `?${text}` : '';
}

function addParam(params, key, value) {
  if (value === undefined || value === null || value === '') return;
  params.append(key, String(value));
}
