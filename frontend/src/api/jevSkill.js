import { request } from './base.js';

const SETTINGS_PATH = '/api/pi/skills/jev-assist/settings';

export const jevSkillApi = {
  get: (options = {}) => request(SETTINGS_PATH, options),
  save: (payload) => request(SETTINGS_PATH, { method: 'PUT', body: JSON.stringify(payload) }),
  test: (payload) => request('/api/pi/skills/jev-assist/test', { method: 'POST', body: JSON.stringify(payload) }),
};
