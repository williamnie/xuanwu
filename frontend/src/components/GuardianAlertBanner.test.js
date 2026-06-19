import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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
  assert.match(bannerSource, /Guardian watchdog stale/);
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
