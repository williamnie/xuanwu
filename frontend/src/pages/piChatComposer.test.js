import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPiChatProjectSuggestions, buildPiChatReferenceDetails } from './piChatComposer.js';

test('PI chat project suggestions insert natural @project tokens and attach project reference', () => {
  const suggestions = buildPiChatProjectSuggestions([
    { id: 'xuanwu', name: 'xuanwu', cwd: '/repo/runner' },
  ]);
  assert.equal(suggestions[0].label, '@xuanwu');
  assert.equal(suggestions[0].insertText, '@xuanwu');
  assert.deepEqual(suggestions[0].reference, {
    type: 'project', id: 'xuanwu', label: 'xuanwu', metadata: { cwd: '/repo/runner' },
  });
});

test('PI chat project reference details mark selected project ready', () => {
  const details = buildPiChatReferenceDetails(
    [{ type: 'project', id: 'xuanwu', label: 'xuanwu' }],
    [{ id: 'xuanwu', name: 'Runner', cwd: '/repo/runner' }],
  );
  assert.equal(details[0].key, 'project:xuanwu');
  assert.equal(details[0].status, 'ready');
  assert.equal(details[0].message, '');
  assert.match(details[0].summary, /Runner/);
});
