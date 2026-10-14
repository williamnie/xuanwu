export const INTEGRATION_IDS = ['github', 'feishu', 'telegram'];

export function integrationChannelFromHash(hash = '') {
  const [path, query] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const channel = params.get('channel');
  return path === '/settings' && ['integrations', 'notifications'].includes(params.get('section')) && INTEGRATION_IDS.includes(channel) ? channel : '';
}

export function connectionHealth(connectors, id) {
  const connector = connectors.find(item => item.id === id);
  return connector?.health?.state || connector?.status || connector?.summary?.state || 'unknown';
}

export function receiverState(channels, id) {
  const channel = channels.find(item => item.id === id);
  return channel?.receiver?.state || 'unknown';
}

// These requests fail independently: an unavailable registry must not hide health.
export function loadConnectionStatus(api, onConnectors, onChannels) {
  return Promise.all([
    api.getPiConnectors().then(data => onConnectors(Array.isArray(data?.connectors) ? data.connectors : [])).catch(() => onConnectors([])),
    api.getImChannels().then(channels => onChannels(Array.isArray(channels) ? channels : [])).catch(() => onChannels([])),
  ]);
}
