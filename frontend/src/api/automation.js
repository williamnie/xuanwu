import { request } from './base.js';

export const automationApi = {
  getPiSourcePolicies: ({ projectId = '' } = {}) => {
    const params = new URLSearchParams();
    if (projectId) params.append('project_id', projectId);
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/pi/source-policies${query}`);
  },

  createPiSourcePolicy: (payload) => request('/api/pi/source-policies', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),

  updatePiAutomationSourcePolicy: (id, payload) => request(`/api/pi/source-policies/automations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  }),

  getPiAutomations: () => request('/api/pi/automations'),

  updatePiAutomation: (id, updates) => request(`/api/pi/automations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  }),

  getCronTasks: () => request('/api/cron-tasks'),

  createCronTask: (task) => request('/api/cron-tasks', {
    method: 'POST',
    body: JSON.stringify(task),
  }),

  updateCronTask: (id, updates) => request(`/api/cron-tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  }),

  deleteCronTask: (id) => request(`/api/cron-tasks/${id}`, {
    method: 'DELETE',
  }),

  getPiHeartbeatTimeline: ({ projectId = '', issueId = '', limit = 80 } = {}) => {
    const params = new URLSearchParams();
    if (projectId) params.append('project_id', projectId);
    if (issueId) params.append('issue_id', issueId);
    if (limit) params.append('limit', String(limit));
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/pi/heartbeat-timeline${query}`);
  },
};
