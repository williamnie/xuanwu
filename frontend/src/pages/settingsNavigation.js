export const SETTINGS_PRIMARY_TABS = Object.freeze([
  { id: 'general', label: 'General' },
  { id: 'models-agents', label: 'Models & Agents' },
  { id: 'connections', label: 'Connections' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'notifications', label: 'Notifications' },
]);

export const SETTINGS_ADVANCED_TABS = Object.freeze([
  { id: 'runtime', label: 'Runtime' },
  { id: 'model-runtime', label: 'Model Runtime' },
  { id: 'mcp', label: 'MCP' },
  { id: 'skills', label: 'Skills' },
  { id: 'memory', label: 'Memory' },
  { id: 'activity', label: 'Activity' },
  { id: 'policies', label: 'Policies' },
]);

const LEGACY_SETTINGS_ROUTES = Object.freeze({
  assistant: { tier: 'primary', tab: 'models-agents' },
  'runner-brain': { tier: 'advanced', tab: 'runtime' },
  connectors: { tier: 'primary', tab: 'connections' },
  skills: { tier: 'advanced', tab: 'skills' },
  memory: { tier: 'advanced', tab: 'memory' },
  activity: { tier: 'advanced', tab: 'activity' },
  policies: { tier: 'advanced', tab: 'policies' },
});

const PRIMARY_TAB_IDS = new Set(SETTINGS_PRIMARY_TABS.map(tab => tab.id));
const ADVANCED_TAB_IDS = new Set(SETTINGS_ADVANCED_TABS.map(tab => tab.id));

export function resolveSettingsRoute(value = 'general') {
  const route = String(value || '').trim();
  if (PRIMARY_TAB_IDS.has(route)) return { tier: 'primary', tab: route };
  if (route.startsWith('advanced:')) {
    const tab = route.slice('advanced:'.length);
    if (ADVANCED_TAB_IDS.has(tab)) return { tier: 'advanced', tab };
  }
  return LEGACY_SETTINGS_ROUTES[route] || { tier: 'primary', tab: 'general' };
}

export function settingsRouteId(route) {
  if (route?.tier === 'advanced' && ADVANCED_TAB_IDS.has(route.tab)) {
    return `advanced:${route.tab}`;
  }
  return PRIMARY_TAB_IDS.has(route?.tab) ? route.tab : 'general';
}
