import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SETTINGS_ADVANCED_TABS,
  SETTINGS_PRIMARY_TABS,
  SETTINGS_NAVIGATION_GROUPS,
  settingsSectionCopy,
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

test('Every settings section has a visible purpose in both languages and exactly one navigation group', () => {
  const sections = [...SETTINGS_PRIMARY_TABS, ...SETTINGS_ADVANCED_TABS];
  const groupedIds = SETTINGS_NAVIGATION_GROUPS.flatMap(group => group.tabs);
  assert.equal(new Set(groupedIds).size, groupedIds.length);
  assert.deepEqual([...groupedIds].sort(), sections.map(section => section.id).sort());
  for (const section of sections) {
    for (const language of ['zh-CN', 'en-US']) {
      const copy = settingsSectionCopy(section.id, language);
      assert.ok(copy.title && copy.description && copy.hint, `${section.id} ${language}`);
      if (language === 'zh-CN') assert.match(copy.title, /[\u4e00-\u9fff]/);
    }
  }
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
