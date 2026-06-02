import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panelSource = readFileSync(new URL('./PiActionAuditPanel.jsx', import.meta.url), 'utf8');
const chatSource = readFileSync(new URL('./PiChat.jsx', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../api/piActionGateClient.js', import.meta.url), 'utf8');

test('PI chat exposes action gate pending approvals and audit timeline', () => {
  assert.match(chatSource, /import PiActionAuditPanel from '\.\/PiActionAuditPanel'/);
  assert.match(chatSource, /<PiActionAuditPanel \/>/);
  assert.match(panelSource, /piActionGateApi\.pendingActions\(\)/);
  assert.match(panelSource, /piActionGateApi\.auditEvents\(\)/);
  assert.match(panelSource, /Audit timeline/);
});

test('PI action gate client supports approval decisions without native confirm', () => {
  assert.match(clientSource, /\/api\/pi\/actions\/\$\{encodeURIComponent\(id\)\}\/approve/);
  assert.match(clientSource, /\/api\/pi\/actions\/\$\{encodeURIComponent\(id\)\}\/request-changes/);
  assert.match(clientSource, /\/api\/pi\/actions\/\$\{encodeURIComponent\(id\)\}\/snooze/);
  assert.match(clientSource, /\/api\/pi\/audit-events/);
  assert.doesNotMatch(panelSource, /window\.confirm/);
});
