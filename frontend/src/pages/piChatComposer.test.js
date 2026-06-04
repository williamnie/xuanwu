import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPiChatProjectSuggestions, buildPiChatReferenceDetails } from './piChatComposer.js';

test('PI chat project suggestions insert natural @project tokens and attach project reference', () => {
  const suggestions = buildPiChatProjectSuggestions([
    { id: 'codex-issue-runner', name: 'codex-issue-runner', cwd: '/repo/runner' },
  ]);
  assert.equal(suggestions[0].label, '@codex-issue-runner');
  assert.equal(suggestions[0].insertText, '@codex-issue-runner');
  assert.deepEqual(suggestions[0].reference, {
    type: 'project', id: 'codex-issue-runner', label: 'codex-issue-runner', metadata: { cwd: '/repo/runner' },
  });
});

test('PI chat project reference details mark selected project ready', () => {
  const details = buildPiChatReferenceDetails(
    [{ type: 'project', id: 'codex-issue-runner', label: 'codex-issue-runner' }],
    [{ id: 'codex-issue-runner', name: 'Runner', cwd: '/repo/runner' }],
  );
  assert.equal(details[0].key, 'project:codex-issue-runner');
  assert.equal(details[0].status, 'ready');
  assert.match(details[0].summary, /Runner/);
});
