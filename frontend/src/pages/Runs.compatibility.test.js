import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
const pageSource = readFileSync(new URL('./Runs.jsx', import.meta.url), 'utf8');
const sessionsSource = readFileSync(new URL('./Sessions.jsx', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../components/AppSidebar.jsx', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../api/runs.js', import.meta.url), 'utf8');

test('Runs is the canonical page while old Sessions navigation remains a deep-link adapter', () => {
  assert.match(appSource, /lazy\(\(\) => import\('\.\/pages\/Runs'\)\)/);
  assert.match(appSource, /resolveRunsPage\(resolveWorkBoardPage\(page\)\)/);
  assert.match(appSource, /const compatSessionRoute = page === 'sessions'/);
  assert.match(appSource, /currentPage === 'runs'/);
  assert.match(sidebarSource, /aria-label="Runs"/);
  assert.doesNotMatch(sidebarSource, /aria-label="Sessions"/);
});

test('Runs list uses the canonical API and provider sessions stay observation-only drill-down', () => {
  assert.match(clientSource, /request\(`\/api\/runs\?\$\{params\.toString\(\)\}`\)/);
  assert.match(clientSource, /request\(`\/api\/runs\/\$\{encodeURIComponent\(id\)\}`\)/);
  assert.match(pageSource, /runProviderSessionRef\(runDetail\)/);
  assert.match(pageSource, /readOnlyNotice="Run 视图中的 provider session 仅用于观测和追溯/);
  assert.match(sessionsSource, /showSidebar \? \(/);
  assert.match(sessionsSource, /readOnlyNotice,/);
});

test('old operations map to audited Run control while compatibility mode retains session operations', () => {
  assert.match(pageSource, /runsApi\.controlRun\(run\.id, action, buildRunControlPayload/);
  assert.match(pageSource, /actions\.interrupt/);
  assert.match(pageSource, /actions\.resume/);
  assert.match(pageSource, /actions\.retry/);
  assert.match(pageSource, /Sessions 兼容 deep link/);
  assert.match(pageSource, /Run source of truth:/);
  assert.match(pageSource, /最终删除门禁/);
});
