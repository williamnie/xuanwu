import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveIssueExecutionSummary } from './issueExecutionSummary.js';

test('uses only structured verifier evidence instead of guessing from log text', () => {
  const summary = deriveIssueExecutionSummary({
    issue: { status: 'done' },
    events: [{ type: 'issue.log', payload: JSON.stringify({ text: 'bun test passed' }) }],
    runs: [{ attempt: 1, status: 'done' }],
  });

  assert.equal(summary.verification.state, 'attention');
  assert.equal(summary.verification.label, '未记录结构化验证');
});

test('surfaces verifier report and terminal run mismatch', () => {
  const summary = deriveIssueExecutionSummary({
    issue: { status: 'done' },
    events: [{
      type: 'issue.verification_report',
      payload: JSON.stringify({ recommendation: 'accept', summary: 'Focused checks passed' }),
    }],
    runs: [{ attempt: 2, status: 'failed', started_at: '2026-01-02T00:00:00Z' }],
  });

  assert.equal(summary.statusConflict, true);
  assert.deepEqual(summary.verification, {
    state: 'recorded',
    label: 'Verifier: accept',
    detail: 'Focused checks passed',
    source: 'verifier_report',
  });
  assert.match(summary.nextAction, /终态不一致/);
});

test('flags a terminal issue whose latest run is still marked in progress', () => {
  const summary = deriveIssueExecutionSummary({
    issue: { status: 'done' },
    runs: [{ attempt: 3, status: 'in_progress', ended_at: '' }],
  });

  assert.equal(summary.statusConflict, true);
  assert.match(summary.nextAction, /终态不一致/);
});

test('reads verification evidence from a structured workflow snapshot', () => {
  const summary = deriveIssueExecutionSummary({
    issue: {
      status: 'in_progress',
      workflow_snapshot_json: JSON.stringify({
        steps: [{ id: 'verify', status: 'done', evidence_summary: 'npm test passed' }],
      }),
    },
  });

  assert.equal(summary.verification.state, 'recorded');
  assert.equal(summary.verification.source, 'workflow_snapshot');
});
