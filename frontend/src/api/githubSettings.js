import { request } from './base.js';
const BASE = '/api/integrations/trackers/github';
export const githubSettingsApi = {
  get: (options = {}) => request(`${BASE}/settings`, options),
  save: (revision, settings) => request(`${BASE}/settings`, { method: 'PUT', body: JSON.stringify({ revision, settings }) }),
  reload: revision => request(`${BASE}/reload`, { method: 'POST', body: JSON.stringify({ revision }) }),
  test: settings => request(`${BASE}/test`, { method: 'POST', body: JSON.stringify({ settings }) }),
};
