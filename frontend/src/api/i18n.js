import { request } from './base.js';

export const i18nApi = {
  getLanguage: () => request('/api/i18n'),
  setLanguage: (language) => request('/api/i18n', {
    method: 'PUT',
    body: JSON.stringify({ language }),
  }),
};
