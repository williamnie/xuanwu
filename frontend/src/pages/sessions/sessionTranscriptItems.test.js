import assert from 'node:assert/strict';
import test from 'node:test';

import { isRenderableToolItem, parseLiveSessionEvents, toolDisplayForItem } from './sessionTranscriptItems.js';

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
