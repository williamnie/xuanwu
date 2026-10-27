import { request } from './base.js';

export const nodesApi = {
  listNodes: () => request('/api/nodes'),

  createNode: (name) => request('/api/nodes', {
    method: 'POST',
    body: JSON.stringify({ name }),
  }),

  revokeNode: (id) => request(`/api/nodes/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }),
};
