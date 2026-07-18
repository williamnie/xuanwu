import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRuntimeDiagnosticsBundle, formatRuntimeDiagnosticsBundle } from './runtimeDiagnostics.js';

test('builds a versioned runtime diagnostics bundle with defense-in-depth redaction', () => {
  const bundle = buildRuntimeDiagnosticsBundle({
    connectors: { connectors: [{ id: 'github-events', secret_refs: [{ ref: 'secret://integrations/github/token' }] }] },
    doctor: {
      db: { path: '<stateDir>/runner.db' },
      health: { state: 'degraded', reasons: [{ code: 'provider_unavailable' }] },
      observability: { cost: { usage: { total_tokens: 120 } }, trace_correlation: { items: [{ trace_id: 'xw:work:issues:1' }] } },
      providers: [{ id: 'codex', api_key: 'doctor-secret' }],
    },
    logs: {
      logs: [{ path: '/Users/alice/private/runtime.log' }],
      recent_errors: [{ text: 'Authorization: Bearer runtime-token' }],
    },
  }, '2026-07-17T01:00:00.000Z');
  const text = formatRuntimeDiagnosticsBundle(bundle);

  assert.equal(bundle.schema_version, 'xuanwu.runtime-diagnostics.v1');
  assert.equal(bundle.generated_at, '2026-07-17T01:00:00.000Z');
  assert.equal(bundle.health.state, 'degraded');
  assert.equal(bundle.observability.cost.usage.total_tokens, 120);
  assert.equal(bundle.observability.trace_correlation.items[0].trace_id, 'xw:work:issues:1');
  assert.match(text, /<stateDir>\/runner\.db/);
  assert.match(text, /\[redacted-path\]/);
  assert.match(text, /\[redacted\]/);
  assert.match(text, /github-events/);
  assert.doesNotMatch(text, /doctor-secret|runtime-token|\/Users\/alice/);
});
