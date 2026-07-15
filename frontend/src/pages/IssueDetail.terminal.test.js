import assert from 'node:assert/strict';
import test from 'node:test';
import {
  issueLogAgentPayload,
  issueStatusFromEvent,
  mergeIssueLogEvents,
} from './issue-detail/issueDetailEventAdapters.js';

test('terminal issue logs prefer raw method mapping over generic persisted type', () => {
  const agent = issueLogAgentPayload({
    type: 'text',
    raw_method: 'item/agentMessage/delta',
    text: '我',
  });

  assert.equal(agent.type, 'agent.message.delta');
});

test('issue detail reads status_changed status from SSE payload JSON', () => {
  const status = issueStatusFromEvent({
    issueId: 7,
    payload: '{"status":"done"}',
    type: 'issue.status_changed',
  });

  assert.equal(status, 'done');
});

test('adjacent log deltas are merged without crossing event kinds', () => {
  const events = [
    { id: 1, type: 'issue.log', payload: { agent_event_type: 'agent.message.delta', text: '你' } },
    { id: 2, type: 'issue.log', payload: { agent_event_type: 'agent.message.delta', text: '好' } },
    { id: 3, type: 'issue.log', payload: { agent_event_type: 'agent.command.output_delta', text: 'ok' } },
  ];

  const merged = mergeIssueLogEvents(events);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]._textMerged, '你好');
  assert.equal(merged[1]._textMerged, 'ok');
});
