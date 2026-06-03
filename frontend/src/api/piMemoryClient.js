import { authHeader } from './authToken';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export const piMemoryApi = {
  disable: (id) => request(`/api/pi/memory/${encodeURIComponent(id)}/disable`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),
  list: (filter = {}) => request(`/api/pi/memory${query(filter)}`),
  promote: (id) => request(`/api/pi/memory/${encodeURIComponent(id)}/promote`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),
  remove: (id) => request(`/api/pi/memory/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  update: (id, updates) => request(`/api/pi/memory/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  }),
};

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(),
      ...options.headers,
    },
  });
  if (!response.ok) throw await responseError(response);
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function query(filter) {
  const params = new URLSearchParams();
  addParam(params, 'scope', filter.scope);
  addParam(params, 'scope_id', filter.scopeId);
  addParam(params, 'disabled', filter.disabled);
  const text = params.toString();
  return text ? `?${text}` : '';
}

function addParam(params, key, value) {
  if (value === undefined || value === null || value === '') return;
  params.append(key, String(value));
}

async function responseError(response) {
  const error = new Error(await readErrorMessage(response));
  error.status = response.status;
  return error;
}

async function readErrorMessage(response) {
  const text = await response.text();
  if (!text) return `请求失败: ${response.status}`;
  try {
    const data = JSON.parse(text);
    return data.message || `请求失败: ${response.status}`;
  } catch {
    return text;
  }
}
