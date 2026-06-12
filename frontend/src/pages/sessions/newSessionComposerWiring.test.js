import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sessionsSource = readFileSync(new URL('../Sessions.jsx', import.meta.url), 'utf8');

test('new session composer uses PromptEditor suggestions instead of plain textarea', () => {
  const block = newSessionBlock(sessionsSource);

  assert.match(block, /<PromptEditor[\s\S]*value=\{prompt\}[\s\S]*onChange=\{setPrompt\}[\s\S]*suggestions=\{sessionComposerSuggestions\}/);
  assert.doesNotMatch(block, /<textarea[\s\S]*new-session-textarea/);
});

test('new chat shortcut clears parent selected session route before opening composer', () => {
  const block = newChatShortcutBlock(sessionsSource);

  assert.match(sessionsSource, /ignorePropSelectionRef = useRef\(false\)/);
  assert.match(sessionsSource, /autoSelectFirstSessionRef = useRef\(true\)/);
  assert.match(block, /ignorePropSelectionRef\.current = true/);
  assert.match(block, /autoSelectFirstSessionRef\.current = false/);
  assert.match(block, /navigateTo\?\.\('sessions'\)/);
  assert.match(block, /setSelectedId\(''\)/);
  assert.match(block, /setActiveView\('new'\)/);
});

function newSessionBlock(source) {
  const start = source.indexOf('new-session-container');
  const end = source.indexOf('new-session-bottom-tags', start);
  assert.notEqual(start, -1, 'new session container should exist');
  assert.notEqual(end, -1, 'new session bottom tags should exist');
  return source.slice(start, end);
}

function newChatShortcutBlock(source) {
  const start = source.indexOf("activeView === 'new' ? 'active' : ''");
  const end = source.indexOf('<span>新对话</span>', start);
  assert.notEqual(start, -1, 'new chat shortcut should exist');
  assert.notEqual(end, -1, 'new chat label should exist');
  return source.slice(start, end);
}


test('new and existing session payloads include service tier', () => {
  assert.match(sessionsSource, /service_tier:\s*settings\.serviceTier/);
  assert.match(sessionsSource, /service_tier:\s*sessionSettings\.serviceTier/);
  assert.match(sessionsSource, /onServiceTierChange=\{\(value\) => handleSettingChange\('serviceTier', value\)\}/);
});

test('new session permission control labels every authorization preset explicitly', () => {
  assert.match(sessionsSource, /function permissionPresetLabel/);
  assert.match(sessionsSource, /permissionPresetLabel\(settings\)/);
  assert.match(sessionsSource, /case 'workspace-write\\|always':\s*return '每次授权'/);
  assert.doesNotMatch(sessionsSource, /settings\.approvalPolicy === 'never' \? '完全访问权限' : '工作区写入'/);
});


test('approval event parsing accepts object payloads and fallback approval ids', () => {
  assert.match(sessionsSource, /function approvalPayloadObject/);
  assert.match(sessionsSource, /payload && typeof payload === 'object'/);
  assert.match(sessionsSource, /request\.params\?\.approvalId \|\| request\.params\?\.itemId \|\| request\.params\?\.callId/);
});


test('approval dialog can surface pending create-session approvals before a session is selected', () => {
  assert.match(sessionsSource, /visibleApprovalsForSession\(approvalQueue, selectedId\)/);
  assert.match(sessionsSource, /function visibleApprovalsForSession/);
  assert.match(sessionsSource, /if \(selected\.length > 0 \|\| selectedId\) return selected/);
});
