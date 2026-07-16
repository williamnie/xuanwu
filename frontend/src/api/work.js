import { request } from './base.js';
import { eventSummaryParams } from './events.js';

const WORK_PAGE_SIZE = 100;

function appendMany(params, key, values) {
  const items = Array.isArray(values) ? values : values ? [values] : [];
  items.forEach(value => params.append(key, value));
}

function workListParams({ order = 'desc', page = 1, pageSize = WORK_PAGE_SIZE, projectId = '', query = '', sort = 'updated_at', statuses = [], types = [] } = {}) {
  const params = new URLSearchParams({
    order,
    page: String(page),
    page_size: String(pageSize),
    sort,
  });
  if (projectId) params.set('project_id', projectId);
  if (query) params.set('q', query);
  appendMany(params, 'status', statuses);
  appendMany(params, 'type', types);
  return params;
}

function workRelationParams({ kinds = [], lifecycles = [], page = 1, pageSize = WORK_PAGE_SIZE, projectId = '', workId = '' } = {}) {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (projectId) params.set('project_id', projectId);
  if (workId) params.set('work_id', workId);
  appendMany(params, 'kind', kinds);
  appendMany(params, 'lifecycle', lifecycles);
  return params;
}

async function allPages(fetchPage) {
  const first = await fetchPage(1);
  const totalPages = Number(first?.total_pages) || 0;
  if (totalPages <= 1) return first;
  const rest = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, index) => fetchPage(index + 2)),
  );
  return {
    ...first,
    items: [first, ...rest].flatMap(page => page?.items || []),
  };
}

export const workApi = {
  getWorks: (filters = {}) => request(`/api/works?${workListParams(filters)}`),

  getAllWorks: (filters = {}) => allPages(page => (
    request(`/api/works?${workListParams({ ...filters, page, pageSize: WORK_PAGE_SIZE })}`)
  )),

  getWorkRelations: (filters = {}) => request(`/api/work-relations?${workRelationParams(filters)}`),

  getAllWorkRelations: (filters = {}) => allPages(page => (
    request(`/api/work-relations?${workRelationParams({ ...filters, page, pageSize: WORK_PAGE_SIZE })}`)
  )),

  createWork: (work) => request('/api/works', {
    method: 'POST',
    body: JSON.stringify(work),
  }),

  updateWork: (id, updates) => request(`/api/works/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  }),

  controlWork: (id, action, payload) => request(`/api/works/${encodeURIComponent(id)}/actions/${action}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),

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
