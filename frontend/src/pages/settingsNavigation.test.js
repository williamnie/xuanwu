import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SETTINGS_ADVANCED_SECTIONS,
  SETTINGS_SECTIONS,
  advancedSectionCopy,
  settingsSectionCopy,
  resolveSettingsRoute,
  settingsRouteId,
} from './settingsNavigation.js';

test('Settings has five sections and Advanced is one page of collapsible parts', () => {
  assert.deepEqual(SETTINGS_SECTIONS.map(section => section.id), ['general', 'ai', 'notifications', 'preferences', 'advanced']);
  assert.deepEqual(SETTINGS_ADVANCED_SECTIONS.map(section => section.id), ['diagnostics', 'security', 'skills', 'memory', 'presets', 'activity']);
});

test('Every section and advanced part has a visible purpose in both languages', () => {
  for (const { id } of SETTINGS_SECTIONS) {
    for (const language of ['zh-CN', 'en-US']) {
      const copy = settingsSectionCopy(id, language);
      assert.ok(copy.title && copy.description && copy.hint, `${id} ${language}`);
      if (language === 'zh-CN') assert.match(copy.title, /[一-鿿]/);
    }
  }
  for (const { id } of SETTINGS_ADVANCED_SECTIONS) {
    for (const language of ['zh-CN', 'en-US']) {
      const copy = advancedSectionCopy(id, language);
      assert.ok(copy.title && copy.hint, `${id} ${language}`);
    }
  }
  assert.match(settingsSectionCopy('ai').description, /玄武助手未连接时，任务能执行，但无法自动验收/);
});

test('Legacy section values, bare or advanced-prefixed, land in the new location', () => {
  const cases = {
    general: { tab: 'general', section: '' },
    supervisor: { tab: 'ai', section: '' },
    'code-agents': { tab: 'ai', section: '' },
    notifications: { tab: 'notifications', section: '' },
    integrations: { tab: 'notifications', section: '' },
    permissions: { tab: 'advanced', section: 'security' },
    policies: { tab: 'advanced', section: 'security' },
    'advanced:policies': { tab: 'advanced', section: 'security' },
    diagnostics: { tab: 'advanced', section: 'diagnostics' },
    'advanced:diagnostics': { tab: 'advanced', section: 'diagnostics' },
    skills: { tab: 'advanced', section: 'skills' },
    'advanced:skills': { tab: 'advanced', section: 'skills' },
    memory: { tab: 'advanced', section: 'memory' },
    'advanced:memory': { tab: 'advanced', section: 'memory' },
    presets: { tab: 'advanced', section: 'presets' },
    'advanced:presets': { tab: 'advanced', section: 'presets' },
    activity: { tab: 'advanced', section: 'activity' },
    'advanced:activity': { tab: 'advanced', section: 'activity' },
  };
  for (const [value, expected] of Object.entries(cases)) {
    assert.deepEqual(resolveSettingsRoute(value), expected, value);
  }
});

test('Unknown or retired sections fail safe to Projects', () => {
  for (const value of ['unknown', 'assistant', 'runner-brain', 'connections', 'connectors', 'advanced:model-runtime', 'automations', 'approvals', '']) {
    assert.deepEqual(resolveSettingsRoute(value), { tab: 'general', section: '' }, value);
  }
});

test('Settings routes round-trip', () => {
  assert.equal(settingsRouteId(resolveSettingsRoute('advanced:presets')), 'advanced:presets');
  assert.equal(settingsRouteId(resolveSettingsRoute('advanced:diagnostics')), 'advanced:diagnostics');
  assert.equal(settingsRouteId(resolveSettingsRoute('permissions')), 'advanced:security');
  assert.equal(settingsRouteId(resolveSettingsRoute('advanced')), 'advanced');
  assert.equal(settingsRouteId(resolveSettingsRoute('preferences')), 'preferences');
  assert.equal(settingsRouteId(resolveSettingsRoute('supervisor')), 'ai');
});
