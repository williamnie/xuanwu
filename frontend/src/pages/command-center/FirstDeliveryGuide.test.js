import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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
  assert.match(onboardingPageSource, /把 Issue 列好，剩下的交给玄武/);
  assert.match(onboardingPageSource, /现在启动这 10 个，你自己看着做/);
  assert.doesNotMatch(onboardingPageSource, /Evidence|Handoff/);
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
  assert.match(guideSource, /projectsApi\.updateProject\(selectedProject\.id/);
  assert.match(guideSource, /firstDeliveryApi\.startProjectLoop\(project\.id\)/);
  assert.doesNotMatch(guideSource, /settingsSection|Settings2/);
  assert.doesNotMatch(projectsApiSource, /startProjectLoop|stopProjectLoop/);
  assert.match(firstDeliveryApiSource, /startProjectLoop: \(id\) => request\(`\/api\/projects\/\$\{id\}\/loop\/start`/);
});

test('onboarding Supervisor keeps only compatible API families and PI Codex OAuth at the first level', () => {
  assert.match(connectorSource, /OPENAI-COMPATIBLE API/);
  assert.match(connectorSource, /ANTHROPIC-COMPATIBLE API/);
  assert.match(connectorSource, /Codex \/ ChatGPT OAuth/);
  assert.match(connectorSource, /openai-responses/);
  assert.match(connectorSource, /openai-completions/);
  assert.doesNotMatch(connectorSource, /GOOGLE GEMINI|GEMINI API/);
  assert.match(connectorSource, /不会读取或回显 Codex CLI token/);
});

test('Supervisor connection mutations invalidate stale successful tests before save', () => {
  assert.match(supervisorStateSource, /connectionAttemptRef = useRef\(0\)/);
  assert.match(supervisorStateSource, /if \(!isCurrent\(\)\) return null/);
  assert.match(supervisorStateSource, /if \(CONNECTION_FIELDS\.has\(key\)\) \{\s*invalidateConnectionTest\(\)/);
  assert.match(supervisorStateSource, /await refreshAfterSave\(setProviders, setForm\);\s*return true/);
});
