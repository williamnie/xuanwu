import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../components/AppSidebar.jsx', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../api/client.js', import.meta.url), 'utf8');
const pageUrl = new URL('./PiCommandCenter.jsx', import.meta.url);
const pageSource = existsSync(pageUrl) ? readFileSync(pageUrl, 'utf8') : '';

test('PI Command Center is available as a first-class routed page', () => {
  assert.ok(existsSync(pageUrl), 'PiCommandCenter.jsx should exist');
  assert.match(appSource, /import PiCommandCenter from '\.\/pages\/PiCommandCenter'/);
  assert.match(appSource, /currentPage === 'pi-command-center'/);
  assert.match(sidebarSource, /pi-command-center/);
  assert.match(sidebarSource, /Command Center/);
});

test('PI Command Center exposes required governance modules without native confirm', () => {
  for (const label of ['Delegations', 'Approvals', 'Heartbeat Timeline', 'Policy', 'Reports']) {
    assert.match(pageSource, new RegExp(label));
  }
  assert.match(clientSource, /getPiDelegations/);
  assert.match(clientSource, /pausePiDelegation/);
  assert.match(clientSource, /resumeProjectPiAutonomousMode/);
  assert.doesNotMatch(pageSource, /window\.confirm|window\.alert/);
});
