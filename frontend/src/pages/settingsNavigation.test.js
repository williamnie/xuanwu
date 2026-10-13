import assert from 'node:assert/strict';
import test from 'node:test';
import { SETTINGS_ADVANCED_TABS, SETTINGS_PRIMARY_TABS, SETTINGS_NAVIGATION_GROUPS, settingsSectionCopy, resolveSettingsRoute, settingsRouteId } from './settingsNavigation.js';

test('Settings exposes five sections and six lazy advanced sections', () => {
  assert.deepEqual(SETTINGS_PRIMARY_TABS.map(tab => tab.id), ['general', 'ai', 'connections', 'preferences', 'advanced']);
  assert.deepEqual(SETTINGS_ADVANCED_TABS.map(tab => tab.id), ['diagnostics', 'permissions', 'skills', 'memory', 'presets', 'activity']);
});
test('Every section has bilingual copy; only top-level sections enter navigation', () => {
  const groupedIds = SETTINGS_NAVIGATION_GROUPS.flatMap(group => group.tabs);
  assert.equal(new Set(groupedIds).size, 5);
  assert.deepEqual(groupedIds, SETTINGS_PRIMARY_TABS.map(tab => tab.id));
  for (const section of [...SETTINGS_PRIMARY_TABS, ...SETTINGS_ADVANCED_TABS]) {
    for (const language of ['zh-CN', 'en-US']) {
      const copy = settingsSectionCopy(section.id, language);
      assert.ok(copy.title && copy.description && copy.hint);
      if (language === 'zh-CN') assert.match(copy.title, /[\u4e00-\u9fff]/);
    }
  }
});
test('All legacy bare and prefixed routes resolve to their original configuration domain', () => {
  const mapping = { general:['general',undefined], supervisor:['ai','supervisor'], 'code-agents':['ai','code-agents'], notifications:['connections','notifications'], integrations:['connections','integrations'], permissions:['advanced','permissions'], policies:['advanced','permissions'], diagnostics:['advanced','diagnostics'], skills:['advanced','skills'], memory:['advanced','memory'], activity:['advanced','activity'] };
  for (const [legacy,[tab,section]] of Object.entries(mapping)) {
    for (const input of [legacy,`advanced:${legacy}`]) {
      const route = resolveSettingsRoute(input);
      assert.equal(route.tab,tab,input);assert.equal(route.section,section,input);
      assert.equal(route.tier,tab==='advanced'?'advanced':'primary',input);
    }
  }
});
test('Canonical and legacy targets round-trip without losing the section', () => {
  for (const id of ['general','ai','connections','preferences','advanced','supervisor','code-agents','notifications','integrations', ...SETTINGS_ADVANCED_TABS.map(tab=>`advanced:${tab.id}`)]) {
    const route = resolveSettingsRoute(id);
    assert.deepEqual(resolveSettingsRoute(settingsRouteId(route)),route,id);
  }
  for (const unknown of ['unknown','runner-brain','assistant','connectors','advanced:model-runtime']) assert.deepEqual(resolveSettingsRoute(unknown),{tier:'primary',tab:'general'});
});
