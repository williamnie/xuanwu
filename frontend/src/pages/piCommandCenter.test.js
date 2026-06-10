import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../components/AppSidebar.jsx', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../api/client.js', import.meta.url), 'utf8');
const pageUrl = new URL('./PiCommandCenter.jsx', import.meta.url);
const pageSource = existsSync(pageUrl) ? readFileSync(pageUrl, 'utf8') : '';
const reportsSource = readFileSync(new URL('./PiReportsPanel.jsx', import.meta.url), 'utf8');
const sessionsClientCss = readFileSync(new URL('./sessions/SessionsClient.css', import.meta.url), 'utf8');

test('PI Command Center is available as a first-class routed page with Chinese navigation copy', () => {
  assert.ok(existsSync(pageUrl), 'PiCommandCenter.jsx should exist');
  assert.match(appSource, /import PiCommandCenter from '\.\/pages\/PiCommandCenter'/);
  assert.match(appSource, /currentPage === 'pi-command-center'/);
  assert.match(sidebarSource, /pi-command-center/);
  assert.match(sidebarSource, /PI 控制台/);
  assert.doesNotMatch(sidebarSource, /Command Center/);
});

test('PI Command Center renders Chinese status cards with loading and error states', () => {
  for (const label of ['当前模式', '自动检查', '委托窗口', '待我审批', '自动恢复']) {
    assert.match(pageSource, new RegExp(label));
  }
  for (const copy of ['PI 托管控制台', '自动执行与审批中心', '待审批', '当前模式：', '最近自动检查', '刷新状态', '状态更新于']) {
    assert.match(pageSource, new RegExp(copy));
  }
  for (const oldCopy of ['PI OpenClaw', 'Generated', 'Pending approvals']) {
    assert.doesNotMatch(pageSource, new RegExp(oldCopy));
  }
  assert.doesNotMatch(pageSource, />\s*Refresh\s*</);
  assert.match(pageSource, /import PiDelegationsPanel from '\.\/PiDelegationsPanel'/);
  assert.match(pageSource, /import PiActionAuditPanel from '\.\/PiActionAuditPanel'/);
  assert.match(pageSource, /import PiHeartbeatTimelinePanel from '\.\/PiHeartbeatTimelinePanel'/);
  assert.match(pageSource, /import PiReportsPanel from '\.\/PiReportsPanel'/);
  assert.match(pageSource, /<PiHeartbeatTimelinePanel \/>/);
  assert.match(pageSource, /<PiReportsPanel \/>/);
  assert.match(pageSource, /<PiActionAuditPanel onChanged=\{state\.reload\} variant="command-center" \/>/);
  assert.match(pageSource, /<PiDelegationsPanel onChanged=\{state\.reload\} \/>/);
  assert.match(pageSource, /pi-command-loading/);
  assert.match(pageSource, /pi-command-error/);
  assert.match(pageSource, /api\.getPiCommandCenter\(\)/);
});

test('PI Command Center keeps future framework placeholders read-only', () => {
  assert.doesNotMatch(pageSource, /api\.getCodexUsage/);
  assert.doesNotMatch(pageSource, /pauseProjectPiAutonomousMode|resumeProjectPiAutonomousMode/);
  assert.match(clientSource, /getPiCommandCenter: \(\) => request\('\/api\/pi\/command-center'\)/);
  assert.doesNotMatch(pageSource, /window\.confirm|window\.alert/);
});

test('PI Command Center reports panel summarizes supervisor recovery outcomes', () => {
  assert.match(clientSource, /getPiReports:/);
  assert.match(clientSource, /\/api\/pi\/reports/);
  assert.match(reportsSource, /自动恢复报告/);
  assert.match(reportsSource, /已恢复/);
  assert.match(reportsSource, /限流等待/);
  assert.match(reportsSource, /恢复耗尽/);
  assert.match(reportsSource, /需人工处理/);
  assert.doesNotMatch(reportsSource, />\s*Refresh\s*</);
  assert.doesNotMatch(reportsSource, /window\.confirm|window\.alert/);
});

test('PI Command Center keeps main content scrollable instead of inheriting sessions overflow lock', () => {
  const appContainerMarkup = appSource.match(/<div className=\{`app-container[\s\S]*?`\}>/)?.[0] || '';
  assert.match(sessionsClientCss, /\.in-sessions-page \.main-content[\s\S]*overflow: hidden !important/);
  assert.doesNotMatch(appContainerMarkup, /currentPage === 'pi-command-center'/);
});
