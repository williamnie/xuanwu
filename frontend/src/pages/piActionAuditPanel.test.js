import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panelSource = readFileSync(new URL('./PiActionAuditPanel.jsx', import.meta.url), 'utf8');
const chatSource = readFileSync(new URL('./PiChat.jsx', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../api/piActionGateClient.js', import.meta.url), 'utf8');

test('PI chat keeps action approvals out of the runner chat sidebar', () => {
  assert.doesNotMatch(chatSource, /import PiActionAuditPanel from '\.\/PiActionAuditPanel'/);
  assert.doesNotMatch(chatSource, /<PiActionAuditPanel \/>/);
  assert.match(panelSource, /piActionGateApi\.pendingActions\(\)/);
  assert.match(panelSource, /piActionGateApi\.auditEvents\(\)/);
  assert.match(panelSource, /审计时间线/);
});

test('PI action gate client supports approval decisions without native confirm', () => {
  assert.match(clientSource, /\/api\/pi\/actions\/\$\{encodeURIComponent\(id\)\}\/approve/);
  assert.match(clientSource, /\/api\/pi\/actions\/\$\{encodeURIComponent\(id\)\}\/request-changes/);
  assert.match(clientSource, /\/api\/pi\/actions\/\$\{encodeURIComponent\(id\)\}\/snooze/);
  assert.match(clientSource, /\/api\/pi\/audit-events/);
  assert.doesNotMatch(panelSource, /window\.confirm/);
});

test('PI approvals show rationale, risk, scope, snooze time, and inline action errors', () => {
  for (const label of ['执行原因', '影响范围', '暂缓到', '处理说明']) {
    assert.match(panelSource, new RegExp(label));
  }
  assert.match(panelSource, /action\.risk_level/);
  assert.match(panelSource, /actionScopeItems\(action\)/);
  assert.match(panelSource, /type="datetime-local"/);
  assert.match(panelSource, /isoFromLocalInput\(snoozeTime\)/);
  assert.match(panelSource, /setActionErrors/);
  assert.match(panelSource, /role="alert"/);
});

test('PI approvals use Chinese primary decision actions', () => {
  for (const copy of ['待确认动作', '项待处理', '批准', '要求修改', '暂缓', '拒绝']) {
    assert.match(panelSource, new RegExp(copy));
  }
  for (const oldCopy of ["'Approvals'", "'Action Gate'", 'label="Approve"', 'label="Changes"', 'label="Snooze"', 'label="Reject"']) {
    assert.doesNotMatch(panelSource, new RegExp(oldCopy));
  }
});
