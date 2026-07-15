import { request } from './base.js';

export const runsApi = {
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

  getSession: (id) => request(`/api/sessions/${id}`),

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
