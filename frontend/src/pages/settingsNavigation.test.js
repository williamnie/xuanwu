import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SETTINGS_ADVANCED_TABS,
  SETTINGS_PRIMARY_TABS,
  resolveSettingsRoute,
  settingsRouteId,
} from './settingsNavigation.js';

test('Settings exposes behavior tabs and keeps runtime details in Advanced', () => {
  assert.deepEqual(SETTINGS_PRIMARY_TABS.map(tab => tab.label), [
    'Projects',
    'Permissions',
    'Notifications',
  ]);
  assert.deepEqual(SETTINGS_ADVANCED_TABS.map(tab => tab.id), [
    'runtime',
    'skills',
    'memory',
    'activity',
    'policies',
  ]);
});

test('Settings migrates configuration tabs but excludes product work queues', () => {
  assert.deepEqual(resolveSettingsRoute('assistant'), { tier: 'primary', tab: 'general' });
  assert.deepEqual(resolveSettingsRoute('runner-brain'), { tier: 'advanced', tab: 'runtime' });
  assert.deepEqual(resolveSettingsRoute('connections'), { tier: 'product', tab: 'connections' });
  assert.deepEqual(resolveSettingsRoute('connectors'), { tier: 'product', tab: 'connections' });
  assert.deepEqual(resolveSettingsRoute('advanced:model-runtime'), { tier: 'product', tab: 'connections' });
  assert.deepEqual(resolveSettingsRoute('skills'), { tier: 'advanced', tab: 'skills' });
  assert.deepEqual(resolveSettingsRoute('automations'), { tier: 'primary', tab: 'general' });
  assert.deepEqual(resolveSettingsRoute('approvals'), { tier: 'primary', tab: 'general' });
  assert.deepEqual(resolveSettingsRoute('memory'), { tier: 'advanced', tab: 'memory' });
  assert.deepEqual(resolveSettingsRoute('activity'), { tier: 'advanced', tab: 'activity' });
  assert.deepEqual(resolveSettingsRoute('policies'), { tier: 'advanced', tab: 'policies' });
});

test('Settings canonical routes round-trip and unknown routes fail safe to Projects', () => {
  const advanced = resolveSettingsRoute('advanced:runtime');
  assert.deepEqual(advanced, { tier: 'advanced', tab: 'runtime' });
  assert.equal(settingsRouteId(advanced), 'advanced:runtime');
  assert.equal(settingsRouteId(resolveSettingsRoute('notifications')), 'notifications');
  assert.deepEqual(resolveSettingsRoute('unknown'), { tier: 'primary', tab: 'general' });
});
