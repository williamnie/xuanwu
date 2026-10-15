import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { translate } from '../../i18n/translations.js';

const guideSource = readFileSync(new URL('./FirstDeliveryGuide.jsx', import.meta.url), 'utf8');
const connectorSource = readFileSync(new URL('./OnboardingSupervisorConnection.jsx', import.meta.url), 'utf8');
const onboardingPageSource = readFileSync(new URL('../OnboardingPage.jsx', import.meta.url), 'utf8');
const onboardingPageStyles = readFileSync(new URL('../OnboardingPage.css', import.meta.url), 'utf8');
const dashboardSource = readFileSync(new URL('../Dashboard.jsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../../App.jsx', import.meta.url), 'utf8');
const projectsApiSource = readFileSync(new URL('../../api/projects.js', import.meta.url), 'utf8');
const firstDeliveryApiSource = readFileSync(new URL('../../api/firstDelivery.js', import.meta.url), 'utf8');
const supervisorStateSource = readFileSync(new URL('../piAgentSettingsState.js', import.meta.url), 'utf8');

test('first delivery owns a standalone first-run page and starts the selected project loop', () => {
  assert.match(onboardingPageSource, /<FirstDeliveryGuide/);
  assert.match(onboardingPageSource, /稍后设置/);
  assert.match(onboardingPageSource, /把任务交给玄武，从第一次交付开始/);
  assert.match(onboardingPageSource, /帮我只读检查这个项目/);
  assert.doesNotMatch(onboardingPageSource, /Evidence|Handoff|Issue/);
  assert.doesNotMatch(dashboardSource, /FirstDeliveryGuide/);
  assert.match(appSource, /resolveFirstRunOnboarding/);
  assert.match(appSource, /shouldShowOnboarding/);
  assert.match(appSource, /<OnboardingPage/);
  assert.match(onboardingPageStyles, /backdrop-filter:\s*saturate\(140%\) blur\(12px\)/);
  assert.match(onboardingPageStyles, /@media \(max-width: 760px\)/);
  assert.doesNotMatch(onboardingPageStyles, /#[\da-f]{3,8}|rgba?\(/i);
  assert.match(guideSource, /OnboardingSupervisorConnection/);
  assert.match(guideSource, /selectedCodeAgentID/);
  assert.match(guideSource, /provider: state\.selectedCodeAgent\.id|const provider = state\.selectedCodeAgent\.id/);
  assert.match(guideSource, /projectsApi\.updateProject\(project\.id/);
  assert.match(guideSource, /firstDeliveryApi\.startProjectLoop\(project\.id\)/);
  assert.doesNotMatch(guideSource, /settingsSection|Settings2/);
  assert.doesNotMatch(projectsApiSource, /startProjectLoop|stopProjectLoop/);
  assert.match(firstDeliveryApiSource, /startProjectLoop: \(id\) => request\(`\/api\/projects\/\$\{id\}\/loop\/start`/);
});

test('onboarding Supervisor keeps only compatible API families and PI Codex OAuth at the first level', () => {
  assert.match(connectorSource, /OPENAI-COMPATIBLE API/);
  assert.match(connectorSource, /ANTHROPIC-COMPATIBLE API/);
  assert.match(connectorSource, /t\('credential.storedLogin'\)/);
  assert.equal(translate('zh-CN', 'credential.storedLogin'), '单独登录 ChatGPT 账号');
  assert.match(connectorSource, /openai-responses/);
  assert.match(connectorSource, /openai-completions/);
  assert.doesNotMatch(connectorSource, /GOOGLE GEMINI|GEMINI API/);
  assert.match(connectorSource, /credential\.onboardingNote/);
});

test('Supervisor connection mutations invalidate stale successful tests before save', () => {
  assert.match(supervisorStateSource, /connectionAttemptRef = useRef\(0\)/);
  assert.match(supervisorStateSource, /if \(!isCurrent\(\)\) return null/);
  assert.match(supervisorStateSource, /if \(CONNECTION_FIELDS\.has\(key\)\) \{\s*invalidateConnectionTest\(\)/);
  assert.match(supervisorStateSource, /await refreshAfterSave\(setProviders, setForm\);\s*return true/);
});

test('path checking cancels stale requests and import is an explicit secondary action with disclosed effects', () => {
  assert.match(guideSource, /projectsApi\.checkPath\(path, \{ signal: controller.signal \}\)/);
  assert.match(guideSource, /if \(!controller.signal.aborted\) setPathCheck/);
  assert.match(guideSource, /window.clearTimeout\(timer\); controller.abort\(\)/);
  assert.match(guideSource, /pathCheck.path === cwd.trim\(\)/);
  assert.match(guideSource, /disabled=\{Boolean\(busy\) \|\| !validPath\}/);
  assert.match(guideSource, /className="btn btn-secondary"[^>]*onClick=\{importCodex\}/);
  assert.match(guideSource, /会对已有项目开启自动执行/);
  assert.match(projectsApiSource, /checkPath:[\s\S]*?\/api\/projects\/path-check\?/);
});

test('starting opens the created task without completing or dismissing setup, and Back returns to the guide', () => {
  assert.match(guideSource, /onOpenWork\(targetWorkRef.current\)/);
  assert.match(appSource, /isFirstDeliveryDetailRoute\(currentPage, selectedWorkId, firstDeliveryWorkId\)/);
  assert.match(appSource, /const shouldShowOnboarding = !firstDeliveryDetailOpen/);
  assert.match(appSource, /writeBrowserRoute\(\{ currentPage: 'inbox' \}, \{ replace: true \}\);\s*navigateTo\('tasks', workId\)/);
  assert.match(appSource, /navigateTo\('inbox'\)[^\n]*返回引导/);
  const openHandler = appSource.match(/onOpenWork=\{workId => \{([\s\S]*?)\}\}/)?.[1];
  assert.ok(openHandler);
  assert.doesNotMatch(openHandler, /writeFirstRunOnboardingState|skipFirstRun|completeFirstRun/);
});

test('tool preselection never binds a project and failed runtime checks survive other status failures', () => {
  const selection = guideSource.slice(guideSource.indexOf('const selectCodeAgent ='), guideSource.indexOf('const discoverCodeAgents ='));
  assert.match(selection, /setSelectedCodeAgentID\(agent.id\)/);
  assert.doesNotMatch(selection, /projectsApi\./);
  assert.match(guideSource, /preselectedCodeAgentID\(snapshot.codeAgents, selectedProject, selectedCodeAgentID\)/);
  assert.match(guideSource, /getRuntimeDoctor\(\)[\s\S]*?\.catch\([\s\S]*?\.then\(doctor => \{[\s\S]*?setSnapshot\(current => \(\{ \.\.\.current, doctor \}\)\)/);
  assert.match(guideSource, /state.runtimeReady && steps.ai.complete && \['done', 'failed', 'needs_user'\]/);
});
