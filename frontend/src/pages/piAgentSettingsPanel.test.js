import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panelSource = readFileSync(new URL('./PiAgentSettingsPanel.jsx', import.meta.url), 'utf8');
const stateSource = readFileSync(new URL('./piAgentSettingsState.js', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../api/client.js', import.meta.url), 'utf8');

test('PI Agent Settings exposes runtime prompt summary debug without secret echo', () => {
  assert.match(panelSource, /当前生效 Prompt 摘要/);
  assert.match(panelSource, /不回显 API key\/token/);
  assert.match(panelSource, /Custom instructions:/);
  assert.match(panelSource, /state\.loadPromptSummary/);
  assert.match(stateSource, /loadPiPromptSummary/);
  assert.match(clientSource, /getPiAgentRuntimePrompt:/);
  assert.match(clientSource, /\/api\/pi\/agents\/\$\{encodeURIComponent\(id\)\}\/runtime-prompt/);
  assert.doesNotMatch(panelSource, /window\.confirm|window\.alert/);
});

test('PI Agent Settings exposes OpenAI Codex OAuth and user agent controls', () => {
  assert.match(panelSource, /Codex OAuth/);
  assert.match(panelSource, /openai-codex-responses/);
  assert.match(panelSource, /startPiCodexOAuthLogin/);
  assert.match(panelSource, /User-Agent/);
  assert.match(stateSource, /getPiCodexOAuthStatus/);
  assert.match(stateSource, /startPiCodexOAuthLogin/);
  assert.match(stateSource, /logoutPiCodexOAuth/);
  assert.match(clientSource, /getPiCodexOAuthStatus:/);
  assert.match(clientSource, /\/api\/pi\/oauth\/openai-codex\/status/);
  assert.match(clientSource, /\/api\/pi\/oauth\/openai-codex\/login/);
});
