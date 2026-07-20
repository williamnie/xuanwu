import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const settingsSource = readFileSync(new URL('./Settings.jsx', import.meta.url), 'utf8');
const chromeSource = readFileSync(new URL('./SettingsChrome.jsx', import.meta.url), 'utf8');
const sectionsSource = readFileSync(new URL('./AssistantSettingsSections.jsx', import.meta.url), 'utf8');
const settingsNavigationSource = readFileSync(new URL('./settingsNavigation.js', import.meta.url), 'utf8');
const modulesSource = readFileSync(new URL('./assistantModules.js', import.meta.url), 'utf8');
const placeholderPath = new URL('./AssistantSettingsPlaceholders.jsx', import.meta.url);
const connectorDiagnosticsSource = readFileSync(new URL('./ConnectorDiagnosticsPanel.jsx', import.meta.url), 'utf8');
const permissionsSettingsSource = readFileSync(new URL('./PermissionsSettingsPanel.jsx', import.meta.url), 'utf8');
const notificationSettingsSource = readFileSync(new URL('./NotificationSettingsPanel.jsx', import.meta.url), 'utf8');
const settingsProductModelsSource = readFileSync(new URL('./settingsProductModels.js', import.meta.url), 'utf8');
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
  assert.match(settingsNavigationSource, /Models & Agents/);
  assert.match(settingsNavigationSource, /Connections/);
  assert.match(settingsNavigationSource, /Permissions/);
  assert.match(settingsNavigationSource, /Notifications/);
  assert.match(sectionsSource, /<PiAgentSettingsPanel \/>/);
  assert.match(sectionsSource, /<PiAgentSettingsPanel advanced \/>/);
  assert.match(piAgentSource, /if \(!advanced\) return <RecommendedProviderSettings state=\{state\} \/>/);
  assert.match(piAgentSource, /<ProviderCredentialFields state=\{state\} \/>/);
  assert.match(piAgentSource, /advanced && <ApiTypeField form=\{form\} updateField=\{updateField\} \/>/);
  assert.match(piAgentSource, /<ProviderSummary providers=\{state\.providers\} \/>/);
  assert.equal(existsSync(placeholderPath), false);
  assert.doesNotMatch(sectionsSource, /SettingsPlaceholderPanel|placeholder/i);
  assert.match(sectionsSource, /SkillsRuntimePanel/);
  assert.match(sectionsSource, /PiMemoryPanel/);
  assert.match(sectionsSource, /ActivityTimelinePanel/);
  assert.match(sectionsSource, /SourcePoliciesPanel/);
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

test('advanced Runtime status exposes process-group memory freshness, roles, P95, and budget state', () => {
  assert.match(settingsSource, /status\.process_group_memory/);
  assert.match(settingsSource, /Runner process-group memory/);
  assert.match(settingsSource, /memory\.freshness/);
  assert.match(settingsSource, /memory\.roles/);
  assert.match(settingsSource, /Top PID by macOS ps RSS/);
  assert.match(settingsSource, /Group footprint/);
  assert.match(settingsSource, /array buffers/);
  assert.match(settingsSource, /rss_p95_bytes/);
  assert.match(settingsSource, /no auto-restart/);
});

test('Xuanwu product sidebar removes the PI section and keeps internal config behind Settings', () => {
  const appSource = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
  const sidebarSource = readFileSync(new URL('../components/AppSidebar.jsx', import.meta.url), 'utf8');
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
  assert.doesNotMatch(appSource, /AttentionInbox|currentPage === 'attention-inbox'|currentPage === 'pi-inbox'/);
  assert.match(modulesSource, /'attention-inbox': 'command-center'/);
  assert.match(modulesSource, /'pi-inbox': 'command-center'/);
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
  assert.match(settingsSource, /connectorsApi\.getPiConnectorDiagnostics\(\)/);
  assert.match(settingsSource, /下载诊断包/);
  assert.match(runtimeDiagnosticsSource, /xuanwu\.runtime-diagnostics\.v1/);
  assert.match(runtimeDiagnosticsSource, /redactDiagnosticValue/);
  assert.doesNotMatch(settingsSource, /window\.confirm|window\.alert/);
});

test('Connections shows connector health, test and inline revoke controls from API', () => {
  assert.match(sectionsSource, /ConnectorDiagnosticsPanel/);
  assert.match(connectorsApiSource, /getPiConnectors:\s*\(\)\s*=>\s*request\('\/api\/pi\/connectors'\)/);
  assert.match(connectorsApiSource, /testPiConnector/);
  assert.match(connectorsApiSource, /revokePiConnectorSecret/);
  assert.match(connectorDiagnosticsSource, /connectorsApi\.getPiConnectors\(\)/);
  assert.match(connectorDiagnosticsSource, /> Connections/);
  assert.match(connectorDiagnosticsSource, /配置/);
  assert.match(connectorDiagnosticsSource, /configureGuide/);
  assert.match(connectorDiagnosticsSource, /测试连接/);
  assert.match(connectorDiagnosticsSource, /确认撤销/);
  assert.match(connectorDiagnosticsSource, /Connector API coming soon/);
  assert.doesNotMatch(connectorDiagnosticsSource, /window\.confirm|window\.alert/);
});

test('Permissions projects live connector capabilities and preserves deterministic Approval authority', () => {
  assert.match(sectionsSource, /PermissionsSettingsPanel/);
  assert.match(permissionsSettingsSource, /connectorsApi\.getPiConnectors\(\)/);
  assert.match(permissionsSettingsSource, /Connector permission matrix/);
  assert.match(permissionsSettingsSource, /Action Gate 风险边界/);
  for (const authority of ['pi_approval_requests', 'pi_actions', 'pi_action_events']) {
    assert.match(permissionsSettingsSource, new RegExp(authority));
  }
  for (const risk of ['read_only', 'internal_write', 'external_write', 'dangerous']) {
    assert.match(permissionsSettingsSource, new RegExp(risk));
  }
  assert.match(permissionsSettingsSource, /不能降低风险、扩大 scope 或绕过确定性 deny/);
  assert.doesNotMatch(permissionsSettingsSource, /window\.confirm|window\.alert/);
});

test('Notifications edits the existing versioned preference authority and shows channel health', () => {
  assert.match(sectionsSource, /NotificationSettingsPanel/);
  assert.match(notificationSettingsSource, /assistantApi\.getPiGuardianPreferences/);
  assert.match(notificationSettingsSource, /assistantApi\.createPiGuardianPreference/);
  assert.match(notificationSettingsSource, /assistantApi\.disablePiGuardianPreference/);
  assert.match(notificationSettingsSource, /connectorsApi\.getPiConnectors/);
  assert.match(notificationSettingsSource, /版本与审计记录/);
  assert.match(settingsProductModelsSource, /source_message_id: 'settings:notifications'/);
  assert.match(settingsProductModelsSource, /digest_policy: form\.digestPolicy/);
  assert.doesNotMatch(notificationSettingsSource, /window\.confirm|window\.alert/);
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

test('Policies tab reads source profiles without retaining legacy Automation writers', () => {
  assert.match(sectionsSource, /SourcePoliciesPanel/);
  assert.match(automationApiSource, /getPiSourcePolicies/);
  assert.doesNotMatch(automationApiSource, /updatePiAutomationSourcePolicy|createPiSourcePolicy/);
  assert.match(sourcePoliciesSource, /Source Policy/);
  assert.match(sourcePoliciesSource, /Read-only source profiles/);
  assert.match(sourcePoliciesSource, /permission_policy_ref/);
  assert.doesNotMatch(sourcePoliciesSource, /window\.confirm|window\.alert/);
});

test('Automations and Approval queues live outside Settings', () => {
  assert.doesNotMatch(sectionsSource, /AutomationsRuntimePanel/);
  assert.doesNotMatch(sectionsSource, /activeTab === 'automations'/);
  assert.match(modulesSource, /'pi-approvals': 'command-center'/);
  assert.doesNotMatch(sectionsSource, /Approval queue|ApprovalQueue/);
});
