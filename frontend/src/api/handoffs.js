import { request } from './base.js';

export const handoffsApi = {
  getHandoffs: ({ cursor = '', deliveryMode = '', limit = 100, projectId = '', status = '', workId = '' } = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    if (deliveryMode) params.set('delivery_mode', deliveryMode);
    if (projectId) params.set('project_id', projectId);
    if (status) params.set('status', status);
    if (workId) params.set('work_id', workId);
    return request(`/api/handoffs?${params.toString()}`);
  },

  getHandoff: (id) => request(`/api/handoffs/${encodeURIComponent(id)}`),
};
