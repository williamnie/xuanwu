import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildRunControlPayload } from '../runs/runPageModel.js';
import {
  activeWorkCanPause,
  activeWorkHasActiveRun,
  activeWorkCanStop,
  activeWorkView,
  buildActiveWorkActionPayload,
} from './activeWorkModel.js';

const NOW = new Date('2026-07-17T08:00:00Z');

test('Active Work covers queued, running, verification, and recovery phases', () => {
  assert.equal(activeWorkView(work({ status: 'todo' }), null, NOW).phase, 'queued');
  assert.equal(activeWorkView(work({
    latest_run: run({ phase: 'running', status: 'running' }),
    status: 'in_progress',
  }), null, NOW).phase, 'running');
  assert.equal(activeWorkView(work({ status: 'pending_verification' }), null, NOW).phase, 'verifying');
  assert.equal(activeWorkView(work({
    latest_run: run({ phase: 'recovering', status: 'recovering' }),
    status: 'in_progress',
  }), null, NOW).phase, 'recovering');
});

test('stalled progress and authoritative duration stay visible', () => {
  const item = work({
    latest_run: run({
      progress: {
        latest: { occurred_at: '2026-07-17T07:40:00Z', summary: 'Running focused tests' },
        stalled: { detected: true, reason: 'no_progress_for_threshold' },
        updated_at: '2026-07-17T07:40:00Z',
      },
    }),
    status: 'in_progress',
  });
  const view = activeWorkView(item, { started_at: '2026-07-17T06:30:00Z' }, NOW);
  assert.equal(view.duration, '1 小时 30 分');
  assert.equal(view.progressText, 'Running focused tests');
  assert.equal(view.stalled, true);
  assert.equal(view.stalledLabel, '进展停滞');
});

test('pause uses controllable Run detail while stop uses audited Work revision', () => {
  const item = work({ latest_run: run(), revision: 7, status: 'in_progress' });
  const detail = {
    attempts: [{
      agent_session_key: 'codex:thread-1',
      provider_ref: { provider: 'codex', session_ref: 'thread-1', turn_ref: 'turn-1' },
      revision: 3,
      status: 'running',
    }],
    status: 'running',
  };
  assert.equal(activeWorkHasActiveRun(item), true);
  assert.equal(activeWorkHasActiveRun(work({ latest_run: run({ status: 'succeeded' }) })), false);
  assert.equal(activeWorkCanPause(item, detail), true);
  assert.equal(activeWorkCanPause(item, { ...detail, attempts: [] }), false);
  assert.equal(activeWorkCanStop(item), true);
  assert.equal(activeWorkCanStop(work({ status: 'done' })), false);
  assert.deepEqual(buildActiveWorkActionPayload(item, 'cancel', {
    nonce: '1',
    occurredAt: '2026-07-17T08:00:00Z',
  }), {
    audit: {
      actor: { id: 'frontend:user', kind: 'user' },
      correlation_id: 'command-center:xw:work:issues:696',
      event_id: 'command-center:cancel:1',
      occurred_at: '2026-07-17T08:00:00Z',
      reason: 'Command Center Active Work requested cancel',
    },
    expected_revision: 7,
  });
  assert.deepEqual(buildRunControlPayload({ ...detail, id: item.latest_run.id, revision: 5 }, 'interrupt', {
    correlationPrefix: 'command-center',
    eventId: 'command-center:pause:1',
    occurredAt: '2026-07-17T08:00:00Z',
    reasonPrefix: 'Command Center Active Work',
  }), {
    audit: {
      actor: { id: 'frontend:user', kind: 'user' },
      correlation_id: 'command-center:xw:run:issue_runs:run-696',
      event_id: 'command-center:pause:1',
      occurred_at: '2026-07-17T08:00:00Z',
      reason: 'Command Center Active Work requested interrupt',
    },
    expected_attempt_revision: 3,
    expected_revision: 5,
  });
});

test('Command Center reads aggregate facts and writes only through Work and Run controls', () => {
  const apiSource = readFileSync(new URL('../../api/commandCenter.js', import.meta.url), 'utf8');
  const clientSource = readFileSync(new URL('../../api/work.js', import.meta.url), 'utf8');
  const pageSource = readFileSync(new URL('./ActiveWorkSection.jsx', import.meta.url), 'utf8');
  assert.match(apiSource, /\/api\/command-center\/summary/);
  assert.match(pageSource, /sections: \['active_work'\]/);
  assert.match(pageSource, /runsApi\.getRun/);
  assert.match(pageSource, /runsApi\.controlRun/);
  assert.match(pageSource, /freshness\?\.is_stale/);
  assert.match(pageSource, /item\.readiness\?\.current_stage/);
  assert.match(pageSource, /item\.readiness\?\.missing_evidence/);
  assert.match(clientSource, /\/api\/works\/\$\{encodeURIComponent\(id\)\}\/actions\/\$\{action\}/);
  assert.doesNotMatch(pageSource, /updateIssue|cancelIssue|interruptSession/);
});

function work(overrides = {}) {
  return {
    id: 'xw:work:issues:696',
    revision: 0,
    status: 'todo',
    updated_at: '2026-07-17T07:00:00Z',
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    id: 'xw:run:issue_runs:run-696',
    phase: 'running',
    progress: { latest: null, stalled: { detected: false }, updated_at: '2026-07-17T07:59:00Z' },
    status: 'running',
    ...overrides,
  };
}
