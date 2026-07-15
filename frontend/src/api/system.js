import { clearAuthToken } from './authToken.js';
import { request, uploadImage } from './base.js';

export const systemApi = {
  validateAuthToken: () => request('/api/system/status'),

  clearAuthToken,

  getCodexUsage: (limit = 0) => {
    const query = limit > 0 ? `?limit=${encodeURIComponent(limit)}` : '';
    return request(`/api/usage/codex${query}`);
  },

  getSystemStatus: () => request('/api/system/status'),

  getRunnerSettings: () => request('/api/runner/settings'),

  updateRunnerSettings: (settings) => request('/api/runner/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  }),

  getRuntimeDoctor: () => request('/api/system/doctor'),

  getRuntimeLogs: (lines = 120) => request(`/api/system/logs?lines=${encodeURIComponent(lines)}`),

  executeCommand: (payload) => request('/api/commands', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),

  restartSystem: () => request('/api/system/restart', {
    method: 'POST',
    body: JSON.stringify({}),
  }),

  getCodexModels: () => request('/api/codex/models'),

  getCapabilities: () => request('/api/capabilities'),

  uploadImage,
};
