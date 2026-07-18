import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const settingsSource = readFileSync(new URL('./Settings.jsx', import.meta.url), 'utf8');
const chromeSource = readFileSync(new URL('./SettingsChrome.jsx', import.meta.url), 'utf8');
const sectionsSource = readFileSync(new URL('./AssistantSettingsSections.jsx', import.meta.url), 'utf8');
const placeholderSource = readFileSync(new URL('./AssistantSettingsPlaceholders.jsx', import.meta.url), 'utf8');
const connectorDiagnosticsSource = readFileSync(new URL('./ConnectorDiagnosticsPanel.jsx', import.meta.url), 'utf8');
const skillsRuntimeSource = readFileSync(new URL('./SkillsRuntimePanel.jsx', import.meta.url), 'utf8');
const activityTimelineSource = readFileSync(new URL('./ActivityTimelinePanel.jsx', import.meta.url), 'utf8');
const sourcePoliciesSource = readFileSync(new URL('./SourcePoliciesPanel.jsx', import.meta.url), 'utf8');
const assistantApiSource = readFileSync(new URL('../api/assistant.js', import.meta.url), 'utf8');
const automationApiSource = readFileSync(new URL('../api/automation.js', import.meta.url), 'utf8');
const connectorsApiSource = readFileSync(new URL('../api/connectors.js', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('./Settings.css', import.meta.url), 'utf8');
const appStylesSource = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
const piAgentSource = readFileSync(new URL('./PiAgentSettingsPanel.jsx', import.meta.url), 'utf8');
const runtimeDiagnosticsSource = readFileSync(new URL('../utils/runtimeDiagnostics.js', import.meta.url), 'utf8');

test('Settings renders five primary sections and gates internal panels behind Advanced', () => {
  assert.match(settingsSource, /initialTab = 'general'/);
  assert.match(settingsSource, /resolveSettingsRoute\(initialTab\)/);
  for (const tab of ['general', 'models-agents', 'connections', 'permissions', 'notifications']) {
    assert.match(sectionsSource, new RegExp(`activeTab === '${tab}'`));
  }
  for (const tab of ['runtime', 'model-runtime', 'mcp', 'skills', 'memory', 'activity', 'policies']) {
    assert.match(sectionsSource, new RegExp(`activeTab === '${tab}'`));
  }
  assert.match(sectionsSource, /tier === 'advanced'/);
  assert.match(chromeSource, /SETTINGS_PRIMARY_TABS/);
  assert.match(chromeSource, /SETTINGS_ADVANCED_TABS/);
  assert.match(chromeSource, /settings-advanced-gate/);
  assert.doesNotMatch(settingsSource, /CronTasksPanel/);
  assert.doesNotMatch(chromeSource, /Cron 任务已在侧边栏/);
});

test('Settings primary IA includes project settings without duplicating its source of truth', () => {
  assert.match(chromeSource, /title = 'Settings'/);
  assert.match(chromeSource, /Xuanwu · Product Settings/);
  assert.match(sectionsSource, /Per-project settings/);
  assert.match(sectionsSource, /navigateTo\?\.\('projects'\)/);
  assert.match(sectionsSource, /不会产生双写/);
  assert.match(sectionsSource, /Models & Agents/);
  assert.match(sectionsSource, /Connections/);
  assert.match(sectionsSource, /Permissions/);
  assert.match(sectionsSource, /Notifications/);
  assert.match(sectionsSource, /<PiAgentSettingsPanel \/>/);
  assert.match(sectionsSource, /<PiAgentSettingsPanel advanced \/>/);
  assert.match(piAgentSource, /if \(!advanced\) return <RecommendedProviderSettings state=\{state\} \/>/);
  assert.match(piAgentSource, /<ProviderCredentialFields state=\{state\} \/>/);
  assert.match(piAgentSource, /advanced && <ApiTypeField form=\{form\} updateField=\{updateField\} \/>/);
  assert.match(piAgentSource, /<ProviderSummary providers=\{state\.providers\} \/>/);
  assert.doesNotMatch(placeholderSource, /Runner Brain/);
  assert.match(sectionsSource, /Skills/);
  assert.match(sectionsSource, /Command Center/);
  assert.match(sectionsSource, /Memory/);
  assert.match(sectionsSource, /Activity/);
  assert.match(sectionsSource, /Policies/);
});

test('ordinary Settings route does not render raw runtime controls', () => {
  const primaryStart = sectionsSource.indexOf('function GeneralSettingsTab');
  const advancedStart = sectionsSource.indexOf('function AdvancedSettingsTab');
  const primarySource = sectionsSource.slice(primaryStart, advancedStart);
  assert.doesNotMatch(primarySource, /Runtime API Type|User-Agent|Prompt 摘要|PiMcpManagementPanel|RuntimeStatusPanel/);
  assert.match(piAgentSource, /advanced = false/);
  assert.match(piAgentSource, /if \(!advanced\) return <RecommendedProviderSettings/);
  assert.match(piAgentSource, /<PiSettingsGrid advanced/);
  assert.match(piAgentSource, /<ProviderCredentialFields/);
  assert.match(piAgentSource, /\{advanced && <ApiTypeField/);
  assert.match(piAgentSource, /<ProviderSummary/);
});

test('Xuanwu product sidebar removes the PI section and keeps internal config behind Settings', () => {
  const appSource = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
  const sidebarSource = readFileSync(new URL('../components/AppSidebar.jsx', import.meta.url), 'utf8');
  const modulesSource = readFileSync(new URL('./assistantModules.js', import.meta.url), 'utf8');

  for (const route of ['pi-overview', 'pi-connectors', 'pi-skills', 'pi-memory', 'pi-activity', 'pi-policies']) {
    assert.match(modulesSource, new RegExp(`page: '${route}'`));
  }
  assert.match(modulesSource, /'pi-automations': 'automations'/);
  assert.match(modulesSource, /'pi-approvals': 'command-center'/);
  for (const route of ['command-center', 'ask-xuanwu', 'work', 'runs', 'handoffs', 'automations', 'projects', 'connections', 'settings']) {
    assert.match(modulesSource, new RegExp(`page: '${route}'`));
  }
  assert.match(sidebarSource, /productNavigationItems/);
  assert.match(sidebarSource, /primaryNavItems\.map/);
  assert.match(sidebarSource, /footerNavItems\.map/);
  assert.doesNotMatch(sidebarSource, /PI Assistant/);
  assert.doesNotMatch(sidebarSource, /PRODUCT_TERMS\.supervisor/);
  assert.doesNotMatch(sidebarSource, /PI_ASSISTANT_NAV_ITEMS|pi-assistant-nav|pi-assistant-item/);
  assert.match(sidebarSource, /sidebar-footer-actions/);
  assert.match(appStylesSource, /\.sidebar-footer-actions \.nav-item/);
  assert.match(appSource, /currentPage === 'attention-inbox' \|\| currentPage === 'pi-inbox'/);
  assert.match(appSource, /currentPage === 'command-center'/);
  assert.match(appSource, /currentPage === 'ask-xuanwu'/);
  assert.match(appSource, /currentPage === 'automations'/);
  assert.match(appSource, /currentPage === 'connections'/);
  assert.match(appSource, /isAssistantModulePage\(currentPage\)/);
  assert.match(appSource, /<Settings initialTab=\{assistantModule\?\.tab\} navigateTo=\{navigateTo\} \/>/);
  assert.doesNotMatch(appSource, /from '\.\/pages\/AssistantModulePage'/);
});

test('Settings restart action moves from the page header into Advanced Runtime', () => {
  assert.match(chromeSource, /settings-danger-button/);
  assert.match(chromeSource, /settings-restart-confirm/);
  assert.match(chromeSource, /export function RestartAction/);
  assert.match(sectionsSource, /AdvancedRuntimeSettingsTab/);
  assert.match(sectionsSource, /<RestartAction \/>/);
  assert.ok(stylesSource.includes('.settings-danger-button'));
  assert.ok(stylesSource.includes('var(--error)'));
  assert.doesNotMatch(chromeSource, /window\\.confirm|window\\.alert/);
});

test('Advanced Runtime exports one redacted diagnostics bundle from existing system APIs', () => {
  assert.match(settingsSource, /downloadDiagnostics/);
  assert.match(settingsSource, /systemApi\.getRuntimeDoctor\(\)/);
  assert.match(settingsSource, /systemApi\.getRuntimeLogs\(120\)/);
  assert.match(settingsSource, /下载诊断包/);
  assert.match(runtimeDiagnosticsSource, /xuanwu\.runtime-diagnostics\.v1/);
  assert.match(runtimeDiagnosticsSource, /redactDiagnosticValue/);
  assert.doesNotMatch(settingsSource, /window\.confirm|window\.alert/);
});

test('Connectors tab shows read-only connector diagnostics from API', () => {
  assert.match(sectionsSource, /ConnectorDiagnosticsPanel/);
  assert.match(connectorsApiSource, /getPiConnectors:\s*\(\)\s*=>\s*request\('\/api\/pi\/connectors'\)/);
  assert.match(connectorDiagnosticsSource, /connectorsApi\.getPiConnectors\(\)/);
  assert.match(connectorDiagnosticsSource, /Connector Diagnostics/);
  assert.match(connectorDiagnosticsSource, /Connector API coming soon/);
  assert.doesNotMatch(connectorDiagnosticsSource, /window\.confirm|window\.alert/);
});

test('Skills tab shows intake and domain runtime history from API', () => {
  assert.match(sectionsSource, /SkillsRuntimePanel/);
  assert.match(assistantApiSource, /getPiSkills/);
  assert.match(assistantApiSource, /getPiSkillIntakeRuns/);
  assert.match(assistantApiSource, /runPiSkillDomain/);
  assert.match(skillsRuntimeSource, /入箱识别/);
  assert.match(skillsRuntimeSource, /处理事项/);
  assert.match(skillsRuntimeSource, /Run history/);
  assert.match(skillsRuntimeSource, /optionalRuntimeList/);
  assert.match(skillsRuntimeSource, /coming soon 空态/);
  assert.doesNotMatch(skillsRuntimeSource, /window\.confirm|window\.alert/);
});

test('Activity tab shows traceable redacted timeline from API', () => {
  assert.match(sectionsSource, /ActivityTimelinePanel/);
  assert.match(assistantApiSource, /getPiActivityTimeline/);
  assert.match(activityTimelineSource, /Raw → Intake → Action trace/);
  assert.match(activityTimelineSource, /source/);
  assert.match(activityTimelineSource, /conversationId/);
  assert.match(activityTimelineSource, /proposalId/);
  assert.match(activityTimelineSource, /Stage/);
  assert.match(activityTimelineSource, /Decision/);
  assert.match(activityTimelineSource, /summaries are redacted/);
  assert.doesNotMatch(activityTimelineSource, /window\.confirm|window\.alert/);
});

test('Policies tab manages source policies from API', () => {
  assert.match(sectionsSource, /SourcePoliciesPanel/);
  assert.match(automationApiSource, /getPiSourcePolicies/);
  assert.match(automationApiSource, /updatePiAutomationSourcePolicy/);
  assert.match(sourcePoliciesSource, /Source Policy/);
  assert.match(sourcePoliciesSource, /auto_create_triage_issue/);
  assert.match(sourcePoliciesSource, /auto_enqueue/);
  assert.match(sourcePoliciesSource, /require_project_confirmation/);
  assert.match(sourcePoliciesSource, /allowed_chats/);
  assert.doesNotMatch(sourcePoliciesSource, /window\.confirm|window\.alert/);
});

test('Automations and Approval queues live outside Settings', () => {
  assert.doesNotMatch(sectionsSource, /AutomationsRuntimePanel/);
  assert.doesNotMatch(sectionsSource, /activeTab === 'automations'/);
  assert.match(sectionsSource, /待处理 Approval 已统一放在 Command Center/);
});
