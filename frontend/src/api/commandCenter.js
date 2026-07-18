import { request } from './base.js';

export const commandCenterApi = {
  getSummary: ({ limit = 10, sections = [] } = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (sections.length > 0) params.set('sections', sections.join(','));
    return request(`/api/command-center/summary?${params.toString()}`);
  },
  controlAttention: (id, action, payload) => request(`/api/command-center/attention/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  getAttention: (id) => request(`/api/command-center/attention/${encodeURIComponent(id)}`),
};
