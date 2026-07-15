import { request } from './base.js';

export const projectsApi = {
  getProjects: () => request('/api/projects'),

  getAgentProfiles: () => request('/api/agent-profiles'),

  createAgentProfile: (profile) => request('/api/agent-profiles', {
    method: 'POST',
    body: JSON.stringify(profile),
  }),

  updateAgentProfile: (id, updates) => request(`/api/agent-profiles/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  }),

  deleteAgentProfile: (id) => request(`/api/agent-profiles/${id}`, {
    method: 'DELETE',
  }),

  syncCodexProjects: () => request('/api/projects/sync/codex', {
    method: 'POST',
    body: JSON.stringify({}),
  }),

  createProject: (project) => request('/api/projects', {
    method: 'POST',
    body: JSON.stringify(project),
  }),

  getProject: (id) => request(`/api/projects/${id}`),

  updateProject: (id, updates) => request(`/api/projects/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  }),

  reorderProjects: (projectIds) => request('/api/projects', {
    method: 'PATCH',
    body: JSON.stringify({ project_ids: projectIds }),
  }),

  deleteProject: (id) => request(`/api/projects/${id}`, {
    method: 'DELETE',
  }),

  startProjectLoop: (id) => request(`/api/projects/${id}/loop/start`, {
    method: 'POST',
  }),

  stopProjectLoop: (id) => request(`/api/projects/${id}/loop/stop`, {
    method: 'POST',
  }),

  getProjectLoopStatus: (id) => request(`/api/projects/${id}/loop/status`),

  resumeProjectHold: (id) => request(`/api/projects/${id}/hold/resume`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),

  searchProjectReferences: (id, { type = '', query = '', limit = 40 } = {}) => {
    const params = new URLSearchParams();
    if (type) params.append('type', type);
    if (query) params.append('query', query);
    if (limit) params.append('limit', String(limit));
    const qs = params.toString() ? `?${params.toString()}` : '';
    return request(`/api/projects/${id}/references/search${qs}`);
  },
};
