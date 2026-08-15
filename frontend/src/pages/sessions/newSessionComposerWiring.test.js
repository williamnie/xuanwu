import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sessionsSource = readFileSync(new URL('../Sessions.jsx', import.meta.url), 'utf8');
const newSessionSource = readFileSync(new URL('./NewSessionWorkspace.jsx', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('./SessionSidebar.jsx', import.meta.url), 'utf8');
const runtimeSource = readFileSync(new URL('./sessionPageRuntime.js', import.meta.url), 'utf8');

test('new session composer uses PromptEditor suggestions instead of plain textarea', () => {
  const block = newSessionBlock(newSessionSource);

  assert.match(block, /<PromptEditor[\s\S]*value=\{prompt\}[\s\S]*onChange=\{setPrompt\}[\s\S]*suggestions=\{sessionComposerSuggestions\}/);
  assert.doesNotMatch(block, /<textarea[\s\S]*new-session-textarea/);
});

test('new chat shortcut clears parent selected session route before opening composer', () => {
  assert.match(sessionsSource, /ignorePropSelectionRef = useRef\(false\)/);
  assert.match(sessionsSource, /autoSelectFirstSession = true/);
  assert.match(sessionsSource, /autoSelectFirstSessionRef = useRef\(autoSelectFirstSession\)/);
  assert.match(sessionsSource, /const openNewSession = useCallback[\s\S]*ignorePropSelectionRef\.current = true/);
  assert.match(sessionsSource, /const openNewSession = useCallback[\s\S]*autoSelectFirstSessionRef\.current = false/);
  assert.match(sessionsSource, /const openNewSession = useCallback[\s\S]*navigateTo\?\.\('sessions'\)/);
  assert.match(sessionsSource, /const openNewSession = useCallback[\s\S]*setSelectedId\(''\)/);
  assert.match(sessionsSource, /const openNewSession = useCallback[\s\S]*setActiveView\('new'\)/);
  assert.match(sidebarSource, /className=\{`sidebar-shortcut-item[\s\S]*onClick=\{onNewSession\}/);
});

function newSessionBlock(source) {
  const start = source.indexOf('new-session-container');
  const end = source.indexOf('new-session-bottom-tags', start);
  assert.notEqual(start, -1, 'new session container should exist');
  assert.notEqual(end, -1, 'new session bottom tags should exist');
  return source.slice(start, end);
}

test('new and existing session payloads include service tier', () => {
  assert.match(sessionsSource, /service_tier:\s*settings\.serviceTier/);
  assert.match(sessionsSource, /service_tier:\s*sessionSettings\.serviceTier/);
  assert.match(newSessionSource, /onServiceTierChange=\{\(value\) => handleSettingChange\('serviceTier', value\)\}/);
});

test('new session model field only exposes the selected Code Agent model choices', () => {
  assert.match(sessionsSource, /modelsError,[\s\S]*modelsLoading,[\s\S]*projectId/);
  assert.match(newSessionSource, /availableProviderModels\(models\)/);
  assert.match(newSessionSource, /availableProviderModelValue\(settings\.model, modelOptions\)/);
  assert.match(newSessionSource, /<select aria-label="模型" disabled=\{modelsLoading\}/);
  assert.doesNotMatch(newSessionSource, /手动填写模型 ID|<datalist/);
  assert.match(sessionsSource, /model:\s*availableProviderModelValue\(sessionSettings\.model, models\)/);
  assert.match(sessionsSource, /modelRequestRef\.current !== requestId/);
  assert.match(sessionsSource, /setModels\(\[\]\)/);
  assert.match(sessionsSource, /PROVIDER_MODELS_TIMEOUT_MS/);
  assert.match(sessionsSource, /getProviderModels\(provider, \{ signal: controller\.signal \}\)/);
});

test('new session provider selector hides unavailable providers', () => {
  assert.match(newSessionSource, /selectedProviderAvailable/);
  assert.match(newSessionSource, /选择可用 Provider/);
  assert.doesNotMatch(newSessionSource, /（未就绪）/);
});

test('new session permission control is catalog-driven and preserves legacy projection', () => {
  assert.match(newSessionSource, /executionPolicyPresets\(providerCatalog, settings\.provider, policy\)/);
  assert.match(newSessionSource, /applyExecutionPolicy\(settings, policyFromValue\(event\.target\.value\)\)/);
  assert.match(newSessionSource, /onSettingChange\('executionPolicy', next\.executionPolicy\)/);
  assert.match(newSessionSource, /isolationLabel\(providerCatalog, sessionSettings\.provider\)/);
  assert.doesNotMatch(newSessionSource, /function permissionPresetLabel/);
});

test('approval event parsing accepts object payloads and fallback approval ids', () => {
  assert.match(runtimeSource, /function approvalPayloadObject/);
  assert.match(runtimeSource, /payload && typeof payload === 'object'/);
  assert.match(runtimeSource, /request\.params\?\.approvalId \|\| request\.params\?\.itemId \|\| request\.params\?\.callId/);
});

test('approval dialog can surface pending create-session approvals before a session is selected', () => {
  assert.match(sessionsSource, /visibleApprovalsForSession\(approvalQueue, selectedId\)/);
  assert.match(runtimeSource, /function visibleApprovalsForSession/);
  assert.match(runtimeSource, /if \(selected\.length > 0 \|\| selectedId\) return selected/);
});
