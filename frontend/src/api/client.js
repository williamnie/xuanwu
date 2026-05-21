/**
 * Codex Issue Runner API 客户端。
 *
 * 这里不做本地假数据或 localStorage 降级：前端展示的数据必须来自 Go 后端。
 * 后端未连接时，请求会直接抛错，由页面显示 DISCONNECTED / 错误态。
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function readErrorMessage(response) {
  const text = await response.text();
  if (!text) {
    return `请求失败: ${response.status}`;
  }

  try {
    const data = JSON.parse(text);
    return data.message || `请求失败: ${response.status}`;
  } catch {
    return text;
  }
}

function subscribeToEvents(onEvent, onError) {
  const eventSource = new EventSource(`${API_BASE}/api/events`);

  eventSource.onmessage = (event) => {
    try {
      onEvent(JSON.parse(event.data));
    } catch (err) {
      console.error('解析 SSE 消息失败:', err, event.data);
    }
  };

  eventSource.onerror = (err) => {
    if (onError) {
      onError(err);
    }
  };

  return () => eventSource.close();
}

export const api = {
  getProjects: () => request('/api/projects'),

  syncCodexProjects: () => request('/api/projects/sync/codex', {
    method: 'POST',
    body: JSON.stringify({}),
  }),

  createProject: (project) => request('/api/projects', {
    method: 'POST',
    body: JSON.stringify(project),
  }),

  getProject: (id) => request(`/api/projects/${id}`),

  updateProject: (id, updates) => request(`/api/projects/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  }),

  deleteProject: (id) => request(`/api/projects/${id}`, {
    method: 'DELETE',
  }),

  startProjectLoop: (id) => request(`/api/projects/${id}/loop/start`, {
    method: 'POST',
  }),

  stopProjectLoop: (id) => request(`/api/projects/${id}/loop/stop`, {
    method: 'POST',
  }),

  getProjectLoopStatus: (id) => request(`/api/projects/${id}/loop/status`),

  getIssues: (projectId = '', status = '') => {
    const params = new URLSearchParams();
    if (projectId) params.append('projectId', projectId);
    if (status) params.append('status', status);
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/issues${query}`);
  },

  createIssue: (issue) => request('/api/issues', {
    method: 'POST',
    body: JSON.stringify(issue),
  }),

  getIssue: (id) => request(`/api/issues/${id}`),

  updateIssue: (id, updates) => request(`/api/issues/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  }),

  enqueueIssue: (id) => request(`/api/issues/${id}/enqueue`, {
    method: 'POST',
  }),

  retryIssue: (id) => request(`/api/issues/${id}/retry`, {
    method: 'POST',
  }),

  cancelIssue: (id) => request(`/api/issues/${id}/cancel`, {
    method: 'POST',
  }),

  getIssueEvents: (id) => request(`/api/issues/${id}/events`),

  getSessions: ({ limit = 50, cursor = '' } = {}) => {
    const params = new URLSearchParams();
    if (limit) params.append('limit', String(limit));
    if (cursor) params.append('cursor', cursor);
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/sessions${query}`);
  },

  createSession: (session) => request('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(session),
  }),

  getSession: (id) => request(`/api/sessions/${id}`),

  sendSessionMessage: (id, prompt) => request(`/api/sessions/${id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  }),

  interruptSession: (id) => request(`/api/sessions/${id}/interrupt`, {
    method: 'POST',
  }),

  subscribeToEvents,
};
