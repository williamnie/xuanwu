import { request } from './base.js';

export const firstDeliveryApi = {
  startProjectLoop: (id) => request(`/api/projects/${id}/loop/start`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),
};
