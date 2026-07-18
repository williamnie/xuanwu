import { request } from './base.js';

export const nativeAutomationsApi = {
  list: ({ projectId = '', status = '', triggerType = '' } = {}) => {
    const params = new URLSearchParams();
    if (projectId) params.set('project_id', projectId);
    if (status) params.set('status', status);
    if (triggerType) params.set('trigger_type', triggerType);
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/automations${query}`);
  },
  create: (payload) => request('/api/automations', { method: 'POST', body: JSON.stringify(payload) }),
  detail: (id) => request(`/api/automations/${encodeURIComponent(id)}`),
  update: (id, payload) => request(`/api/automations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  updateTrigger: (id, payload) => request(`/api/automations/${encodeURIComponent(id)}/trigger`, { method: 'PATCH', body: JSON.stringify(payload) }),
  setStatus: (id, payload) => request(`/api/automations/${encodeURIComponent(id)}/status`, { method: 'POST', body: JSON.stringify(payload) }),
  runNow: (id, payload) => request(`/api/automations/${encodeURIComponent(id)}/run-now`, { method: 'POST', body: JSON.stringify(payload) }),
};
