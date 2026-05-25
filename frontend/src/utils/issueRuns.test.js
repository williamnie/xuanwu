import assert from 'node:assert/strict';
import test from 'node:test';

import {
  issueFailureReason,
  issueRunExitText,
  issueRunSessionId,
  issueRunSessionRef,
  issueRunTurnId,
  latestIssueRun,
  providerLabel,
  shortId,
} from './issueRuns.js';

test('latest issue run helpers prefer run runtime identity', () => {
  const issue = {
    latest_run: {
      provider: 'codex',
      provider_session_id: 'thread-run',
      provider_turn_id: 'turn-run',
    },
    codex_thread_id: 'thread-issue',
    codex_turn_id: 'turn-issue',
  };
  const run = latestIssueRun(issue);

  assert.equal(issueRunSessionId(issue, run), 'thread-run');
  assert.equal(issueRunTurnId(issue, run), 'turn-run');
  assert.equal(issueRunSessionRef(issue, run), 'codex:thread-run');
});

test('issue failure summary falls back through issue and run fields', () => {
  assert.equal(issueFailureReason({ error: 'issue boom' }, { error: 'run boom' }), 'issue boom');
  assert.equal(issueFailureReason({}, { error: 'run boom' }), 'run boom');
  assert.equal(issueFailureReason({}, { exit_reason: 'missing_explicit_update' }), 'missing_explicit_update');
  assert.equal(issueRunExitText({ error: 'run boom', exit_reason: 'failed' }), 'run boom');
});

test('provider labels and short ids stay compact', () => {
  assert.equal(providerLabel('codex'), 'Codex');
  assert.equal(providerLabel('custom'), 'custom');
  assert.equal(shortId('1234567890abcdef', 6, 4), '123456…cdef');
});
