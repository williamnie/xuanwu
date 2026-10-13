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
const projectSettingsEditorSource = readFileSync(new URL('./ProjectSettingsEditor.jsx', import.meta.url), 'utf8');
const projectsSource = readFileSync(new URL('./Projects.jsx', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../components/AppSidebar.jsx', import.meta.url), 'utf8');
const skillsRuntimeSource = readFileSync(new URL('./SkillsRuntimePanel.jsx', import.meta.url), 'utf8');
const activityTimelineSource = readFileSync(new URL('./ActivityTimelinePanel.jsx', import.meta.url), 'utf8');
const activityTimelineStyles = readFileSync(new URL('./ActivityTimelinePanel.css', import.meta.url), 'utf8');
const sourcePoliciesSource = readFileSync(new URL('./SourcePoliciesPanel.jsx', import.meta.url), 'utf8');
const assistantApiSource = readFileSync(new URL('../api/assistant.js', import.meta.url), 'utf8');
const automationApiSource = readFileSync(new URL('../api/automation.js', import.meta.url), 'utf8');
const connectorsApiSource = readFileSync(new URL('../api/connectors.js', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('./Settings.css', import.meta.url), 'utf8');
const appStylesSource = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
const piAgentSource = readFileSync(new URL('./PiAgentSettingsPanel.jsx', import.meta.url), 'utf8');
const runtimeDiagnosticsSource = readFileSync(new URL('../utils/runtimeDiagnostics.js', import.meta.url), 'utf8');

test('Settings renders five sections and keeps internal panels inside Advanced', () => {
  assert.match(settingsSource, /initialTab = 'general'/);
  assert.match(settingsSource, /resolveSettingsRoute\(initialTab\)/);
  for (const tab of ['general', 'ai', 'notifications', 'preferences', 'advanced']) {
    assert.match(sectionsSource, new RegExp(`activeTab === '${tab}'`));
  }
  assert.match(sectionsSource, /SETTINGS_ADVANCED_SECTIONS\.map/);
  for (const section of ['diagnostics', 'security', 'skills', 'memory', 'activity']) {
    assert.match(sectionsSource, new RegExp(`${section}: <`));
  }
  assert.match(chromeSource, /SETTINGS_SECTIONS\.map/);
  assert.match(chromeSource, /settings-directory/);
  assert.match(chromeSource, /aria-current=\{route\.tab === id \? 'page' : undefined\}/);
  assert.match(chromeSource, /<select value=\{route\.tab\}/);
  assert.doesNotMatch(chromeSource, /settings-advanced-gate|toggleAdvanced|role="tab"|role="tablist"/);
  assert.match(stylesSource, /\.settings-workspace \{[\s\S]*?grid-template-columns: 208px minmax\(0, 1fr\);/);
  assert.match(stylesSource, /\.settings-directory-link \{[\s\S]*?border-radius: var\(--button-radius\);/);
  assert.doesNotMatch(settingsSource, /CronTasksPanel/);
  assert.doesNotMatch(settingsNavigationSource, /id: 'connections'/);
});

test('Settings Projects owns the complete project list and editor flow; preferences hold language, theme and updates', () => {
  assert.match(chromeSource, /title = 'Settings'/);
  assert.match(chromeSource, /settings-eyebrow">SETTINGS/);
  assert.match(sectionsSource, /activeTab === 'general' && <Projects \/>/);
  assert.doesNotMatch(sectionsSource, /ProjectSettingsEditor|selectProjects|settings-project-select/);
  assert.match(projectsSource, /projects\.map\(proj =>/);
  assert.match(projectsSource, /handleOpenCreateModal/);
  assert.match(projectsSource, /handleOpenEditModal/);
  assert.match(projectsSource, /handleSyncCodexProjects/);
  assert.match(projectsSource, /已存在的项目会被开启自动执行/);
  assert.match(projectsSource, /handleDelete/);
  assert.match(projectsSource, /<ProjectSettingsEditor/);
  assert.match(projectSettingsEditorSource, /projectsApi\.updateProject\(projectID, payload\)/);
  const preferences = sectionsSource.slice(sectionsSource.indexOf('function PreferencesTab'), sectionsSource.indexOf('function LanguageCard'));
  assert.match(preferences, /<LanguageCard \/>/);
  assert.match(preferences, /<ThemeCard theme=\{theme\} toggleTheme=\{toggleTheme\} \/>/);
  assert.match(preferences, /<ReleaseUpdatePanel \/>/);
  assert.match(sectionsSource, /settings-version-inline/);
  assert.match(sectionsSource, /APP_VERSION/);
  assert.match(stylesSource, /\.settings-language-bar \{[\s\S]*?min-height: 44px;/);
  assert.match(stylesSource, /\.settings-page \.glass-card \{\s*border-radius: var\(--radius-xs\);/);
  assert.doesNotMatch(sidebarSource, /sidebar-language-row|APP_VERSION|sidebar-version/);
  for (const panel of ['PiAgentSettingsPanel', 'CodeAgentsPanel', 'ConnectorDiagnosticsPanel', 'FeishuSettingsPanel', 'PiMcpManagementPanel', 'SkillsRuntimePanel', 'PiMemoryPanel', 'ActivityTimelinePanel', 'SourcePoliciesPanel', 'PermissionsSettingsPanel', 'NotificationSettingsPanel']) {
    assert.match(sectionsSource, new RegExp(`<${panel}`), panel);
  }
  assert.doesNotMatch(sectionsSource, /ProviderAvailabilityPanel/);
  assert.equal(existsSync(new URL('./ProviderAvailabilityPanel.jsx', import.meta.url)), false);
  assert.match(piAgentSource, /SupervisorSettingsForm/);
  assert.match(piAgentSource, /<ApiConnectionFlow state=\{state\} \/>/);
  assert.match(piAgentSource, /<ApiTypeField state=\{state\} \/>/);
  assert.match(piAgentSource, /<ProviderSummary providers=\{state\.providers\} \/>/);
  assert.equal(existsSync(placeholderPath), false);
  assert.doesNotMatch(sectionsSource, /SettingsPlaceholderPanel|placeholder/i);
});

test('Settings content stays anchored and maintenance is outside everyday project setup', () => {
  assert.match(settingsSource, /className="settings-workspace"/);
  assert.match(settingsSource, /aria-labelledby="settings-section-title"/);
  assert.match(settingsSource, /contentRef\.current\.scrollTop = 0/);
  assert.doesNotMatch(settingsSource, /settings-page animate-fade-in/);
  assert.match(stylesSource, /scrollbar-gutter: stable/);
  assert.match(stylesSource, /@media \(max-width: 760px\)/);
  assert.match(stylesSource, /\.settings-directory-link:focus-visible/);
  const diagnostics = sectionsSource.slice(sectionsSource.indexOf('function AdvancedDiagnostics('));
  assert.match(diagnostics, /<RuntimeStatusPanel \/>/);
  assert.match(diagnostics, /<RunnerSettingsPanel \/>/);
  assert.match(diagnostics, /<RemoteAccessTokenPanel \/>/);
  assert.match(diagnostics, /<RestartAction \/>/);
  assert.doesNotMatch(diagnostics, /ReleaseUpdatePanel/);
});

test('Connection setup loads only visited platforms and keeps their drafts mounted between switches', () => {
  assert.match(sectionsSource, /const \[visitedChannels, setVisitedChannels\] = useState\(\['github'\]\)/);
  assert.match(sectionsSource, /visited\.includes\(nextChannel\) \? visited : \[\.\.\.visited, nextChannel\]/);
  for (const channel of ['github', 'feishu', 'telegram', 'health']) {
    assert.match(sectionsSource, new RegExp(`visitedChannels\\.includes\\('${channel}'\\) && <div`));
  }
  assert.match(sectionsSource, /hidden=\{channel !== 'github'\}><GitHubSettingsPanel/);
  assert.match(sectionsSource, /hidden=\{channel !== 'feishu'\}><FeishuSettingsPanel/);
  assert.match(sectionsSource, /hidden=\{channel !== 'telegram'\}><TelegramSettingsPanel/);
  assert.match(sectionsSource, /hidden=\{channel !== 'health'\}><ConnectorDiagnosticsPanel/);
  assert.match(sectionsSource, /aria-pressed=\{channel === id\}/);
});

test('Advanced sections mount on first open, stay mounted when collapsed, and deep links open the target only', () => {
  assert.match(sectionsSource, /useState\(\(\) => new Set\(section \? \[section\] : \[\]\)\)/);
  assert.match(sectionsSource, /if \(!event\.currentTarget\.open\) return;/);
  assert.match(sectionsSource, /visited\.has\(id\) \? <div className="settings-disclosure-content settings-advanced-body">/);
  assert.match(sectionsSource, /element\.open = true;/);
  assert.match(sectionsSource, /scrollIntoView/);
  assert.doesNotMatch(sectionsSource, /visited\.delete|setVisited\(new Set\(\)\)/);
});

test('AI connections keep coding tools and the assistant on one page; MCP moves to Advanced skills', () => {
  const ai = sectionsSource.slice(sectionsSource.indexOf('function AiConnectionsTab'), sectionsSource.indexOf('function NotificationsTab'));
  assert.match(ai, /<CodeAgentsPanel \/>/);
  assert.match(ai, /<PiAgentSettingsPanel \/>/);
  assert.match(sectionsSource, /skills: <><SkillsRuntimePanel \/><PiMcpManagementPanel embedded \/><\/>/);
  assert.match(piAgentSource, /连接助手模型/);
  assert.match(piAgentSource, /助手偏好/);
  assert.match(piAgentSource, /handleConnectionApply/);
  assert.match(piAgentSource, /handleAgentSave/);
  assert.match(piAgentSource, /<SupervisorBehaviorSettings state=\{state\} \/>/);
  assert.match(piAgentSource, /<ConnectionModeTabs oauthMode=\{oauthMode\} state=\{state\} \/>/);
  assert.match(piAgentSource, /<ModelSelection state=\{state\} \/>/);
  assert.doesNotMatch(piAgentSource, /AdvancedProviderGrid|ProviderCredentialFields|Provider ID|User-Agent/);
  assert.doesNotMatch(sectionsSource, /ApiTypeField|ProviderCredentialFields/);
  assert.match(piAgentSource, /<ProviderSummary/);
});

test('Advanced maintenance shows one health line and leaves process detail to the diagnostics bundle', () => {
  assert.match(settingsSource, /function RuntimeHealthLine/);
  assert.match(settingsSource, /status\.health\?\.reasons/);
  assert.match(settingsSource, /复制诊断摘要/);
  assert.match(settingsSource, /下载诊断包/);
  assert.match(settingsSource, /systemApi\.getRuntimeDoctor\(\)/);
  assert.match(settingsSource, /<SecurityWarnings/);
  assert.match(settingsSource, /<RuntimeLogsPanel/);
  assert.doesNotMatch(settingsSource, /process_group_memory|Top PID by macOS ps RSS|rss_p95_bytes/);
  assert.match(runtimeDiagnosticsSource, /doctor/);
});

test('Advanced maintenance keeps concurrency, remote access and restart, and Codex run mode lives only in AI connections', () => {
  const runnerSource = readFileSync(new URL('./RunnerSettingsPanel.jsx', import.meta.url), 'utf8');
  const codeAgentsSource = readFileSync(new URL('./CodeAgentsPanel.jsx', import.meta.url), 'utf8');
  assert.match(runnerSource, /updateRunnerSettings\(\{ max_parallel_projects: Number\(draft\) \}\)/);
  assert.doesNotMatch(runnerSource, /codex_server_mode|首次使用启动器|install-release\.sh/);
  assert.match(codeAgentsSource, /codexBackendUpdatePayload\(mode\)/);
  assert.match(codeAgentsSource, /codex_effective_command/);
  assert.match(codeAgentsSource, /codex_cli_command: commands\.cli/);
  assert.match(codeAgentsSource, /codex_app_command: commands\.app/);
});

test('Xuanwu product sidebar removes the PI section and keeps internal config behind Settings', () => {
  const appSource = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
  const sidebarSource = readFileSync(new URL('../components/AppSidebar.jsx', import.meta.url), 'utf8');
  for (const route of ['pi-skills', 'pi-memory', 'pi-activity', 'pi-policies']) {
    assert.match(modulesSource, new RegExp(`page: '${route}'`));
  }
  assert.match(modulesSource, /'pi-automations': 'automations'/);
  assert.match(modulesSource, /'pi-approvals': 'command-center'/);
  for (const route of ['command-center', 'ask-xuanwu', 'work', 'runs', 'automations', 'settings']) {
    assert.match(modulesSource, new RegExp(`page: '${route}'`));
  }
  assert.doesNotMatch(modulesSource, /page: 'projects'/);
  assert.match(modulesSource, /projects: 'settings'/);
  assert.doesNotMatch(modulesSource, /page: 'handoffs'/);
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
  assert.doesNotMatch(appSource, /currentPage === 'connections'/);
  assert.match(appSource, /isAssistantModulePage\(currentPage\)/);
  assert.match(appSource, /<Settings initialTab=\{assistantModule\?\.tab\} navigateTo=\{navigateTo\} onSectionChange=\{navigateToSettingsSection\} \/>/);
  assert.doesNotMatch(appSource, /from '\.\/pages\/AssistantModulePage'/);
});

test('Settings restart action lives in Advanced maintenance', () => {
  assert.match(chromeSource, /settings-danger-button/);
  assert.match(chromeSource, /settings-restart-confirm/);
  assert.match(chromeSource, /export function RestartAction/);
  assert.match(sectionsSource, /function AdvancedDiagnostics\(/);
  assert.match(sectionsSource, /<RestartAction \/>/);
  assert.ok(stylesSource.includes('.settings-danger-button'));
  assert.ok(stylesSource.includes('var(--error)'));
  assert.doesNotMatch(chromeSource, /window\\.confirm|window\\.alert/);
});

test('Advanced Diagnostics exports one redacted diagnostics bundle from existing system APIs', () => {
  assert.match(settingsSource, /downloadDiagnostics/);
  assert.match(settingsSource, /systemApi\.getRuntimeDoctor\(\)/);
  assert.match(settingsSource, /systemApi\.getRuntimeLogs\(120\)/);
  assert.match(settingsSource, /connectorsApi\.getPiConnectorDiagnostics\(\)/);
  assert.match(settingsSource, /下载诊断包/);
  assert.match(runtimeDiagnosticsSource, /xuanwu\.runtime-diagnostics\.v1/);
  assert.match(runtimeDiagnosticsSource, /redactDiagnosticValue/);
  assert.doesNotMatch(settingsSource, /window\.confirm|window\.alert/);
});

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
  assert.match(notificationSettingsSource, /保存记录/);
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
  assert.match(modulesSource, /'pi-approvals': 'command-center'/);
  assert.doesNotMatch(sectionsSource, /Approval queue|ApprovalQueue/);
});
