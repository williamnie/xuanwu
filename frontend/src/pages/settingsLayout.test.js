import { readStylesheet } from '../../test-support/readStylesheet.js';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const settingsSource = readFileSync(new URL('./Settings.jsx', import.meta.url), 'utf8');
const chromeSource = readFileSync(new URL('./SettingsChrome.jsx', import.meta.url), 'utf8');
const sectionsSource = readFileSync(new URL('./AssistantSettingsSections.jsx', import.meta.url), 'utf8');
const settingsNavigationSource = readFileSync(new URL('./settingsNavigation.js', import.meta.url), 'utf8');
const modulesSource = readFileSync(new URL('./assistantModules.js', import.meta.url), 'utf8');
const placeholderPath = new URL('./AssistantSettingsPlaceholders.jsx', import.meta.url);
const projectSettingsEditorSource = [
  './ProjectSettingsEditor.jsx',
  './projects/useProjectSettingsEditor.js',
  './projects/ProjectRuntimeFields.jsx',
  './projects/projectSettingsForm.js',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
const projectsSource = [
  './Projects.jsx',
  './projects/ProjectCard.jsx',
  './projects/useProjectsActions.js',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
const sidebarSource = readFileSync(new URL('../components/AppSidebar.jsx', import.meta.url), 'utf8');
const stylesSource = readStylesheet(new URL('./Settings.css', import.meta.url));
const appStylesSource = readStylesheet(new URL('../index.css', import.meta.url));
const piAgentSource = [
  './PiAgentSettingsPanel.jsx',
  './PiProviderConnectionSettings.jsx',
  './PiProviderConnectionFlow.jsx',
  './PiSupervisorBehaviorSettings.jsx',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
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
  // 远程节点与项目同属“项目”分区：项目落在哪台机器上在这里管理。
  assert.match(sectionsSource, /activeTab === 'general' && <RemoteNodesPanel \/>/);
  assert.doesNotMatch(sectionsSource, /ProjectSettingsEditor|selectProjects|settings-project-select/);
  assert.match(projectsSource, /projects\.map\(proj =>/);
  assert.match(projectsSource, /handleOpenCreateModal/);
  assert.match(projectsSource, /handleOpenEditModal/);
  assert.match(projectsSource, /handleSyncCodexProjects/);
  assert.match(projectsSource, /“从 Codex 导入”：\$\{codexImportNote\(codexImport\)\}/);
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

test('Connection setup mounts only visited drawers and keeps drafts when closed', () => {
  assert.match(sectionsSource, /useState\(\(\) => channel \? \[channel\] : \[\]\)/);
  assert.match(sectionsSource, /visited\.includes\(channel\) \? visited : \[\.\.\.visited, channel\]/);
  assert.match(sectionsSource, /<IntegrationSettingsDrawer onClose=\{closeDrawer\} open=\{Boolean\(channel\)\}/);
  for (const channel of ['github', 'feishu', 'telegram']) {
    assert.ok(sectionsSource.includes(`visitedChannels.includes('${channel}') && <div hidden={channel !== '${channel}'}`));
  }
  assert.doesNotMatch(sectionsSource, /visitedChannels\.includes\('health'\)|settings-channel-navigation|ImChannelRegistryPanel/);
  const diagnostics = sectionsSource.slice(sectionsSource.indexOf('function AdvancedDiagnostics('));
  assert.match(diagnostics, /<ConnectorDiagnosticsPanel \/>/);
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
  assert.match(modulesSource, /'pi-approvals': 'inbox'/);
  for (const route of ['inbox', 'ask-xuanwu', 'tasks', 'runs', 'automations', 'settings']) {
    assert.match(modulesSource, new RegExp(`page: '${route}'`));
  }
  assert.doesNotMatch(modulesSource, /page: 'projects'/);
  assert.match(modulesSource, /projects: 'settings'/);
  assert.doesNotMatch(modulesSource, /page: 'handoffs'/);
  assert.match(sidebarSource, /PRODUCT_NAV_ITEMS/);
  assert.match(sidebarSource, /primaryNavItems\.map/);
  assert.match(sidebarSource, /footerNavItems\.map/);
  assert.doesNotMatch(sidebarSource, /PI Assistant/);
  assert.doesNotMatch(sidebarSource, /PRODUCT_TERMS\.supervisor/);
  assert.doesNotMatch(sidebarSource, /PI_ASSISTANT_NAV_ITEMS|pi-assistant-nav|pi-assistant-item/);
  assert.match(sidebarSource, /sidebar-footer-actions/);
  assert.match(appStylesSource, /\.sidebar-footer-actions \.nav-item/);
  assert.doesNotMatch(appSource, /AttentionInbox|currentPage === 'attention-inbox'|currentPage === 'pi-inbox'/);
  assert.match(modulesSource, /'attention-inbox': 'inbox'/);
  assert.match(modulesSource, /'pi-inbox': 'inbox'/);
  assert.match(appSource, /currentPage === 'inbox'/);
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
