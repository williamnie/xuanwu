import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveIssueExecutionSummary } from './issueExecutionSummary.js';

test('does not infer semantic completion from Provider log text', () => {
  const summary = deriveIssueExecutionSummary({
    issue: { status: 'in_progress' },
    runs: [{ attempt: 1, status: 'running' }],
  });

  assert.equal(summary.piDecision.state, 'missing');
  assert.equal(summary.piDecision.label, 'Provider 正在执行');
});

test('shows PI ownership after a Provider Turn ends', () => {
  const summary = deriveIssueExecutionSummary({
    issue: { status: 'in_progress' },
    runs: [{ attempt: 2, ended_at: '2026-01-02T00:01:00Z', status: 'failed' }],
  });

  assert.equal(summary.awaitingPi, true);
  assert.equal(summary.piDecision.label, '等待 PI 判断');
  assert.match(summary.nextAction, /PI 正在读取 Session/);
  assert.equal(summary.statusConflict, false);
});

test('flags a terminal issue whose latest Run is still open', () => {
  const summary = deriveIssueExecutionSummary({
    issue: { status: 'done' },
    runs: [{ attempt: 3, status: 'running', ended_at: '' }],
  });

  assert.equal(summary.statusConflict, true);
  assert.match(summary.nextAction, /最新 Run 仍未结束/);
});

test('renders explicit PI decision projection instead of workflow Evidence gates', () => {
  const summary = deriveIssueExecutionSummary({
    issue: {
      decision: { phase: 'pi_continuing', owner: 'pi' },
      status: 'in_progress',
    },
  });

  assert.equal(summary.piDecision.state, 'recorded');
  assert.equal(summary.piDecision.label, 'PI 已要求继续');
});
