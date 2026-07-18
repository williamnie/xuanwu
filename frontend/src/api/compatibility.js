import { request } from './base.js';

export const compatibilityApi = {
  recordLegacyRoute: ({ family, target }) => request('/api/compatibility/legacy/usage', {
    method: 'POST',
    body: JSON.stringify({ family, target }),
  }),
};
