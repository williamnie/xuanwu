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
const readyCodeAgents = [{ enabled: true, id: 'codex', submittable: true }];

test('clean state requires an explicit ready Code Agent selection before Supervisor setup', () => {
  const waiting = firstDeliveryState({ doctor: readyDoctor });
  assert.equal(waiting.currentStep, 1);
  assert.deepEqual(waiting.steps.map(step => step.complete), [true, false, false, false, false, false]);
  assert.match(firstDeliveryRecovery(waiting, readyDoctor), /Code Agent/);

  const supervisorWaiting = firstDeliveryState({ codeAgents: readyCodeAgents, doctor: readyDoctor });
  assert.equal(supervisorWaiting.currentStep, 1);
  assert.match(firstDeliveryRecovery(supervisorWaiting, readyDoctor), /Code Agent/);

  const selectedAgent = firstDeliveryState({ codeAgents: readyCodeAgents, doctor: readyDoctor, selectedCodeAgentID: 'codex' });
  assert.equal(selectedAgent.currentStep, 2);
  assert.equal(selectedAgent.selectedCodeAgent.id, 'codex');
  assert.match(firstDeliveryRecovery(selectedAgent, readyDoctor), /Supervisor/);

  const state = firstDeliveryState({ codeAgents: readyCodeAgents, connectionTest: { ok: true }, doctor: readyDoctor, selectedCodeAgentID: 'codex' });
  assert.equal(state.currentStep, 3);
  assert.deepEqual(state.steps.map(step => step.complete), [true, true, true, false, false, false]);
  assert.match(firstDeliveryRecovery(state, readyDoctor), /绝对路径/);
});

test('success requires done Work plus passed Evidence and Handoff for the same Work', () => {
  const work = { id: 'xw:work:issues:1', status: 'done', title: FIRST_DELIVERY_TITLE };
  const state = firstDeliveryState({
    codeAgents: readyCodeAgents,
    doctor: readyDoctor,
    connectionTest: { ok: true },
    evidence: [{ id: 'e1', status: 'passed', work_id: work.id }],
    handoffs: [{ status: 'ready', evidence_ids: ['e1'], evidence_count: 1, id: 'xw:handoff:derived:1', work_id: work.id }],
    projects: [{ id: 'demo' }],
    works: [work],
  });
  assert.equal(state.completed, true);
  assert.deepEqual(state.steps.map(step => step.complete), [true, true, true, true, true, true]);

  const wrongWork = firstDeliveryState({
    codeAgents: readyCodeAgents,
    doctor: readyDoctor,
    connectionTest: { ok: true },
    evidence: [{ id: 'e1', status: 'passed', work_id: work.id }],
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
  assert.ok(first.goal.indexOf("printf 'Hello Xuanwu\\n'") < first.goal.indexOf('README'));
  assert.match(first.goal, /第一条 passed Evidence/);
  assert.match(first.goal, /Evidence/);
  assert.equal(onboardingProjectID('/tmp/My Demo/'), 'my-demo');
});

test('recovery keeps a failed or partially delivered Work on its existing authority', () => {
  const failed = firstDeliveryState({
    codeAgents: readyCodeAgents, connectionTest: { ok: true }, doctor: readyDoctor, projects: [{ id: 'demo' }],
    selectedCodeAgentID: 'codex',
    works: [{ id: 'xw:work:issues:4', status: 'failed', title: FIRST_DELIVERY_TITLE }],
  });
  assert.match(firstDeliveryRecovery(failed, readyDoctor), /Retry/);
  assert.match(firstDeliveryRecovery(failed, readyDoctor), /不要新建重复 Work/);

  const evidenceOnly = firstDeliveryState({
    codeAgents: readyCodeAgents, connectionTest: { ok: true }, doctor: readyDoctor,
    evidence: [{ status: 'passed', work_id: 'xw:work:issues:5' }],
    projects: [{ id: 'demo' }],
    selectedCodeAgentID: 'codex',
    works: [{ id: 'xw:work:issues:5', status: 'done', title: FIRST_DELIVERY_TITLE }],
  });
  assert.match(firstDeliveryRecovery(evidenceOnly, readyDoctor), /完成交付检查/);
  assert.match(firstDeliveryRecovery(evidenceOnly, readyDoctor), /让玄武协助/);
});

test('draft or unrelated passed Evidence cannot complete onboarding', () => {
  const work = { id: 'xw:work:issues:1', status: 'done', title: FIRST_DELIVERY_TITLE };
  const input = { works: [work], targetWorkID: work.id, evidence: [{ id: 'passed', work_id: work.id, status: 'passed' }],
    handoffs: [{ status: 'ready', work_id: work.id, evidence_ids: ['another'], evidence_count: 1 }] };
  assert.equal(firstDeliveryState(input).completed, false);
  input.handoffs[0].evidence_ids = ['passed'];
  input.handoffs[0].status = 'draft';
  assert.equal(firstDeliveryState(input).completed, false);
  input.handoffs[0].status = 'ready';
  assert.equal(firstDeliveryState(input).completed, true);
  input.targetWorkID = 'xw:work:issues:2';
  assert.equal(firstDeliveryState(input).completed, false);
});
