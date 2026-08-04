import { clearAuthToken } from './authToken.js';
import { request, uploadImage } from './base.js';

const SYSTEM_STATUS_TTL_MS = 5_000;
let systemStatusCache = null;
let systemStatusExpiresAt = 0;
let systemStatusRequest = null;

async function getCompactSystemStatus({ force = false } = {}) {
  if (!force && systemStatusCache && Date.now() < systemStatusExpiresAt) return systemStatusCache;
  if (!force && systemStatusRequest) return systemStatusRequest;
  const pending = request('/api/system/status?compact=1');
  systemStatusRequest = pending;
  try {
    const status = await pending;
    systemStatusCache = status;
    systemStatusExpiresAt = Date.now() + SYSTEM_STATUS_TTL_MS;
    return status;
  } finally {
    if (systemStatusRequest === pending) systemStatusRequest = null;
  }
}

export const systemApi = {
  validateAuthToken: () => getCompactSystemStatus(),

  clearAuthToken,

  getAuthTokenStatus: () => request('/api/auth/token'),

  rotateAuthToken: () => request('/api/auth/token/rotate', {
    method: 'POST',
    body: JSON.stringify({ confirm: 'rotate' }),
  }),

  getCodexUsage: (options = 0) => {
    const limit = typeof options === 'number' ? options : Number(options?.limit || 0);
    const compact = typeof options === 'object' && options?.compact === true;
    const refresh = typeof options === 'object' && options?.refresh === true;
    const params = new URLSearchParams();
    if (limit > 0) params.set('limit', String(limit));
    if (compact) params.set('compact', '1');
    if (refresh) params.set('refresh', '1');
    const query = params.size > 0 ? `?${params}` : '';
    return request(`/api/usage/codex${query}`);
  },

  getProviderUsage: (options = {}) => {
    const params = new URLSearchParams();
    if (options?.compact === true) params.set('compact', '1');
    if (options?.refresh === true) params.set('refresh', '1');
    const query = params.size > 0 ? `?${params}` : '';
    return request(`/api/usage/providers${query}`);
  },

  getSystemStatus: (options = {}) => getCompactSystemStatus(options),

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
