import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FIRST_DELIVERY_TITLE,
  firstDeliveryRecovery,
  firstDeliveryState,
  preselectedCodeAgentID,
  RUNTIME_REPAIR_COMMAND,
  sampleWorkPayload,
} from './firstDeliveryGuideModel.js';

const readyDoctor = {
  db: { ok: true },
  providers: [{ available: true, id: 'codex', label: 'Codex' }],
  service: { alive: true },
};
const readyCodeAgents = [{ enabled: true, id: 'codex', submittable: true }];

test('three steps merge tool and assistant readiness and only insert failed runtime checks', () => {
  const waiting = firstDeliveryState({ doctor: readyDoctor });
  assert.equal(waiting.currentStep, 0);
  assert.deepEqual(waiting.steps.map(step => step.label), ['准备 AI', '选项目文件夹', '开始第一个任务']);
  assert.deepEqual(waiting.steps.map(step => step.complete), [false, false, false]);
  assert.match(firstDeliveryRecovery(waiting), /编程工具/);
  const selectedAgent = firstDeliveryState({ codeAgents: readyCodeAgents, doctor: readyDoctor, selectedCodeAgentID: 'codex' });
  assert.equal(selectedAgent.currentStep, 0);
  assert.equal(selectedAgent.selectedCodeAgent.id, 'codex');
  assert.match(firstDeliveryRecovery(selectedAgent), /玄武助手/);
  const state = firstDeliveryState({ codeAgents: readyCodeAgents, connectionTest: { ok: true }, doctor: readyDoctor, selectedCodeAgentID: 'codex' });
  assert.equal(state.currentStep, 1);
  assert.deepEqual(state.steps.map(step => step.complete), [true, false, false]);
  assert.match(firstDeliveryRecovery(state), /绝对路径/);
  const failed = firstDeliveryState({ doctor: { service: { alive: true }, db: { ok: false } } });
  assert.equal(failed.steps.length, 4);
  assert.equal(failed.steps[0].id, 'runtime');
  assert.equal(firstDeliveryState().steps.length, 3);
  assert.doesNotMatch(firstDeliveryRecovery(failed), /xuanwu doctor|API|DB|Dashboard/);
  assert.match(RUNTIME_REPAIR_COMMAND, /xuanwu doctor/);
});

test('preselection prefers a ready project provider, then Codex, then the first ready tool without mutation', () => {
  const agents = [{ id: 'claude', enabled: true, submittable: true }, ...readyCodeAgents, { id: 'disabled', enabled: false, submittable: true }];
  const before = JSON.stringify(agents);
  assert.equal(preselectedCodeAgentID(agents, { provider: 'claude' }), 'claude');
  assert.equal(preselectedCodeAgentID(agents, { provider: 'missing' }), 'codex');
  assert.equal(preselectedCodeAgentID(agents.slice(0, 1), null), 'claude');
  assert.equal(preselectedCodeAgentID(agents, null, 'claude'), 'claude');
  assert.equal(preselectedCodeAgentID([agents[2]], null), '');
  assert.equal(JSON.stringify(agents), before);
});

test('project confirmation precedes starting a task, and starting alone does not complete setup', () => {
  const input = { doctor: readyDoctor, codeAgents: readyCodeAgents, selectedCodeAgentID: 'codex', connectionTest: { ok: true }, projects: [{ id: 'demo' }] };
  assert.equal(firstDeliveryState(input).currentStep, 1);
  assert.equal(firstDeliveryState({ ...input, projectConfirmed: true }).currentStep, 2);
  const started = firstDeliveryState({ ...input, works: [{ id: 'first', status: 'in_progress' }] });
  assert.equal(started.currentStep, 2);
  assert.equal(started.completed, false);
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
  assert.deepEqual(state.steps.map(step => step.complete), [true, true, true]);

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
  assert.match(first.goal, /第一条通过的验证结果/);
  assert.match(first.goal, /后续验证结果/);
});

test('recovery keeps a failed or partially delivered Work on its existing authority', () => {
  const failed = firstDeliveryState({
    codeAgents: readyCodeAgents, connectionTest: { ok: true }, doctor: readyDoctor, projects: [{ id: 'demo' }],
    selectedCodeAgentID: 'codex',
    works: [{ id: 'xw:work:issues:4', status: 'failed', title: FIRST_DELIVERY_TITLE }],
  });
  assert.match(firstDeliveryRecovery(failed, readyDoctor), /重试/);
  assert.match(firstDeliveryRecovery(failed, readyDoctor), /不要新建重复任务/);

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
