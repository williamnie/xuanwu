import { request } from './base.js';
const BASE = '/api/integrations/trackers/github';
export const githubSettingsApi = {
  get: (options = {}) => request(`${BASE}/settings`, options).then(normalizeGitHubSnapshot),
  save: (revision, settings) => request(`${BASE}/settings`, { method: 'PUT', body: JSON.stringify({ revision, settings }) }).then(normalizeGitHubSnapshot),
  reload: revision => request(`${BASE}/reload`, { method: 'POST', body: JSON.stringify({ revision }) }).then(normalizeGitHubSnapshot),
  test: settings => request(`${BASE}/test`, { method: 'POST', body: JSON.stringify({ settings }) }),
};

export function normalizeGitHubSnapshot(value) {
  if (!value || typeof value.revision !== 'string' || !value.revision || !value.settings?.auth || !Array.isArray(value.settings.repositories)) throw new Error('GitHub 配置响应不完整，请刷新核对');
  return { ...value, application: value.application || { status: 'unknown', active_settings: null }, runtime: value.runtime || { available: false }, projects: Array.isArray(value.projects) ? value.projects : [], repositories: Array.isArray(value.repositories) ? value.repositories : [], credential: value.credential || {}, permissions: value.permissions || { note: '操作仍受项目权限与审批限制' } };
}
