import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SessionTranscript from './SessionTranscript.jsx';

const transcriptSource = readFileSync(new URL('./SessionTranscript.jsx', import.meta.url), 'utf8');

test('persisted turns render task input cards before provider execution blocks', () => {
  assert.match(transcriptSource, /<UserMessageBubble[\s\S]*timestamp=\{turnTimestamp\(turn, session, 'user'\)\}/);
  assert.match(transcriptSource, /<ProviderExecutionBlock[\s\S]*provider=\{provider\}/);
  assert.match(transcriptSource, /avatar="IN" role="任务输入"/);
  assert.match(transcriptSource, /role=\{providerIdentity\(provider, model\)\}/);
});

test('provider execution history is concise and starts collapsed', () => {
  assert.match(transcriptSource, /useState\(false\)/);
  assert.match(transcriptSource, /执行过程 · \$\{actionCount\} 个动作/);
  assert.match(transcriptSource, /aria-expanded=\{canExpand \? isOpen : undefined\}/);
});

function renderLiveTranscript(liveEvents, overrides = {}) {
  return renderToStaticMarkup(React.createElement(SessionTranscript, {
    session: { id: 'codex:live-1', provider: 'codex', turns: [] },
    liveEvents,
    optimisticUserMessages: [],
    running: true,
    sending: false,
    pendingApproval: null,
    navigateTo() {},
    ...overrides,
  }));
}

const commandStarted = {
  method: 'item/started',
  payload: JSON.stringify({ item: { id: 'command-1', type: 'commandExecution', command: 'bun test', status: 'inProgress' } }),
};

test('live tool execution and assistant streaming share one collapsed status row', () => {
  const markup = renderLiveTranscript([
    commandStarted,
    { method: 'item/commandExecution/outputDelta', text: 'private tool output' },
    { method: 'turn/diff/updated', payload: '{"diff":"raw patch"}' },
    { method: 'item/agentMessage/delta', text: '回复正文保持可见。' },
  ]);

  assert.equal((markup.match(/session-execution-summary/g) || []).length, 1);
  assert.equal((markup.match(/spin-animation/g) || []).length, 1);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, /正在输出回复/);
  assert.match(markup, /执行详情/);
  assert.match(markup, /回复正文保持可见。/);
  assert.doesNotMatch(markup, /tools-details-content|private tool output|turn\/diff\/updated|raw patch/);
  assert.doesNotMatch(markup, /Streaming\.\.\.|live-activity-banner|thinking-placeholder|typing-dots/);
});

test('thinking and text-only streaming retain a single non-expandable status row', () => {
  for (const [events, label] of [
    [[], '正在思考'],
    [[{ method: 'item/agentMessage/delta', text: '正文' }], '正在输出回复'],
  ]) {
    const markup = renderLiveTranscript(events);
    assert.match(markup, new RegExp(label));
    assert.equal((markup.match(/spin-animation/g) || []).length, 1);
    assert.doesNotMatch(markup, /aria-expanded|执行详情|thinking-placeholder|streaming-badge/);
  }
});

test('command-only execution has one loading indicator without a thinking placeholder', () => {
  const markup = renderLiveTranscript([commandStarted]);
  assert.match(markup, /正在运行命令/);
  assert.equal((markup.match(/spin-animation/g) || []).length, 1);
  assert.doesNotMatch(markup, /正在思考|bun test|tools-details-content/);
});

test('errors and approvals remain visible outside collapsed details with no loading animation', () => {
  for (const [event, label, tone] of [
    [{ method: 'error', error: 'command failed' }, '运行出错：command failed', 'error'],
    [{ method: 'approval/requested', payload: '{}' }, '已暂停，等待审批', 'approval'],
  ]) {
    const markup = renderLiveTranscript([commandStarted, event], { running: false });
    assert.match(markup, new RegExp(label));
    assert.match(markup, new RegExp(`data-tone="${tone}"`));
    assert.match(markup, /aria-expanded="false"/);
    assert.doesNotMatch(markup, /spin-animation|tools-details-content/);
  }
});

test('completed turns show a quiet collapsed action count and keep the final reply visible', () => {
  const markup = renderLiveTranscript([commandStarted], {
    running: false,
    session: { id: 'codex:live-1', provider: 'codex', turns: [{
      id: 'turn-1',
      items: [
        { type: 'commandExecution', command: 'bun test', text: 'PASS', status: 'completed' },
        { type: 'agentMessage', text: '已完成验证。' },
      ],
    }] },
  });
  assert.match(markup, /执行过程 · 1 个动作/);
  assert.match(markup, /已完成验证。/);
  assert.match(markup, /aria-expanded="false"/);
  assert.doesNotMatch(markup, /spin-animation|tools-details-content|PASS|active-live/);
});

test('message time formatting accepts API epoch seconds and optimistic ISO timestamps', () => {
  assert.match(transcriptSource, /numeric < 1_000_000_000_000 \? numeric \* 1000 : numeric/);
  assert.match(transcriptSource, /timestamp=\{formatTranscriptTime\(message\.createdAt\)\}/);
  assert.match(transcriptSource, /second: '2-digit'/);
});

test('Qoder Run transcript renders the design order with real provider identity', () => {
  const markup = renderToStaticMarkup(React.createElement(SessionTranscript, {
    session: {
      id: 'qoder:session-1',
      provider: 'qoder',
      provider_session_id: 'session-1',
      model: 'lite',
      createdAt: 1786670231,
      updatedAt: 1786670234,
      turns: [{
        id: 'turn-1',
        items: [
          { id: 'user-1', type: 'userMessage', content: [{ type: 'input_text', text: 'hi，你是什么模型' }] },
          { id: 'reasoning-1', type: 'reasoning', content: [{ type: 'text', text: '检查上下文。' }] },
          { id: 'agent-1', type: 'agentMessage', text: '我是 Qoder，一个 AI 编程助手。' },
        ],
      }],
    },
    project: { name: 'codex-issue-runner' },
    liveEvents: [],
    optimisticUserMessages: [],
    running: false,
    sending: false,
    pendingApproval: null,
    navigateTo() {},
  }));

  const inputIndex = markup.indexOf('任务输入');
  const providerIndex = markup.indexOf('qoder · lite');
  const toolIndex = markup.indexOf('执行过程 · 1 个动作');
  const answerIndex = markup.indexOf('我是 Qoder，一个 AI 编程助手。');

  assert.ok(inputIndex >= 0);
  assert.ok(providerIndex > inputIndex);
  assert.ok(toolIndex > providerIndex);
  assert.ok(answerIndex > toolIndex);
  assert.match(markup, /session-message-avatar">IN</);
  assert.match(markup, /session-message-avatar">QD</);
  assert.match(markup, /<time class="session-message-time">\d{2}:\d{2}:\d{2}<\/time>/);
});

test('persisted provider history keeps commentary visible and folds only opaque MCP events', () => {
  const markup = renderToStaticMarkup(React.createElement(SessionTranscript, {
    session: {
      id: 'codex:session-2',
      provider: 'codex',
      provider_session_id: 'session-2',
      model: 'gpt-5.6-sol',
      turns: [{
        id: 'turn-1',
        items: [
          { id: 'user-1', type: 'userMessage', content: [{ type: 'input_text', text: '修复页面' }] },
          { id: 'progress-1', type: 'agentMessage', text: '我先检查当前实现。' },
          { id: 'mcp-1', type: 'mcpToolCall', input: { server: 'chrome', tool: 'playwright' } },
          { id: 'mcp-2', type: 'mcpToolCall', input: { server: 'chrome', tool: 'screenshot' } },
          { id: 'final-1', type: 'agentMessage', text: '页面已经修复并完成验证。' },
        ],
      }],
    },
    project: { name: 'codex-issue-runner' },
    liveEvents: [],
    optimisticUserMessages: [],
    running: false,
    sending: false,
    pendingApproval: null,
    navigateTo() {},
  }));

  assert.match(markup, /执行过程 · 2 个动作/);
  assert.match(markup, /我先检查当前实现。/);
  assert.match(markup, /页面已经修复并完成验证。/);
  assert.doesNotMatch(markup, /mcpToolCall|\[object Object\]/);
  assert.ok(markup.indexOf('我先检查当前实现。') < markup.indexOf('页面已经修复并完成验证。'));
});
