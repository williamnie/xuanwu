import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./piChatState.js', import.meta.url), 'utf8');

test('Runner chat loader keeps a stable callback without project selection dependencies', () => {
  assert.match(source, /function usePiChatLoader\(setters\)/);
  assert.doesNotMatch(source, /useCallback\([\s\S]*\], \[[^\]]*state[^\]]*\]\)/);
  assert.doesNotMatch(source, /selectedProjectId/);
  assert.doesNotMatch(source, /setSelectedProjectId/);
});

test('Runner chat sends session-style message settings with prompts', () => {
  assert.match(source, /defaultMessageSettings/);
  assert.match(source, /runnerMessageSettings\(state\.messageSettings\)/);
  assert.match(source, /approval_policy:\s*settings\.approvalPolicy/);
  assert.match(source, /reasoning_effort:\s*settings\.reasoningEffort/);
});


test('Runner chat uses a failure fallback instead of empty-text wording', () => {
  assert.match(source, /runnerReplyText\(result\)/);
  assert.match(source, /result\?\.status === 'failed'/);
  assert.match(source, /Runner 执行失败，未返回错误详情/);
});

test('Runner chat switches conversations by loading persisted transcript detail', () => {
  assert.match(source, /api\.getPiConversation\(id\)/);
  assert.match(source, /setTranscript\(conversationTranscript\(detail\)\)/);
  assert.match(source, /function conversationTranscript\(detail\)/);
});

test('Runner chat tracks selected conversation and updates title from message result', () => {
  assert.match(source, /const selectedConversation = useMemo/);
  assert.match(source, /selectedConversation,\s*selectedConversationId/);
  assert.match(source, /createConversation\('New conversation'/);
  assert.match(source, /applyConversationTitle\(state, conversationId, result\?\.title\)/);
  assert.doesNotMatch(source, /new Date\(\)\.toLocaleString/);
});
