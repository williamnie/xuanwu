import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildGuardianAlertDisplay,
  guardianReasonLabel,
  guardianSeverityLabel,
} from './guardianAlertDisplay.js';

const appSource = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
const bannerSource = readFileSync(new URL('./GuardianAlertBanner.jsx', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../api/client.js', import.meta.url), 'utf8');
const storeSource = readFileSync(new URL('../store/dataStore.js', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../App.css', import.meta.url), 'utf8');

test('Guardian alert banner is mounted globally above routed pages', () => {
  assert.match(appSource, /import GuardianAlertBanner from '\.\/components\/GuardianAlertBanner'/);
  assert.match(appSource, /import '\.\/App\.css'/);
  assert.match(appSource, /<main className="main-content">\s*<GuardianAlertBanner \/>/);
  assert.match(cssSource, /\.guardian-alert-stack/);
  assert.match(cssSource, /position:\s*sticky/);
});

test('Guardian banner reads alerts and watchdog stale without native dialogs', () => {
  assert.match(bannerSource, /api\.getSystemStatus\(\)/);
  assert.match(bannerSource, /pi_guardian\?\.watchdog/);
  assert.match(bannerSource, /watchdog\?\.is_stale/);
  assert.match(bannerSource, /Guardian 心跳已超时/);
  assert.match(bannerSource, /api\.ackPiGuardianAlert\(id\)/);
  assert.doesNotMatch(bannerSource, /window\.(alert|confirm)/);
});

test('Guardian alert client and store expose open alerts slice with graceful fallback', () => {
  assert.match(clientSource, /getPiGuardianAlerts:/);
  assert.match(clientSource, /\/api\/pi\/guardian\/alerts/);
  assert.match(clientSource, /ackPiGuardianAlert:/);
  assert.match(clientSource, /\/api\/pi\/guardian\/alerts\/\$\{encodeURIComponent\(id\)\}\/ack/);
  assert.match(storeSource, /guardianAlerts:\s*\[\]/);
  assert.match(storeSource, /setGuardianAlerts:/);
  assert.match(storeSource, /sameGuardianAlerts/);
  assert.match(storeSource, /selectGuardianAlerts/);
});

test('Guardian alert display maps missed digest pending to actionable Chinese copy', () => {
  const display = buildGuardianAlertDisplay({
    alert_type: 'missed_digest_pending',
    evidence: { reason: 'digest_pipeline_unavailable' },
    message: 'missed digest pending for project -: digest_pipeline_unavailable',
    project_id: '-',
    severity: 'watch',
    watchdog_seen_at: '2026-06-23T01:02:03Z',
  });
  const visibleText = `${display.title} ${display.message} ${display.meta}`;

  assert.equal(display.title, '飞书摘要通知暂时不可用');
  assert.equal(display.severityLabel, '观察');
  assert.match(display.message, /待补发的通知摘要/);
  assert.match(display.message, /恢复后会自动补发/);
  assert.match(display.message, /检查 PI Guardian 的 digest\/coordinator\/outbox 状态/);
  assert.match(display.meta, /范围：系统级/);
  assert.match(display.meta, /级别：观察/);
  assert.doesNotMatch(visibleText, /missed_digest_pending|digest_pipeline_unavailable|project -/);
});

test('Guardian alert display renders empty project as system scope', () => {
  const display = buildGuardianAlertDisplay({
    alert_type: 'outbox_stalled',
    message: 'outbox stalled',
    project_id: '',
    severity: 'urgent',
  });

  assert.match(display.meta, /范围：系统级/);
  assert.doesNotMatch(display.meta, /project -|项目 -/);
});

test('Guardian alert display covers common outage types without leaking internal enums', () => {
  const alertTypes = [
    'digest_flush_stalled',
    'outbox_stalled',
    'coordinator_stalled',
    'guardian_inbox_stalled',
    'scheduler_stalled',
  ];

  for (const alertType of alertTypes) {
    const display = buildGuardianAlertDisplay({
      alert_type: alertType,
      message: `${alertType}: internal detail`,
      project_id: 'runner',
      severity: 'urgent',
    });
    const visibleText = `${display.title} ${display.message} ${display.meta}`;

    assert.equal(display.severityLabel, '紧急');
    assert.match(display.meta, /范围：项目 runner/);
    assert.match(display.message, /请检查|请确认/);
    assert.doesNotMatch(visibleText, new RegExp(alertType));
  }
});

test('Guardian display helper maps severity and internal reasons to Chinese labels', () => {
  assert.equal(guardianSeverityLabel('watch'), '观察');
  assert.equal(guardianSeverityLabel('urgent'), '紧急');
  assert.equal(guardianReasonLabel('digest_pipeline_unavailable'), '通知摘要链路不可用');
  assert.equal(guardianReasonLabel('temporary_pipeline_outage'), '通知链路异常');
  assert.equal(guardianReasonLabel('feishu sender failed'), '通知链路异常');
});
