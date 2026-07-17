import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RUN_EVENT_SCAN_LIMIT,
  approvalsForAttempt,
  eventPageCursor,
  eventsWithinAttempt,
  mergeRunEventPages,
  runAttemptProviderSessionRef,
  runCostView,
  runEventInitialBeforeId,
  runLogSummary,
  selectedRunAttempt,
} from './runDetailModel.js';

test('Codex and Claude Attempts resolve provider observations without changing Run identity', () => {
  const run = fixtureRun();
  assert.equal(runAttemptProviderSessionRef(run.attempts[0], run), 'codex:thread-codex');
  assert.equal(runAttemptProviderSessionRef(run.attempts[1], run), 'claude:session-claude');
  assert.equal(selectedRunAttempt(run, run.attempts[0].id)?.kind, 'initial');
  assert.equal(selectedRunAttempt(run, 'missing')?.kind, 'recovery');
});

test('failed and recovery Attempt windows keep logs and approvals scoped to the selected turn', () => {
  const run = fixtureRun();
  const recovery = run.attempts[1];
  const events = [
    event(100, '2026-07-17T00:00:05Z', 'initial failed'),
    event(101, '2026-07-17T00:01:05Z', 'recovery started'),
    event(102, '2026-07-17T00:02:05Z', 'later run'),
  ];
  assert.deepEqual(eventsWithinAttempt(events, recovery, run).map(item => item.id), [101]);
  assert.equal(runEventInitialBeforeId(run, recovery), '102');
  assert.deepEqual(approvalsForAttempt([
    approval('approval-initial', 'turn-codex', '2026-07-17T00:00:06Z'),
    approval('approval-recovery', 'turn-claude', '2026-07-17T00:01:06Z'),
  ], recovery).map(item => item.approval_id), ['approval-recovery']);
});

test('long raw logs remain cursor-paged, deduplicated, ordered, and capped', () => {
  const first = Array.from({ length: 400 }, (_, index) => event(index + 201, '2026-07-17T00:00:05Z', `line ${index}`));
  const earlier = Array.from({ length: 200 }, (_, index) => event(index + 1, '2026-07-17T00:00:04Z', `earlier ${index}`));
  const merged = mergeRunEventPages(first, earlier);
  assert.equal(merged.length, RUN_EVENT_SCAN_LIMIT);
  assert.equal(merged[0].id, 101);
  assert.equal(merged.at(-1).id, 600);
  assert.equal(eventPageCursor(earlier), '1');
});

test('log summaries prefer readable payload fields and never render unbounded lines', () => {
  const summary = runLogSummary(event(1, '2026-07-17T00:00:00Z', 'x'.repeat(600)), 40);
  assert.equal(summary.length, 40);
  assert.match(summary, /…$/);
  assert.equal(runLogSummary({ id: 2, type: 'run.lifecycle.intent.v1', payload: '{}' }), 'run.lifecycle.intent.v1');
});

test('cost presentation preserves unavailable money and provider-neutral token totals', () => {
  assert.deepEqual(runCostView({
    money: { amount_micros: null, basis: 'unavailable', currency: '' },
    usage: {
      cached_input_tokens: 1234,
      completeness: 'complete',
      input_tokens: 2000,
      output_tokens: 300,
      reasoning_output_tokens: 20,
      total_tokens: 2300,
    },
  }), {
    cachedInput: '1,234',
    completeness: 'complete',
    input: '2,000',
    money: 'Unavailable',
    output: '300',
    reasoning: '20',
    total: '2,300',
  });
});

function fixtureRun() {
  return {
    ended_at: '2026-07-17T00:02:00Z',
    id: 'xw:run:issue_runs:issue-701-attempt-1',
    progress: {
      phase_summary: [
        { attempt_id: 'attempt-1', last_event_id: 100 },
        { attempt_id: 'attempt-2', last_event_id: 101 },
      ],
      source_event_range: { last_id: 101 },
    },
    provider: 'codex',
    started_at: '2026-07-17T00:00:00Z',
    attempts: [
      {
        ended_at: '2026-07-17T00:01:00Z',
        id: 'attempt-1',
        kind: 'initial',
        provider_ref: { observation_ref: 'codex:thread-codex', provider: 'codex', session_ref: 'thread-codex', turn_ref: 'turn-codex' },
        started_at: '2026-07-17T00:00:00Z',
        status: 'failed',
      },
      {
        ended_at: '2026-07-17T00:02:00Z',
        id: 'attempt-2',
        kind: 'recovery',
        provider_ref: { provider: 'claude', session_ref: 'session-claude', turn_ref: 'turn-claude' },
        started_at: '2026-07-17T00:01:01Z',
        status: 'succeeded',
      },
    ],
  };
}

function event(id, createdAt, text) {
  return { created_at: createdAt, id, payload: JSON.stringify({ text }), type: 'issue.log' };
}

function approval(id, turnId, createdAt) {
  return {
    approval_id: id,
    created_at: createdAt,
    session_id: turnId === 'turn-codex' ? 'thread-codex' : 'session-claude',
    turn_id: turnId,
  };
}
