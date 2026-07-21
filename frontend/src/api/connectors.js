import { request } from './base.js';

export const connectorsApi = {
  getPiConnectors: () => request('/api/pi/connectors'),

  getPiConnectorDiagnostics: () => request('/api/pi/connectors/diagnostics'),

  testPiConnector: (id) => request(`/api/pi/connectors/${encodeURIComponent(id)}/test-connection`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'Connections test' }),
  }),

  revokePiConnectorSecret: (id, secretRef) => request(`/api/pi/connectors/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'Connections revoke', secret_ref: secretRef }),
  }),

  getFeishuSettings: () => request('/api/integrations/feishu/settings'),

  updateFeishuSettings: (settings) => request('/api/integrations/feishu/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  }),

  getPiMcpCapabilities: () => request('/api/pi/mcp/capabilities'),

  getPiMcpDiscoverySources: () => request('/api/pi/mcp/discovery/sources'),

  scanPiMcpDiscovery: (payload = {}) => request('/api/pi/mcp/discovery/scan', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),

  getPiMcpDiscoveryResults: () => request('/api/pi/mcp/discovery/results'),

  createPiMcpServer: (server) => request('/api/pi/mcp/servers', {
    method: 'POST',
    body: JSON.stringify(server),
  }),

  patchPiMcpServer: (id, patch) => request(`/api/pi/mcp/servers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }),

  deletePiMcpServer: (id) => request(`/api/pi/mcp/servers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }),

  introspectPiMcpServer: (id) => request(`/api/pi/mcp/servers/${encodeURIComponent(id)}/introspect`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),

  patchPiMcpCapability: (id, patch) => request(`/api/pi/mcp/capabilities/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }),
};
