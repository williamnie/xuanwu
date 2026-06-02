import { authHeader } from './authToken';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export const piActionGateApi = {
  approve: (id) => request(`/api/pi/actions/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
  auditEvents: (filter = {}) => request(`/api/pi/audit-events${query(filter)}`),
  pendingActions: () => request('/api/pi/actions?status=pending'),
  reject: (id) => request(`/api/pi/actions/${encodeURIComponent(id)}/reject`, { method: 'POST' }),
  requestChanges: (id, comment) => request(`/api/pi/actions/${encodeURIComponent(id)}/request-changes`, {
    method: 'POST',
    body: JSON.stringify({ comment }),
  }),
  snooze: (id, reason, until) => request(`/api/pi/actions/${encodeURIComponent(id)}/snooze`, {
    method: 'POST',
    body: JSON.stringify({ reason, until }),
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
  addParam(params, 'action_id', filter.actionId);
  addParam(params, 'conversation_id', filter.conversationId);
  addParam(params, 'issue_id', filter.issueId);
  addParam(params, 'project_id', filter.projectId);
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
