import { request } from './base.js';
import { eventSummaryParams } from './events.js';

export const workApi = {
  getIssueTemplates: () => request('/api/issue-templates'),

  createIssueTemplate: (template) => request('/api/issue-templates', {
    method: 'POST',
    body: JSON.stringify(template),
  }),

  updateIssueTemplate: (id, updates) => request(`/api/issue-templates/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  }),

  deleteIssueTemplate: (id) => request(`/api/issue-templates/${id}`, {
    method: 'DELETE',
  }),

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

  enqueueIssue: (id, payload = {}) => request(`/api/issues/${id}/enqueue`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),

  retryIssue: (id, payload = {}) => request(`/api/issues/${id}/retry`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),

  cancelIssue: (id) => request(`/api/issues/${id}/cancel`, {
    method: 'POST',
  }),

  deleteIssue: (id) => request(`/api/issues/${id}`, {
    method: 'DELETE',
  }),

  reviewIssueVerification: (id, review) => request(`/api/issues/${id}/verification`, {
    method: 'POST',
    body: JSON.stringify(review),
  }),

  getIssueEvents: (id, { afterId = '', beforeId = '', excludeTypes = [], limit = 0, types = [] } = {}) => {
    const params = eventSummaryParams({ afterId, beforeId, excludeTypes, limit, types });
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/issues/${id}/events${query}`);
  },

  getIssueEventSummaries: (id, { afterId = '', beforeId = '', excludeTypes = [], limit = 0, types = [] } = {}) => {
    const params = eventSummaryParams({ afterId, beforeId, excludeTypes, limit, types });
    const query = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/issues/${id}/event-summaries${query}`).then(result => result?.items || []);
  },

  getIssueSupervisor: (id) => request(`/api/issues/${id}/supervisor`),

  createIssueComment: (id, comment) => request(`/api/issues/${id}/comments`, {
    method: 'POST',
    body: JSON.stringify(comment),
  }),

  generateIssueVerifierReport: (id) => request(`/api/issues/${id}/verifier-report`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),
};
