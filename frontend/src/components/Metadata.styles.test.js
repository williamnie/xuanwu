import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const css = source('components/Metadata.css');

test('native metadata field names are separate from controls and option values', () => {
  // These forms use implicit label associations. Styling belongs to a text span,
  // so case-sensitive paths, model names, code and select options never inherit it.
  const forms = [
    'ExecutionPresetsPanel', 'AgentProfileManager', 'ActivityTimelinePanel',
    'SkillLibraryPanel', 'SkillsRuntimePanel', 'GitHubSettingsPanel',
    'FeishuSettingsPanel', 'TelegramSettingsPanel', 'TelegramProjectMappings',
    'JevSkillSettings', 'PiMcpManagementPanel',
  ];
  for (const name of forms) {
    const jsx = source(`pages/${name}.jsx`);
    assert.match(jsx, /<span className="ds-mono-label">/, name);
    assert.doesNotMatch(jsx, /<(?:input|select|option|textarea)[^>]*className="[^"]*ds-mono-label/, name);
    for (const [, content] of jsx.matchAll(/<span className="ds-mono-label">([\s\S]*?)<\/span>/g)) {
      assert.doesNotMatch(content, /<(?:input|select|textarea)\b/, name);
    }
  }
  const presets = source('pages/ExecutionPresetsPanel.jsx');
  assert.match(presets, /<label className="form-group"><span className="ds-mono-label">\{english \? 'Project' : '项目'\}<\/span>\s*<select/);
  assert.match(presets, /<label className="form-group"><span className="ds-mono-label">\{english \? 'Execution preset' : '执行预设'\}<\/span>\s*<select/);
  assert.doesNotMatch(css, /(?:^|\n)\.(?:form-group|skill-library|activity-filter|delivery-filters|github-settings__fields) label[, {]/);
  assert.doesNotMatch(css, /(?:^|\n)(?:label|input|select|option|textarea|button)[, {]/);
});

test('automation field names and fact labels share metadata styling while hints stay prose', () => {
  const automation = source('pages/Automations.jsx');
  assert.match(automation, /<span className="ds-mono-label">\{label\}<\/span>\{children\}<small>\{hint\}<\/small>/);
  for (const selector of [
    '.automation-fact small', '.automation-row small', '.automation-timeline small',
    '.dashboard-facts dt', '.delivery-facts dt', '.work-provider-profile-facts dt',
    '.approval-detail-grid small', '.run-cost-card dt', '.evidence-artifact-count',
  ]) assert.ok(css.includes(`${selector},`), selector);
  assert.match(css, /\.ds-mono-label \{\s*font-size: var\(--text-2xs\);\s*font-weight: 800;/);
  assert.doesNotMatch(css, /\.automation-form-field(?:,| \{)|\.automation-form-field small/);
});
