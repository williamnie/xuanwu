export const SETTINGS_PRIMARY_TABS = Object.freeze([
  { id: 'general', label: 'Projects' },
  { id: 'supervisor', label: 'Xuanwu Supervisor' },
  { id: 'code-agents', label: 'Code Agents' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'notifications', label: 'Notifications' },
]);

export const SETTINGS_ADVANCED_TABS = Object.freeze([
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'skills', label: 'Skills' },
  { id: 'memory', label: 'Memory' },
  { id: 'activity', label: 'Activity' },
  { id: 'policies', label: 'Policies' },
]);

const PRIMARY_TAB_IDS = new Set(SETTINGS_PRIMARY_TABS.map(tab => tab.id));
const ADVANCED_TAB_IDS = new Set(SETTINGS_ADVANCED_TABS.map(tab => tab.id));

export function resolveSettingsRoute(value = 'general') {
  const route = String(value || '').trim();
  if (PRIMARY_TAB_IDS.has(route)) return { tier: 'primary', tab: route };
  if (ADVANCED_TAB_IDS.has(route)) return { tier: 'advanced', tab: route };
  if (route.startsWith('advanced:')) {
    const tab = route.slice('advanced:'.length);
    if (ADVANCED_TAB_IDS.has(tab)) return { tier: 'advanced', tab };
  }
  return { tier: 'primary', tab: 'general' };
}

export function settingsRouteId(route) {
  if (route?.tier === 'advanced' && ADVANCED_TAB_IDS.has(route.tab)) {
    return `advanced:${route.tab}`;
  }
  return PRIMARY_TAB_IDS.has(route?.tab) ? route.tab : 'general';
}
