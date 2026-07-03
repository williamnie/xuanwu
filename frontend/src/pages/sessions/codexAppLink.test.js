import assert from 'node:assert/strict';
import test from 'node:test';

import { codexAppThreadId, codexAppThreadUrl } from './codexAppLink.js';

test('builds Codex App deep link from provider session id', () => {
  const session = {
    id: 'codex:local-id',
    provider: 'codex',
    provider_session_id: '019f25a0-8cec-71c1-9212-fa287b6814f0',
  };

  assert.equal(codexAppThreadId(session), '019f25a0-8cec-71c1-9212-fa287b6814f0');
  assert.equal(codexAppThreadUrl(session), 'codex://threads/019f25a0-8cec-71c1-9212-fa287b6814f0');
});

test('falls back to provider-prefixed session id for Codex sessions', () => {
  assert.equal(
    codexAppThreadUrl({ provider: 'codex', id: 'codex:thread/id one' }),
    'codex://threads/thread%2Fid%20one',
  );
});

test('does not build Codex App links for non-Codex providers', () => {
  assert.equal(codexAppThreadId({ provider: 'claude', provider_session_id: 'thread-1' }), '');
  assert.equal(codexAppThreadUrl({ provider: 'claude', provider_session_id: 'thread-1' }), '');
});
