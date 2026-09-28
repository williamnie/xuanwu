import { request } from './base.js';

const ROOT = '/api/pi/skill-library';
const post = (path, body) => request(`${ROOT}/${path}`, { method: 'POST', body: JSON.stringify(body) });
export const skillLibraryApi = {
  list: (projectId = '') => request(`${ROOT}${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`),
  detail: key => request(`${ROOT}/${encodeURIComponent(key)}`),
  install: body => post('install', body),
  inspect: source => post('inspect', { source }),
  manage: body => post('manage', body),
  verify: key => post('verify', { key }),
};
