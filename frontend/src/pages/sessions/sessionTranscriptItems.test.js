import assert from 'node:assert/strict';
import test from 'node:test';

import { isRenderableToolItem, parseLiveSessionEvents, shouldRenderLiveTurn, toolDisplayForItem } from './sessionTranscriptItems.js';

test('empty reasoning items are not rendered as blank transcript rows', () => {
  assert.equal(isRenderableToolItem({ type: 'reasoning', summary: [] }), false);
});

test('reasoning summary text remains visible when provided', () => {
  const item = { type: 'reasoning', summary: [{ text: '先检查 SSE 渲染链路。' }] };

  assert.equal(isRenderableToolItem(item), true);
  assert.deepEqual(toolDisplayForItem(item), {
    kind: 'reasoning',
    title: 'Reasoning',
    body: '先检查 SSE 渲染链路。',
  });
});

test('function call transcript items expose arguments instead of an empty type label', () => {
  const item = { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"go test ./backend/..."}' };

  assert.equal(isRenderableToolItem(item), true);
  const display = toolDisplayForItem(item);
  assert.equal(display.kind, 'generic');
  assert.equal(display.title, '调用工具：exec_command');
  assert.match(display.body, /"cmd": "go test \.\/backend\/\.\.\."/);
});

test('tool output transcript items expose output text', () => {
  const item = { type: 'function_call_output', output: 'Output:\nPASS\n' };

  assert.equal(isRenderableToolItem(item), true);
  assert.deepEqual(toolDisplayForItem(item), {
    kind: 'generic',
    title: '工具输出',
    body: 'Output:\nPASS\n',
  });
});

test('live stream parser keeps generic completed items from SSE payload', () => {
  const parsed = parseLiveSessionEvents([
    {
      method: 'item/completed',
      payload: JSON.stringify({ item: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"pwd"}' } }),
    },
  ]);

  assert.equal(parsed.tools.length, 1);
  assert.equal(toolDisplayForItem(parsed.tools[0]).title, '调用工具：exec_command');
});

test('live stream parser ignores empty reasoning events instead of showing blank rows', () => {
  const parsed = parseLiveSessionEvents([
    {
      method: 'item/started',
      payload: JSON.stringify({ item: { type: 'reasoning', summary: [] } }),
    },
  ]);

  assert.deepEqual(parsed.tools, []);
});

test('live stream parser keeps unhandled SSE item payloads visible', () => {
  const parsed = parseLiveSessionEvents([
    { method: 'item/unknownProgress', text: 'halfway', payload: '{"step":1}' },
  ]);

  assert.equal(parsed.tools.length, 1);
  const display = toolDisplayForItem(parsed.tools[0]);
  assert.equal(display.title, 'item/unknownProgress');
  assert.equal(display.body, 'halfway');
});

test('live stream parser keeps SSE errors visible', () => {
  const parsed = parseLiveSessionEvents([
    { method: 'error', error: 'boom' },
  ]);

  assert.equal(parsed.tools.length, 1);
  const display = toolDisplayForItem(parsed.tools[0]);
  assert.equal(display.title, 'error');
  assert.equal(display.body, 'boom');
});

test('turn start renders a live thinking placeholder before assistant text', () => {
  const parsed = parseLiveSessionEvents([{ method: 'turn/started', status: 'inProgress' }]);

  assert.equal(parsed.activity, 'thinking');
  assert.equal(parsed.agentMessageText, '');
  assert.equal(parsed.tools.length, 0);
  assert.equal(shouldRenderLiveTurn([{ method: 'turn/started' }], true), true);
});

test('live stream parser keeps command output delta readable without started item', () => {
  const parsed = parseLiveSessionEvents([
    { method: 'item/commandExecution/outputDelta', text: 'PASS\n' },
  ]);

  assert.equal(parsed.activity, 'command');
  assert.equal(parsed.tools.length, 1);
  assert.equal(parsed.tools[0].type, 'commandExecution');
  assert.equal(parsed.tools[0].text, 'PASS\n');
});

test('live stream parser keeps reasoning deltas readable', () => {
  const parsed = parseLiveSessionEvents([
    { method: 'item/reasoning/summaryDelta', payload: '{"delta":"检查运行态。"}' },
  ]);

  assert.equal(parsed.reasoningText, '检查运行态。');
});

test('live stream parser exposes pending approval events', () => {
  const parsed = parseLiveSessionEvents([
    {
      method: 'approval/requested',
      payload: JSON.stringify({
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'npm test', cwd: '/tmp/demo' },
      }),
    },
  ]);

  assert.equal(parsed.activity, 'approval');
  assert.equal(parsed.approvalPending, true);
  assert.equal(parsed.tools.length, 1);
  assert.equal(toolDisplayForItem(parsed.tools[0]).title, '等待审批');
  assert.match(toolDisplayForItem(parsed.tools[0]).body, /npm test/);
  assert.equal(shouldRenderLiveTurn([{ method: 'approval/requested' }], false), true);
});


test('live stream parser suppresses assistant draft already persisted in transcript', () => {
  const persistedTurns = [
    { items: [{ type: 'agentMessage', text: '同一段 Agent 回复\n已经落库。' }] },
  ];
  const parsed = parseLiveSessionEvents([
    { method: 'item/commandExecution/outputDelta', text: 'npm test\n' },
    { method: 'item/agentMessage/delta', text: '同一段 Agent 回复\n' },
    { method: 'item/agentMessage/delta', text: '已经落库。' },
  ], persistedTurns);

  assert.equal(parsed.agentMessageText, '');
  assert.equal(parsed.agentMessageDeduped, true);
  assert.equal(parsed.tools.length, 1);
  assert.equal(parsed.tools[0].type, 'commandExecution');
});

test('live stream parser keeps distinct assistant draft while persisted transcript exists', () => {
  const persistedTurns = [
    { items: [{ type: 'agentMessage', text: '上一条回复' }] },
  ];
  const parsed = parseLiveSessionEvents([
    { method: 'item/agentMessage/delta', text: '新的流式回复' },
  ], persistedTurns);

  assert.equal(parsed.agentMessageText, '新的流式回复');
});

test('live transcript is rendered while running and closes after normal completion', () => {
  const liveEvents = [{ method: 'item/agentMessage/delta', text: 'final response' }];

  assert.equal(shouldRenderLiveTurn(liveEvents, true), true);
  assert.equal(shouldRenderLiveTurn(liveEvents, false), false);
  assert.equal(shouldRenderLiveTurn([], true), true);
});
