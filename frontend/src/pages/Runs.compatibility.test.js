import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
const pageSource = readFileSync(new URL('./Runs.jsx', import.meta.url), 'utf8');
const detailSource = readFileSync(new URL('./runs/RunDetail.jsx', import.meta.url), 'utf8');
const sessionsSource = readFileSync(new URL('./Sessions.jsx', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../components/AppSidebar.jsx', import.meta.url), 'utf8');
const modulesSource = readFileSync(new URL('./assistantModules.js', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../api/runs.js', import.meta.url), 'utf8');

test('Runs is the canonical page while old Sessions navigation remains a deep-link adapter', () => {
  assert.match(appSource, /lazy\(\(\) => import\('\.\/pages\/Runs'\)\)/);
  assert.match(appSource, /resolveProductPage\(page, \{ workBoardEnabled: WORK_BOARD_ENABLED \}\)/);
  assert.match(appSource, /const compatSessionRoute = resolvedPage === 'runs' && \(page === 'sessions'/);
  assert.match(appSource, /currentPage === 'runs'/);
  assert.match(modulesSource, /page: 'runs',[\s\S]*label: PRODUCT_NAV_LABELS\.runs/);
  assert.match(sidebarSource, /aria-label=\{navLabel\(item\)\}/);
  assert.doesNotMatch(sidebarSource, /aria-label="Sessions"/);
});

test('Runs list uses the canonical API and provider sessions keep Run authority separate from follow-up chat', () => {
  assert.match(clientSource, /request\(`\/api\/runs\?\$\{params\.toString\(\)\}`, options\)/);
  assert.match(clientSource, /request\(`\/api\/runs\/\$\{encodeURIComponent\(id\)\}`, options\)/);
  assert.match(pageSource, /runProviderSessionRef\(runDetail\)/);
  assert.match(detailSource, /label: 'Provider'/);
  assert.match(detailSource, /<Sessions/);
  assert.match(detailSource, /showEvidence=\{false\}/);
  assert.match(pageSource, /selectedSessionId=\{selectedSessionId\}[\s\S]*showEvidence=\{false\}/);
  assert.match(pageSource, /surface === 'run' \? \([\s\S]*<RunSidebar/);
  assert.match(pageSource, /surface === 'new-session' \? \([\s\S]*keepNewSessionRoute[\s\S]*showEvidence=\{false\}[\s\S]*showSidebar/);
  assert.match(sessionsSource, /if \(keepNewSessionRoute\) navigateTo\?\.\('runs', null, '', '', \{ sessionId: newSessionId \}\)/);
  assert.match(sessionsSource, /if \(keepNewSessionRoute\) navigateTo\?\.\('runs', null, '', '', \{ sessionId: id \}\)/);
  assert.match(sessionsSource, /showSidebar \? \(/);
  assert.match(sessionsSource, /observationNotice,/);
});

test('Run controls remain audited without exposing migration internals in the product UI', () => {
  assert.match(pageSource, /runsApi\.controlRun\(run\.id, action, buildRunControlPayload/);
  assert.match(pageSource, /actions\.interrupt/);
  assert.match(pageSource, /actions\.resume/);
  assert.match(pageSource, /actions\.retry/);
  assert.doesNotMatch(pageSource, /兼容与迁移|Run source of truth:|最终删除门禁|setCompatibility/);
});
