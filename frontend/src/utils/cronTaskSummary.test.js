import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCronRunSummary } from './cronTaskSummary.js';

test('summarizes successful cron run result', () => {
  const summary = buildCronRunSummary({
    last_run_at: '2026-05-26T04:00:00Z',
    next_run_at: '2026-05-27T04:00:00Z',
    last_status: 'success',
    last_result: '已转入 Todo: #82',
  });

  assert.equal(summary.lastRunAt, '2026-05-26T04:00:00Z');
  assert.equal(summary.nextRunAt, '2026-05-27T04:00:00Z');
  assert.equal(summary.statusLabel, 'Success');
  assert.equal(summary.badgeClass, 'done');
  assert.equal(summary.result, '已转入 Todo: #82');
});

test('falls back to existing error as last failure', () => {
  const summary = buildCronRunSummary({
    last_run_at: '2026-05-26T04:00:00Z',
    error: 'runner unavailable because the transport returned a long error',
  });

  assert.equal(summary.statusLabel, 'Failed');
  assert.equal(summary.badgeClass, 'failed');
  assert.match(summary.error, /runner unavailable/);
});

test('summarizes explicit cron error status', () => {
  const summary = buildCronRunSummary({
    error: 'cycle boom',
    last_result: 'cycle boom',
    last_run_at: '2026-05-26T04:00:00Z',
    last_status: 'error',
  });

  assert.equal(summary.statusLabel, 'Error');
  assert.equal(summary.badgeClass, 'failed');
  assert.equal(summary.result, 'cycle boom');
  assert.equal(summary.error, 'cycle boom');
});
