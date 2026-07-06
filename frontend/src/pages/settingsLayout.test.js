import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const settingsSource = readFileSync(new URL('./Settings.jsx', import.meta.url), 'utf8');
const chromeSource = readFileSync(new URL('./SettingsChrome.jsx', import.meta.url), 'utf8');
const sectionsSource = readFileSync(new URL('./AssistantSettingsSections.jsx', import.meta.url), 'utf8');
const placeholderSource = readFileSync(new URL('./AssistantSettingsPlaceholders.jsx', import.meta.url), 'utf8');
const connectorDiagnosticsSource = readFileSync(new URL('./ConnectorDiagnosticsPanel.jsx', import.meta.url), 'utf8');
const skillsRuntimeSource = readFileSync(new URL('./SkillsRuntimePanel.jsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../api/client.js', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('./Settings.css', import.meta.url), 'utf8');

test('Settings groups panels behind Assistant Settings tabs and removes duplicate cron panel', () => {
  assert.match(settingsSource, /useState\('assistant'\)/);
  assert.match(sectionsSource, /activeTab === 'assistant'/);
  assert.match(sectionsSource, /activeTab === 'runner-brain'/);
  assert.match(sectionsSource, /activeTab === 'connectors'/);
  assert.match(sectionsSource, /activeTab === 'skills'/);
  assert.match(sectionsSource, /activeTab === 'automations'/);
  assert.match(sectionsSource, /activeTab === 'approvals'/);
  assert.match(sectionsSource, /activeTab === 'memory'/);
  assert.match(sectionsSource, /activeTab === 'activity'/);
  assert.match(sectionsSource, /activeTab === 'policies'/);
  assert.doesNotMatch(settingsSource, /CronTasksPanel/);
  assert.doesNotMatch(chromeSource, /Cron 任务已在侧边栏/);
});

test('Assistant Settings IA reserves future capability placeholders', () => {
  assert.match(chromeSource, /Assistant Settings/);
  assert.match(chromeSource, /PI Assistant · Single Runtime/);
  assert.match(placeholderSource, /Single Assistant Runtime/);
  assert.doesNotMatch(placeholderSource, /Runner Brain/);
  assert.match(placeholderSource, /不恢复多个独立 PI agent/);
  assert.match(sectionsSource, /Connectors/);
  assert.match(sectionsSource, /Skills/);
  assert.match(sectionsSource, /Automations/);
  assert.match(sectionsSource, /Approvals/);
  assert.match(sectionsSource, /Memory/);
  assert.match(sectionsSource, /Activity/);
  assert.match(sectionsSource, /Policies/);
  assert.doesNotMatch(chromeSource, /id: 'policies'/);
});

test('PI Assistant workbench exposes first-class module routes', () => {
  const appSource = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
  const sidebarSource = readFileSync(new URL('../components/AppSidebar.jsx', import.meta.url), 'utf8');
  const modulesSource = readFileSync(new URL('./assistantModules.js', import.meta.url), 'utf8');
  const modulePageSource = readFileSync(new URL('./AssistantModulePage.jsx', import.meta.url), 'utf8');

  for (const route of ['pi-overview', 'pi-inbox', 'pi-connectors', 'pi-skills', 'pi-automations', 'pi-approvals', 'pi-memory', 'pi-activity', 'pi-policies', 'settings']) {
    assert.match(modulesSource, new RegExp(`page: '${route}'`));
  }
  assert.match(sidebarSource, /PI Assistant/);
  assert.match(sidebarSource, /PI_ASSISTANT_MODULES\.map/);
  assert.match(appSource, /currentPage === 'attention-inbox' \|\| currentPage === 'pi-inbox'/);
  assert.match(appSource, /isAssistantModulePage\(currentPage\)/);
  assert.match(modulePageSource, /PI Assistant Workbench/);
  assert.doesNotMatch(sidebarSource, /> Runner</);
});

test('Settings restart action is a red in-page danger control', () => {
  assert.match(chromeSource, /settings-danger-button/);
  assert.match(chromeSource, /settings-restart-confirm/);
  assert.ok(stylesSource.includes('.settings-danger-button'));
  assert.ok(stylesSource.includes('var(--error)'));
  assert.doesNotMatch(chromeSource, /window\\.confirm|window\\.alert/);
});

test('Connectors tab shows read-only connector diagnostics from API', () => {
  assert.match(sectionsSource, /ConnectorDiagnosticsPanel/);
  assert.match(apiSource, /getPiConnectors:\s*\(\)\s*=>\s*request\('\/api\/pi\/connectors'\)/);
  assert.match(connectorDiagnosticsSource, /api\.getPiConnectors\(\)/);
  assert.match(connectorDiagnosticsSource, /Connector Diagnostics/);
  assert.match(connectorDiagnosticsSource, /Connector API coming soon/);
  assert.doesNotMatch(connectorDiagnosticsSource, /window\.confirm|window\.alert/);
});

test('Skills tab shows intake and domain runtime history from API', () => {
  assert.match(sectionsSource, /SkillsRuntimePanel/);
  assert.match(apiSource, /getPiSkills/);
  assert.match(apiSource, /getPiSkillIntakeRuns/);
  assert.match(apiSource, /runPiSkillDomain/);
  assert.match(skillsRuntimeSource, /入箱识别/);
  assert.match(skillsRuntimeSource, /处理事项/);
  assert.match(skillsRuntimeSource, /Run history/);
  assert.match(skillsRuntimeSource, /optionalRuntimeList/);
  assert.match(skillsRuntimeSource, /coming soon 空态/);
  assert.doesNotMatch(skillsRuntimeSource, /window\.confirm|window\.alert/);
});
