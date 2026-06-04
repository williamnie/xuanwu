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

test('PI Command Center renders P11 status cards with loading and error states', () => {
  for (const label of ['Mode', 'Heartbeat', 'Delegation', 'Pending approvals']) {
    assert.match(pageSource, new RegExp(label));
  }
  assert.match(pageSource, /import PiDelegationsPanel from '\.\/PiDelegationsPanel'/);
  assert.match(pageSource, /import PiActionAuditPanel from '\.\/PiActionAuditPanel'/);
  assert.match(pageSource, /import PiHeartbeatTimelinePanel from '\.\/PiHeartbeatTimelinePanel'/);
  assert.match(pageSource, /<PiHeartbeatTimelinePanel \/>/);
  assert.match(pageSource, /<PiActionAuditPanel onChanged=\{state\.reload\} variant="command-center" \/>/);
  assert.match(pageSource, /<PiDelegationsPanel onChanged=\{state\.reload\} \/>/);
  assert.match(pageSource, /pi-command-loading/);
  assert.match(pageSource, /pi-command-error/);
  assert.match(pageSource, /api\.getPiCommandCenter\(\)/);
});

test('PI Command Center keeps non-P11.02 framework placeholders read-only', () => {
  assert.doesNotMatch(pageSource, /api\.getCodexUsage/);
  assert.doesNotMatch(pageSource, /pauseProjectPiAutonomousMode|resumeProjectPiAutonomousMode/);
  assert.match(clientSource, /getPiCommandCenter: \(\) => request\('\/api\/pi\/command-center'\)/);
  assert.doesNotMatch(pageSource, /window\.confirm|window\.alert/);
});
