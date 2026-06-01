import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveIssueWorkflowEvidence } from './issueWorkflowEvidence.js';
import { serializeIssueRefinement } from './issueRefinement.js';

const readyDescription = serializeIssueRefinement('实现一个验收面板', {
  problem: '证据散落',
  acceptanceCriteria: '- Detail 显示 workflow evidence',
  verificationPlan: '- node --test frontend/src/utils/issueWorkflowEvidence.test.js',
});

test('derives raw triage workflow with missing verification evidence', () => {
  const workflow = deriveIssueWorkflowEvidence({
    issue: { id: 1, status: 'triage', description: '随手记录一个 raw issue', created_at: '2026-05-26T01:00:00Z' },
    events: [{ type: 'issue.created', created_at: '2026-05-26T01:00:00Z' }],
    runs: [],
  });

  assert.equal(workflow.latestRun, null);
  assert.equal(workflow.verificationEvidence.found, false);
  assert.deepEqual(workflow.steps.map(step => [step.id, step.state]), [
    ['intake', 'done'],
    ['refine', 'missing'],
    ['ready', 'missing'],
    ['implement', 'pending'],
    ['verify', 'missing'],
    ['close', 'pending'],
  ]);
  assert.match(workflow.nextAction, /补齐 Acceptance criteria/);
});

test('links ready issue to acceptance and verification plan evidence', () => {
  const workflow = deriveIssueWorkflowEvidence({
    issue: { id: 2, status: 'todo', description: readyDescription, created_at: '2026-05-26T02:00:00Z' },
    events: [],
    runs: [],
  });

  assert.equal(workflow.steps.find(step => step.id === 'refine').state, 'done');
  assert.equal(workflow.steps.find(step => step.id === 'ready').state, 'done');
  assert.match(workflow.steps.find(step => step.id === 'ready').evidence, /Acceptance criteria/);
  assert.match(workflow.nextAction, /等待 runner claim/);
});

test('uses persisted workflow snapshot when present', () => {
  const workflow = deriveIssueWorkflowEvidence({
    issue: {
      id: 6,
      status: 'pending_verification',
      description: 'legacy body',
      workflow_snapshot_json: JSON.stringify({
        version: 'v0',
        current_step_id: 'verify',
        steps: [
          {
            id: 'intake',
            label: 'Intake',
            status: 'done',
            updated_at: '2026-05-27T01:00:00Z',
            evidence_summary: 'created from API',
            actor: 'system',
          },
          {
            id: 'verify',
            label: 'Verify',
            status: 'active',
            updated_at: '2026-05-27T01:02:00Z',
            evidence_summary: 'bun test backend-ts/src/db/database.test.ts passed',
            actor: 'agent',
          },
        ],
      }),
    },
    runs: [{
      id: 'issue-6-attempt-1',
      attempt: 1,
      status: 'pending_verification',
      provider: 'codex',
      provider_session_id: 'thread-snapshot',
      provider_turn_id: 'turn-snapshot',
    }],
    events: [{ type: 'issue.log', payload: '{"text":"ignored derived verification"}' }],
  });

  assert.equal(workflow.source, 'snapshot');
  assert.equal(workflow.currentStepId, 'verify');
  assert.equal(workflow.latestRun.sessionRef, 'codex:thread-snapshot');
  assert.deepEqual(workflow.steps.map(step => [step.id, step.state]), [
    ['intake', 'done'],
    ['verify', 'active'],
  ]);
  assert.match(workflow.steps[1].evidence, /bun test/);
  assert.equal(workflow.verificationEvidence.found, true);
});

test('falls back to derived workflow when persisted snapshot is invalid', () => {
  const workflow = deriveIssueWorkflowEvidence({
    issue: {
      id: 7,
      status: 'todo',
      description: readyDescription,
      workflow_snapshot_json: '{"steps":"bad"}',
    },
    events: [],
    runs: [],
  });

  assert.equal(workflow.source, 'derived');
  assert.equal(workflow.steps.find(step => step.id === 'ready').state, 'done');
});

test('surfaces latest in-progress run identity as implementation evidence', () => {
  const workflow = deriveIssueWorkflowEvidence({
    issue: { id: 3, status: 'in_progress', description: readyDescription },
    runs: [{
      id: 'issue-3-attempt-2',
      attempt: 2,
      status: 'in_progress',
      provider: 'codex',
      provider_session_id: 'thread-live',
      provider_turn_id: 'turn-live',
    }],
  });

  assert.equal(workflow.latestRun.id, 'issue-3-attempt-2');
  assert.equal(workflow.latestRun.sessionRef, 'codex:thread-live');
  assert.equal(workflow.steps.find(step => step.id === 'implement').state, 'active');
  assert.match(workflow.steps.find(step => step.id === 'implement').evidence, /Attempt #2/);
});

test('does not treat done status as verified when verification evidence is absent', () => {
  const workflow = deriveIssueWorkflowEvidence({
    issue: { id: 4, status: 'done', description: readyDescription },
    events: [{ type: 'issue.status_changed', payload: '{"status":"done"}' }],
    runs: [{ id: 'issue-4-attempt-1', attempt: 1, status: 'done', exit_reason: 'explicit_status_update' }],
  });

  assert.equal(workflow.explicitFinalStatus, 'done');
  assert.equal(workflow.verificationEvidence.found, false);
  assert.equal(workflow.steps.find(step => step.id === 'verify').state, 'warning');
  assert.match(workflow.steps.find(step => step.id === 'verify').evidence, /未找到 verification evidence/);
});

test('extracts verification and failure evidence from events and run error', () => {
  const workflow = deriveIssueWorkflowEvidence({
    issue: { id: 5, status: 'failed', description: readyDescription, error: 'npm test failed with exit code 1' },
    events: [
      { type: 'issue.log', payload: '{"text":"验证结果：node --test 12 passed"}' },
      { type: 'issue.status_changed', payload: '{"status":"failed"}' },
    ],
    runs: [{ id: 'issue-5-attempt-1', attempt: 1, status: 'failed', error: 'long '.repeat(80) }],
  });

  assert.equal(workflow.explicitFinalStatus, 'failed');
  assert.equal(workflow.verificationEvidence.found, true);
  assert.match(workflow.verificationEvidence.summary, /验证结果/);
  assert.equal(workflow.steps.find(step => step.id === 'verify').state, 'blocked');
  assert.ok(workflow.steps.find(step => step.id === 'verify').evidence.length < 220);
  assert.equal(workflow.steps.find(step => step.id === 'close').state, 'blocked');
});
