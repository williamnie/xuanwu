import { request } from './base.js';

export const commandCenterApi = {
  getTaskGlance: (options = {}) => {
    const start = new Date();start.setHours(0,0,0,0);const end = new Date(start);end.setDate(end.getDate()+1);
    const params = new URLSearchParams({ day_start: start.toISOString(), day_end: end.toISOString() });
    return request(`/api/command-center/task-glance?${params}`, options);
  },
  getInbox: ({ cursor = '', pageSize = 50, workId = '' } = {}, options = {}) => {
    const params = new URLSearchParams({ page_size: String(pageSize) });
    if (cursor) params.set('cursor', cursor);
    if (workId) params.set('work_id', workId);
    return request(`/api/command-center/inbox?${params}`, options);
  },
  getSummary: ({ limit = 10, sections = [] } = {}, options = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (sections.length > 0) params.set('sections', sections.join(','));
    return request(`/api/command-center/summary?${params.toString()}`, options);
  },
  controlAttention: (id, action, payload) => request(`/api/command-center/attention/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  getAttention: (id) => request(`/api/command-center/attention/${encodeURIComponent(id)}`),
};
