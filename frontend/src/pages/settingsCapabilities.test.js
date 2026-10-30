import { readStylesheet } from '../../test-support/readStylesheet.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sectionsSource = readFileSync(new URL('./AssistantSettingsSections.jsx', import.meta.url), 'utf8');
const modulesSource = readFileSync(new URL('./assistantModules.js', import.meta.url), 'utf8');
const connectorDiagnosticsSource = readFileSync(new URL('./ConnectorDiagnosticsPanel.jsx', import.meta.url), 'utf8');
const permissionsSettingsSource = readFileSync(new URL('./PermissionsSettingsPanel.jsx', import.meta.url), 'utf8');
const notificationSettingsSource = readFileSync(new URL('./NotificationSettingsPanel.jsx', import.meta.url), 'utf8');
const settingsProductModelsSource = readFileSync(new URL('./settingsProductModels.js', import.meta.url), 'utf8');
const skillsRuntimeSource = readFileSync(new URL('./SkillsRuntimePanel.jsx', import.meta.url), 'utf8');
const activityTimelineSource = readFileSync(new URL('./ActivityTimelinePanel.jsx', import.meta.url), 'utf8');
const activityTimelineStyles = readFileSync(new URL('./ActivityTimelinePanel.css', import.meta.url), 'utf8');
const sourcePoliciesSource = readFileSync(new URL('./SourcePoliciesPanel.jsx', import.meta.url), 'utf8');
const assistantApiSource = readFileSync(new URL('../api/assistant.js', import.meta.url), 'utf8');
const automationApiSource = readFileSync(new URL('../api/automation.js', import.meta.url), 'utf8');
const connectorsApiSource = readFileSync(new URL('../api/connectors.js', import.meta.url), 'utf8');
const stylesSource = readStylesheet(new URL('./Settings.css', import.meta.url));

test('Settings owns provider, Code Agent, integration and MCP management', () => {
  assert.match(sectionsSource, /CodeAgentsPanel/);
  assert.match(sectionsSource, /PiAgentSettingsPanel/);
  assert.match(sectionsSource, /ConnectorDiagnosticsPanel/);
  assert.match(sectionsSource, /FeishuSettingsPanel/);
  assert.match(sectionsSource, /PiMcpManagementPanel/);
  assert.match(connectorsApiSource, /getPiConnectors:\s*\(\)\s*=>\s*request\('\/api\/pi\/connectors'\)/);
  assert.match(connectorsApiSource, /testPiConnector/);
  assert.match(connectorsApiSource, /revokePiConnectorSecret/);
  assert.match(connectorDiagnosticsSource, /connectorsApi\.getPiConnectors\(\)/);
  assert.match(connectorDiagnosticsSource, /> Integration health/);
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
  assert.match(permissionsSettingsSource, /外部连接权限/);
  assert.match(permissionsSettingsSource, /labels=\{\['连接', '方向', '授权'\]\}/);
  assert.doesNotMatch(permissionsSettingsSource, /能力标识|<code>\{row\.capabilityID\}<\/code>/);
  assert.match(permissionsSettingsSource, /title=\{row\.capabilityID\}/);
  assert.match(stylesSource, /\.settings-connector-permissions \.settings-permission-row\s*\{[^}]*grid-template-columns:[^;]*;[^}]*min-width: 0;/);
  assert.match(permissionsSettingsSource, /操作与审批规则/);
  assert.match(permissionsSettingsSource, /审批决定和执行结果都会保留记录/);
  assert.match(permissionsSettingsSource, /批准后也不能超出项目允许的权限范围/);
  for (const risk of ['read_only', 'internal_write', 'external_write', 'dangerous']) {
    assert.match(permissionsSettingsSource, new RegExp(risk));
  }
  assert.match(permissionsSettingsSource, /不能自行降低风险等级、扩大授权范围或绕过明确禁止的操作/);
  assert.doesNotMatch(permissionsSettingsSource, /window\.confirm|window\.alert/);
});

test('Notifications edits the existing versioned preference authority and shows channel health', () => {
  assert.match(sectionsSource, /NotificationSettingsPanel/);
  assert.match(notificationSettingsSource, /assistantApi\.getPiGuardianPreferences/);
  assert.match(notificationSettingsSource, /assistantApi\.createPiGuardianPreference/);
  assert.match(notificationSettingsSource, /assistantApi\.disablePiGuardianPreference/);
  assert.match(notificationSettingsSource, /connectorsApi\.getPiConnectors/);
  // 历史版本列表删除；当前生效的自定义设置保留“停用并恢复默认”（方案 6.4 ③ 通知）。
  assert.doesNotMatch(notificationSettingsSource, /保存记录|PreferenceHistory/);
  assert.match(notificationSettingsSource, /停用并恢复默认/);
  assert.match(notificationSettingsSource, /active\.admin_enforced/);
  assert.match(notificationSettingsSource, /notificationModeValue\(/);
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

test('Skills refresh preserves detail state and tolerates an absent detail cache', () => {
  assert.match(skillsRuntimeSource, /state\.skillDetails\?\.\[selectedId\]/);
  assert.match(
    skillsRuntimeSource,
    /\.then\(\(\[skills, intakeRuns, domainRuns, bundles, items\]\) => setState\(\(previous\) => \(\{\s*\.\.\.previous,/
  );
});

test('Activity tab shows traceable redacted timeline from API', () => {
  assert.match(sectionsSource, /ActivityTimelinePanel/);
  assert.match(assistantApiSource, /getPiActivityTimeline/);
  assert.match(activityTimelineSource, /<h2>处理记录<\/h2>/);
  assert.match(activityTimelineSource, /source/);
  assert.match(activityTimelineSource, /conversationId/);
  assert.match(activityTimelineSource, /proposalId/);
  assert.match(activityTimelineSource, /Stage/);
  assert.match(activityTimelineSource, /Decision/);
  assert.match(activityTimelineSource, /summaries are redacted/);
  assert.doesNotMatch(activityTimelineSource, /window\.confirm|window\.alert/);
});

test('Activity filters shrink inside their grid tracks without overlapping', () => {
  assert.match(activityTimelineStyles, /\.activity-panel \{[\s\S]*?min-width: 0;/);
  assert.match(activityTimelineStyles, /grid-template-columns: repeat\(auto-fit, minmax\(min\(150px, 100%\), 1fr\)\);/);
  assert.match(activityTimelineStyles, /\.activity-filter label \{[\s\S]*?min-width: 0;/);
  assert.match(activityTimelineStyles, /\.activity-filter input,[\s\S]*?min-width: 0;[\s\S]*?width: 100%;/);
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
  assert.match(modulesSource, /'pi-approvals': 'inbox'/);
  assert.doesNotMatch(sectionsSource, /Approval queue|ApprovalQueue/);
});
