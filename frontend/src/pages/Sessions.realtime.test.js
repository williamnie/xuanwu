import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sessionsSource = readFileSync(new URL('./Sessions.jsx', import.meta.url), 'utf8');

test('session detail keeps a low-frequency reconcile timer while selected', () => {
  assert.match(sessionsSource, /SESSION_DETAIL_RECONCILE_INTERVAL_MS\s*=\s*30_000/);
  assert.match(
    sessionsSource,
    /setInterval\(\(\)\s*=>\s*loadSelected\(false\),\s*SESSION_DETAIL_RECONCILE_INTERVAL_MS\)/,
  );
  assert.match(sessionsSource, /window\.clearInterval\(interval\)/);
});
