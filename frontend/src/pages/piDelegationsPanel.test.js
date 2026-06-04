import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panelSource = readFileSync(new URL('./PiDelegationsPanel.jsx', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('./PiCommandCenter.css', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../api/client.js', import.meta.url), 'utf8');

test('Delegations panel supports list, create, pause, resume, and refresh', () => {
  assert.match(panelSource, /api\.getPiDelegations\(\)/);
  assert.match(panelSource, /api\.createPiDelegation\(buildCreatePayload\(form\)\)/);
  assert.match(panelSource, /api\.pausePiDelegation\(delegation\.id\)/);
  assert.match(panelSource, /api\.resumePiDelegation\(delegation\.id\)/);
  assert.match(panelSource, /await load\(\)/);
  assert.match(panelSource, /onChanged\?\.\(\)/);
  assert.match(clientSource, /getPiDelegations:/);
  assert.match(clientSource, /pausePiDelegation:/);
  assert.match(clientSource, /resumePiDelegation:/);
});

test('Delegations form captures issue ids, time window, and allowed actions with inline errors', () => {
  for (const label of ['Issue IDs', 'Starts', 'Expires', 'Allowed actions']) {
    assert.match(panelSource, new RegExp(label));
  }
  assert.match(panelSource, /parseIssueIds\(form\.issueIds\)/);
  assert.match(panelSource, /allowed_actions: allowedActions/);
  assert.match(panelSource, /expires_at: expiresAt/);
  assert.match(panelSource, /error=\{state\.formError\}/);
  assert.match(panelSource, /<InlineError>\{error\}<\/InlineError>/);
  assert.match(cssSource, /\.pi-delegations-error/);
  assert.doesNotMatch(panelSource, /window\.confirm|window\.alert/);
});
