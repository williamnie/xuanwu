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

test('provider tool groups expose count and latest action and start expanded', () => {
  assert.match(transcriptSource, /useState\(true\)/);
  assert.match(transcriptSource, /\$\{normalizedTools\.length\} 个工具调用 · 最近/);
  assert.match(transcriptSource, /toolSummaryLabel\(latestTool\)/);
  assert.match(transcriptSource, /<SlidersHorizontal/);
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
  const toolIndex = markup.indexOf('1 个工具调用 · 最近 Reasoning');
  const answerIndex = markup.indexOf('我是 Qoder，一个 AI 编程助手。');

  assert.ok(inputIndex >= 0);
  assert.ok(providerIndex > inputIndex);
  assert.ok(toolIndex > providerIndex);
  assert.ok(answerIndex > toolIndex);
  assert.match(markup, /session-message-avatar">IN</);
  assert.match(markup, /session-message-avatar">QD</);
  assert.match(markup, /<time class="session-message-time">\d{2}:\d{2}:\d{2}<\/time>/);
});
