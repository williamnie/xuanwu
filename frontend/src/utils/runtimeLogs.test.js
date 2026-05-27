import assert from 'node:assert/strict';
import test from 'node:test';

import { formatRuntimeLogsSummary, runtimeLogStats } from './runtimeLogs.js';

test('formats runtime logs summary without leaking token material', () => {
  const summary = {
    generated_at: '2026-05-28T01:00:00Z',
    line_limit: 20,
    logs: [
      { source: 'server', path: '/tmp/logs/launchd.out.log', available: true },
      { source: 'runner', path: '/tmp/logs/launchd.err.log', available: false, error: 'log file does not exist' },
    ],
    recent_errors: [
      { source: 'runner', level: 'error', text: 'failed token=secret Authorization: Bearer abc' },
      { source: 'runner', level: 'error', text: 'generated auth token file: /tmp/auth_token' },
    ],
    recent_warnings: [
      { source: 'server', level: 'warning', text: 'warn SECRET_KEY=value' },
    ],
  };

  const formatted = formatRuntimeLogsSummary(summary);

  assert.match(formatted, /Runtime logs summary/);
  assert.match(formatted, /log file does not exist/);
  assert.doesNotMatch(formatted, /secret|abc|value|auth_token/);
  assert.match(formatted, /token=\[redacted\]/);
  assert.match(formatted, /SECRET_KEY=\[redacted\]/);
});

test('summarizes runtime log availability counts', () => {
  const stats = runtimeLogStats({
    logs: [
      { path: '/tmp/out.log', available: true },
      { path: '/tmp/err.log', available: false },
    ],
    recent_errors: [{ text: 'error' }],
    recent_warnings: [{ text: 'warn' }, { text: 'warn again' }],
  });

  assert.deepEqual(stats, {
    errors: 1,
    warnings: 2,
    missing: 1,
    paths: ['/tmp/out.log', '/tmp/err.log'],
  });
});
