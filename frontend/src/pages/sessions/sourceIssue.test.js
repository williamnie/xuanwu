import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSessionIssuePayload, textFromUserContent } from './sourceIssue.js';

const project = { id: 'demo', name: 'Demo', cwd: '/repo/demo' };

function demoSession(overrides = {}) {
  return {
    id: 'codex:thread-1',
    provider: 'codex',
    provider_session_id: 'thread-1',
    name: '修复 Settings 页面',
    cwd: '/repo/demo',
    preview: '讨论预览',
    turns: [
      {
        id: 'turn-user-1',
        items: [
          { type: 'userMessage', content: [{ type: 'input_text', text: '最近用户上下文：诊断按钮没有反馈。' }] },
        ],
      },
    ],
    ...overrides,
  };
}

test('builds a triage issue payload from selected session text', () => {
  const payload = buildSessionIssuePayload(demoSession(), project, {
    selectedText: '选中文本：修复 Settings 诊断按钮',
  });

  assert.equal(payload.status, 'triage');
  assert.equal(payload.project_id, 'demo');
  assert.equal(payload.source_session_id, 'thread-1');
  assert.equal(payload.source_turn_id, 'turn-user-1');
  assert.equal(payload.source_excerpt, '选中文本：修复 Settings 诊断按钮');
  assert.match(payload.title, /选中文本：修复 Settings 诊断按钮/);
  assert.match(payload.description, /Session ID: codex:thread-1/);
  assert.match(payload.description, /Thread ID: thread-1/);
  assert.match(payload.description, /Title: 修复 Settings 页面/);
  assert.match(payload.description, /## 选中文本/);
  assert.match(payload.description, /选中文本：修复 Settings 诊断按钮/);
});

test('uses the latest user turn as recent context when no text is selected', () => {
  const payload = buildSessionIssuePayload(demoSession(), project);

  assert.equal(payload.status, 'triage');
  assert.equal(payload.source_turn_id, 'turn-user-1');
  assert.equal(payload.source_excerpt, '最近用户上下文：诊断按钮没有反馈。');
  assert.match(payload.description, /## 最近上下文摘要/);
  assert.match(payload.description, /最近用户上下文：诊断按钮没有反馈。/);
});

test('hides Codex attachment envelope from displayed user text', () => {
  const imagePath = '/var/folders/d5/p8s9_bt93jqgdgy9pd0_vg940000gn/T/codex-clipboard-8fb83bb2-1ec5-4ee6-abf1-d4d193173e9c.png';
  const text = [
    'Files mentioned by the user:',
    '',
    'codex-clipboard-8fb83bb2-1ec5-4ee6-abf1-d4d193173e9c.png:',
    imagePath,
    '',
    'My request for Codex:',
    '',
    '这种是不是也要优化下，跟整体的风格不相符了',
  ].join('\n');

  assert.equal(
    textFromUserContent([{ type: 'input_text', text }, { type: 'localImage', path: imagePath }]),
    `这种是不是也要优化下，跟整体的风格不相符了\n\n![uploaded image](${imagePath})`,
  );
});
