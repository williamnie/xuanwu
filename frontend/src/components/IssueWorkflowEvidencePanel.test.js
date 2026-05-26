import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import IssueWorkflowEvidencePanel, { workflowCopyText } from './IssueWorkflowEvidencePanel.js';

test('renders compact workflow evidence and latest run actions', () => {
  const workflow = {
    nextAction: '补充测试/验证摘要，避免只凭 done 状态验收。',
    explicitFinalStatus: 'done',
    verificationEvidence: { summary: '未找到 verification evidence' },
    latestRun: {
      attempt: 2,
      status: 'done',
      providerLabel: 'Codex',
      sessionRef: 'codex:thread-abc',
      sessionId: 'thread-abc',
      turnId: 'turn-xyz',
      exitText: 'explicit_status_update',
    },
    steps: [
      { id: 'intake', label: 'Intake', state: 'done', evidence: 'raw description' },
      { id: 'verify', label: 'Verify', state: 'warning', evidence: '未找到 verification evidence' },
    ],
  };

  const html = renderToStaticMarkup(React.createElement(IssueWorkflowEvidencePanel, { workflow, navigateTo: () => {} }));

  assert.match(html, /Workflow \/ Evidence/);
  assert.match(html, /needs evidence/);
  assert.match(html, /未找到 verification evidence/);
  assert.match(html, /Attempt #2 · done/);
  assert.match(html, /codex:thread-abc/);
  assert.match(html, /打开 Session/);
  assert.match(html, /复制 Evidence/);
});

test('workflow copy text associates final status with verification and latest run', () => {
  const text = workflowCopyText({
    nextAction: '补充测试摘要',
    explicitFinalStatus: 'done',
    verificationEvidence: { summary: '未找到 verification evidence' },
    latestRun: { attempt: 1, status: 'done', sessionRef: 'codex:s1', turnId: 't1' },
    steps: [{ label: 'Close', state: 'warning', evidence: 'Explicit final status: done' }],
  });

  assert.match(text, /Final status: done/);
  assert.match(text, /Verification: 未找到 verification evidence/);
  assert.match(text, /Latest run: attempt #1 done/);
  assert.match(text, /Next: 补充测试摘要/);
});
