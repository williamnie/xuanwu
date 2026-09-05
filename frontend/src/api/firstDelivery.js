import { request } from './base.js';

export const firstDeliveryApi = {
  completeDelivery: (workID) => request(`/api/onboarding/works/${encodeURIComponent(workID)}/delivery-check`, {
    method: 'POST', body: JSON.stringify({}),
  }),
  startProjectLoop: (id) => request(`/api/projects/${id}/loop/start`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),
};
