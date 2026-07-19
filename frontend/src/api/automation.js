import { request } from './base.js';

export const automationApi = {
  getPiSourcePolicies: ({ projectId = '' } = {}) => {
    const params = new URLSearchParams();
    if (projectId) params.append('project_id', projectId);
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/pi/source-policies${query}`);
  },

  getPiHeartbeatTimeline: ({ projectId = '', issueId = '', limit = 80 } = {}) => {
    const params = new URLSearchParams();
    if (projectId) params.append('project_id', projectId);
    if (issueId) params.append('issue_id', issueId);
    if (limit) params.append('limit', String(limit));
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/pi/heartbeat-timeline${query}`);
  },
};
