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

test('terminal issue logs prefer raw method mapping over generic persisted type', () => {
  const agent = runIssueLogAgentPayload({
    type: 'text',
    raw_method: 'item/agentMessage/delta',
    text: '我',
  });

  assert.equal(agent.type, 'agent.message.delta');
});
