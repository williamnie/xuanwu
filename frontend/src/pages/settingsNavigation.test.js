import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SETTINGS_ADVANCED_TABS,
  SETTINGS_PRIMARY_TABS,
  resolveSettingsRoute,
  settingsRouteId,
} from './settingsNavigation.js';

test('Settings exposes runtime configuration tabs and keeps diagnostics in Advanced', () => {
  assert.deepEqual(SETTINGS_PRIMARY_TABS.map(tab => tab.label), [
    'Projects',
    'Xuanwu Supervisor',
    'Code Agents',
    'Integrations',
    'Permissions',
    'Notifications',
  ]);
  assert.deepEqual(SETTINGS_ADVANCED_TABS.map(tab => tab.id), [
    'diagnostics',
    'skills',
    'memory',
    'activity',
    'policies',
  ]);
});

test('Settings accepts only current configuration sections', () => {
  assert.deepEqual(resolveSettingsRoute('supervisor'), { tier: 'primary', tab: 'supervisor' });
  assert.deepEqual(resolveSettingsRoute('code-agents'), { tier: 'primary', tab: 'code-agents' });
  assert.deepEqual(resolveSettingsRoute('integrations'), { tier: 'primary', tab: 'integrations' });
  assert.deepEqual(resolveSettingsRoute('assistant'), { tier: 'primary', tab: 'general' });
  assert.deepEqual(resolveSettingsRoute('runner-brain'), { tier: 'primary', tab: 'general' });
  assert.deepEqual(resolveSettingsRoute('connections'), { tier: 'primary', tab: 'general' });
  assert.deepEqual(resolveSettingsRoute('connectors'), { tier: 'primary', tab: 'general' });
  assert.deepEqual(resolveSettingsRoute('advanced:model-runtime'), { tier: 'primary', tab: 'general' });
  assert.deepEqual(resolveSettingsRoute('skills'), { tier: 'advanced', tab: 'skills' });
  assert.deepEqual(resolveSettingsRoute('automations'), { tier: 'primary', tab: 'general' });
  assert.deepEqual(resolveSettingsRoute('approvals'), { tier: 'primary', tab: 'general' });
  assert.deepEqual(resolveSettingsRoute('memory'), { tier: 'advanced', tab: 'memory' });
  assert.deepEqual(resolveSettingsRoute('activity'), { tier: 'advanced', tab: 'activity' });
  assert.deepEqual(resolveSettingsRoute('policies'), { tier: 'advanced', tab: 'policies' });
});

test('Settings canonical routes round-trip and unknown routes fail safe to Projects', () => {
  const advanced = resolveSettingsRoute('advanced:diagnostics');
  assert.deepEqual(advanced, { tier: 'advanced', tab: 'diagnostics' });
  assert.equal(settingsRouteId(advanced), 'advanced:diagnostics');
  assert.equal(settingsRouteId(resolveSettingsRoute('notifications')), 'notifications');
  assert.deepEqual(resolveSettingsRoute('unknown'), { tier: 'primary', tab: 'general' });
});
