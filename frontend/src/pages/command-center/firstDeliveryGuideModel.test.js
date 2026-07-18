import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FIRST_DELIVERY_TITLE,
  firstDeliveryRecovery,
  firstDeliveryState,
  onboardingProjectID,
  sampleWorkPayload,
} from './firstDeliveryGuideModel.js';

const readyDoctor = {
  db: { ok: true },
  providers: [{ available: true, id: 'codex', label: 'Codex' }],
  service: { alive: true },
};

test('clean state starts at project setup after runtime and Agent pass', () => {
  const waiting = firstDeliveryState({ doctor: readyDoctor });
  assert.equal(waiting.currentStep, 1);
  assert.deepEqual(waiting.steps.map(step => step.complete), [true, false, false, false, false]);
  assert.match(firstDeliveryRecovery(waiting, readyDoctor), /连接测试/);

  const state = firstDeliveryState({ connectionTest: { ok: true }, doctor: readyDoctor });
  assert.equal(state.currentStep, 2);
  assert.deepEqual(state.steps.map(step => step.complete), [true, true, false, false, false]);
  assert.match(firstDeliveryRecovery(state, readyDoctor), /绝对路径/);
});

test('success requires done Work plus passed Evidence and Handoff for the same Work', () => {
  const work = { id: 'xw:work:issues:1', status: 'done', title: FIRST_DELIVERY_TITLE };
  const state = firstDeliveryState({
    doctor: readyDoctor,
    connectionTest: { ok: true },
    evidence: [{ status: 'passed', work_id: work.id }],
    handoffs: [{ evidence_count: 1, id: 'xw:handoff:derived:1', work_id: work.id }],
    projects: [{ id: 'demo' }],
    works: [work],
  });
  assert.equal(state.completed, true);
  assert.deepEqual(state.steps.map(step => step.complete), [true, true, true, true, true]);

  const wrongWork = firstDeliveryState({
    doctor: readyDoctor,
    connectionTest: { ok: true },
    evidence: [{ status: 'passed', work_id: work.id }],
    handoffs: [{ evidence_count: 1, work_id: 'xw:work:issues:2' }],
    projects: [{ id: 'demo' }],
    works: [work],
  });
  assert.equal(wrongWork.completed, false);
});

test('sample mutation is uniquely audited and strictly read-only', () => {
  const first = sampleWorkPayload('demo', '2026-07-18T00:00:00Z', 'request-1');
  const second = sampleWorkPayload('demo', '2026-07-18T00:01:00Z', 'request-2');
  assert.notEqual(first.audit.event_id, second.audit.event_id);
  assert.equal(first.status, 'todo');
  assert.match(first.goal, /不修改文件/);
  assert.match(first.goal, /Evidence/);
  assert.equal(onboardingProjectID('/tmp/My Demo/'), 'my-demo');
});

test('recovery keeps a failed or partially delivered Work on its existing authority', () => {
  const failed = firstDeliveryState({
    connectionTest: { ok: true }, doctor: readyDoctor, projects: [{ id: 'demo' }],
    works: [{ id: 'xw:work:issues:4', status: 'failed', title: FIRST_DELIVERY_TITLE }],
  });
  assert.match(firstDeliveryRecovery(failed, readyDoctor), /Retry/);
  assert.match(firstDeliveryRecovery(failed, readyDoctor), /不要新建重复 Work/);

  const evidenceOnly = firstDeliveryState({
    connectionTest: { ok: true }, doctor: readyDoctor,
    evidence: [{ status: 'passed', work_id: 'xw:work:issues:5' }],
    projects: [{ id: 'demo' }],
    works: [{ id: 'xw:work:issues:5', status: 'done', title: FIRST_DELIVERY_TITLE }],
  });
  assert.match(firstDeliveryRecovery(evidenceOnly, readyDoctor), /已附带 Work 上下文/);
  assert.match(firstDeliveryRecovery(evidenceOnly, readyDoctor), /Action Gate/);
});
