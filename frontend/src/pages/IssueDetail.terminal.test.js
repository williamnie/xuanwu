import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('./IssueDetail.jsx', import.meta.url), 'utf8');

function runIssueLogAgentPayload(payload) {
  const start = source.indexOf('function legacyAgentEventType');
  const end = source.indexOf('\nasync function readOptional', start);
  assert.notEqual(start, -1, 'missing legacyAgentEventType');
  assert.notEqual(end, -1, 'missing readOptional boundary');
  const context = { payload, result: null };
  vm.runInNewContext(`${source.slice(start, end)}\nresult = issueLogAgentPayload(payload);`, context);
  return context.result;
}

function runIssueStatusFromEvent(event) {
  const start = source.indexOf('function parseEventPayload');
  const end = source.indexOf('\nfunction legacyAgentEventType', start);
  assert.notEqual(start, -1, 'missing parseEventPayload');
  assert.notEqual(end, -1, 'missing legacyAgentEventType boundary');
  const context = { event, result: null };
  vm.runInNewContext(`${source.slice(start, end)}\nresult = issueStatusFromEvent(event);`, context);
  return context.result;
}

test('terminal issue logs prefer raw method mapping over generic persisted type', () => {
  const agent = runIssueLogAgentPayload({
    type: 'text',
    raw_method: 'item/agentMessage/delta',
    text: '我',
  });

  assert.equal(agent.type, 'agent.message.delta');
});

test('issue detail reads status_changed status from SSE payload JSON', () => {
  const status = runIssueStatusFromEvent({
    issueId: 7,
    payload: '{"status":"done"}',
    type: 'issue.status_changed',
  });

  assert.equal(status, 'done');
});
