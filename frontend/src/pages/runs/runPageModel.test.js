import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRunControlPayload,
  mergeRunPages,
  resolveRunsPage,
  runAvailableActions,
  runIssueId,
  runProviderSessionRef,
} from './runPageModel.js';

test('Sessions remains a compatibility route into the canonical Runs page', () => {
  assert.equal(resolveRunsPage('sessions'), 'runs');
  assert.equal(resolveRunsPage('runs'), 'runs');
  assert.equal(resolveRunsPage('issues'), 'issues');
});

test('Run drill-down resolves the latest provider observation without exposing it as Run identity', () => {
  const run = fixtureRun({
    attempts: [
      attempt(1, 'codex', 'codex-thread-1', 'succeeded'),
      attempt(2, 'claude', 'claude-session-2', 'running', 'claude:claude-session-2'),
    ],
  });

  assert.equal(runProviderSessionRef(run), 'claude:claude-session-2');
  assert.equal(runIssueId(run), 662);
  assert.equal(runIssueId({ work_id: 'external:662' }), null);
});

test('Run pages merge by canonical Run id', () => {
  assert.deepEqual(mergeRunPages(
    [{ id: 'run-1', status: 'running' }],
    [{ id: 'run-1', status: 'succeeded' }, { id: 'run-2', status: 'running' }],
  ), [
    { id: 'run-1', status: 'succeeded' },
    { id: 'run-2', status: 'running' },
  ]);
});

test('legacy controls map to audited Run commands with fresh revisions', () => {
  const run = fixtureRun({ status: 'running', revision: 7, attempts: [attempt(1, 'codex', 'thread-1', 'running', '', 3)] });
  assert.deepEqual(runAvailableActions(run), { interrupt: true, resume: false, retry: false });
  assert.deepEqual(buildRunControlPayload(run, 'interrupt', {
    eventId: 'runs-ui:interrupt:1',
    occurredAt: '2026-07-16T08:00:00Z',
  }), {
    audit: {
      actor: { id: 'frontend:user', kind: 'user' },
      correlation_id: `runs-ui:${run.id}`,
      event_id: 'runs-ui:interrupt:1',
      occurred_at: '2026-07-16T08:00:00Z',
      reason: 'Runs compatibility view requested interrupt',
    },
    expected_attempt_revision: 3,
    expected_revision: 7,
  });

  const succeeded = fixtureRun({ status: 'succeeded' });
  assert.deepEqual(runAvailableActions(succeeded), { interrupt: false, resume: false, retry: true });
});

function fixtureRun(overrides = {}) {
  return {
    attempts: [attempt(1, 'codex', 'thread-1', 'succeeded')],
    id: 'xw:run:issue_runs:issue-662-attempt-1',
    provider: 'codex',
    revision: 0,
    status: 'succeeded',
    work_id: 'xw:work:issues:662',
    ...overrides,
  };
}

function attempt(sequence, provider, sessionRef, status, observationRef = '', revision = 0) {
  return {
    agent_session_key: observationRef,
    provider_ref: {
      provider,
      session_ref: sessionRef,
      ...(observationRef ? { observation_ref: observationRef } : {}),
    },
    revision,
    sequence,
    status,
  };
}
