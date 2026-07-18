import { redactRuntimeText } from './runtimeLogs.js';

const SENSITIVE_KEY = /(?:authorization|token|secret|password|api[_-]?key|access[_-]?key)/i;
const SAFE_USAGE_KEYS = new Set([
  'cached_input_tokens',
  'input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
]);

export function buildRuntimeDiagnosticsBundle({ connectors = {}, doctor = {}, logs = {} } = {}, generatedAt = new Date().toISOString()) {
  return redactDiagnosticValue({
    schema_version: 'xuanwu.runtime-diagnostics.v1',
    generated_at: generatedAt,
    redaction: {
      absolute_paths: true,
      credentials: true,
      source: 'system APIs plus client defense-in-depth',
    },
    runtime: doctor,
    health: doctor?.health || {},
    observability: doctor?.observability || {},
    connectors,
    logs,
  });
}

export function formatRuntimeDiagnosticsBundle(bundle) {
  return JSON.stringify(redactDiagnosticValue(bundle), null, 2);
}

export function redactDiagnosticValue(value, key = '') {
  if (SENSITIVE_KEY.test(key) && !SAFE_USAGE_KEYS.has(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map(item => redactDiagnosticValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactDiagnosticValue(item, name)]));
  }
  return typeof value === 'string' ? redactRuntimeText(value) : value;
}
