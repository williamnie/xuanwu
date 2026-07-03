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

test('session list keeps a low-frequency reconcile timer while page stays open', () => {
  assert.match(sessionsSource, /SESSION_LIST_RECONCILE_INTERVAL_MS\s*=\s*30_000/);
  assert.match(
    sessionsSource,
    /setInterval\(\(\)\s*=>\s*loadFirstPage\(\{\s*silent:\s*true,\s*preserveLoaded:\s*true,\s*reportErrors:\s*false,?\s*\}\),\s*SESSION_LIST_RECONCILE_INTERVAL_MS\)/,
  );
});

test('live thinking state avoids duplicate thinking labels', () => {
  assert.match(sessionsSource, /const showActivityBanner = shouldShowLiveActivityBanner\(parsed\);/);
  assert.match(sessionsSource, /\{showActivityBanner && \(\s*<LiveActivityBanner/);
  assert.doesNotMatch(
    sessionsSource,
    /<div className="chat-bubble-sender">Agent <span className="streaming-badge">Thinking\.\.\.<\/span><\/div>\s*<div className="chat-bubble-body thinking-placeholder">/,
  );
});
