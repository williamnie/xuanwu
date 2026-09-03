import { request } from './base.js';

export const runsApi = {
  getRuns: ({ page = 1, pageSize = 50, projectId = '', provider = '', status = '', workId = '' } = {}, options = {}) => {
    const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    if (projectId) params.append('project_id', projectId);
    if (provider) params.append('provider', provider);
    if (status) params.append('status', status);
    if (workId) params.append('work_id', workId);
    return request(`/api/runs?${params.toString()}`, options);
  },

  getRun: (id, options = {}) => request(`/api/runs/${encodeURIComponent(id)}`, options),

  getRunTranscript: (id, { attemptId = '', beforeId = '', limit = 100 } = {}, options = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (attemptId) params.set('attempt_id', attemptId);
    if (beforeId) params.set('before_id', String(beforeId));
    return request(`/api/runs/${encodeURIComponent(id)}/transcript?${params.toString()}`, options);
  },

  getRunEvents: (issueId, { beforeId = '', limit = 100, types = [] } = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (beforeId) params.append('before_id', String(beforeId));
    types.forEach(type => params.append('type', type));
    return request(`/api/issues/${encodeURIComponent(issueId)}/events?${params.toString()}`);
  },

  controlRun: (id, action, payload) => request(`/api/runs/${encodeURIComponent(id)}/actions/${action}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),

  getIssueRuns: (id) => request(`/api/issues/${id}/runs`),

  getSessions: ({ limit = 50, cursor = '' } = {}) => {
    const params = new URLSearchParams();
    if (limit) params.append('limit', String(limit));
    if (cursor) params.append('cursor', cursor);
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/sessions${query}`);
  },

  getSessionPreferences: () => request('/api/sessions/preferences'),

  createSession: (session) => request('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(session),
  }),

  getSession: (id, options = {}) => request(`/api/sessions/${encodeURIComponent(id)}`, options),

  getSessionTurns: (id, { cursor = '', itemsView = 'summary', limit = 20, sortDirection = 'desc' } = {}, options = {}) => {
    const params = new URLSearchParams({
      items_view: itemsView,
      limit: String(limit),
      sort_direction: sortDirection,
    });
    if (cursor) params.set('cursor', cursor);
    return request(`/api/sessions/${encodeURIComponent(id)}/turns?${params.toString()}`, options);
  },

  sendSessionMessage: (id, message) => request(`/api/sessions/${id}/messages`, {
    method: 'POST',
    body: JSON.stringify(typeof message === 'string' ? { prompt: message } : message),
  }),

  steerSessionMessage: (id, message) => request(`/api/sessions/${id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ ...(typeof message === 'string' ? { prompt: message } : message), mode: 'steer' }),
  }),

  interruptSession: (id) => request(`/api/sessions/${id}/interrupt`, {
    method: 'POST',
  }),

  resolveCodexApproval: (id, decision) => request(`/api/codex/approvals/${id}/resolve`, {
    method: 'POST',
    body: JSON.stringify(decision),
  }),
};
