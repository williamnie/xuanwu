import { redactRuntimeText } from './runtimeLogs.js';

const SENSITIVE_KEY = /(?:authorization|token|secret|password|api[_-]?key|access[_-]?key)/i;

export function buildRuntimeDiagnosticsBundle({ doctor = {}, logs = {} } = {}, generatedAt = new Date().toISOString()) {
  return redactDiagnosticValue({
    schema_version: 'xuanwu.runtime-diagnostics.v1',
    generated_at: generatedAt,
    redaction: {
      absolute_paths: true,
      credentials: true,
      source: 'system APIs plus client defense-in-depth',
    },
    runtime: doctor,
    logs,
  });
}

export function formatRuntimeDiagnosticsBundle(bundle) {
  return JSON.stringify(redactDiagnosticValue(bundle), null, 2);
}

export function redactDiagnosticValue(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map(item => redactDiagnosticValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactDiagnosticValue(item, name)]));
  }
  return typeof value === 'string' ? redactRuntimeText(value) : value;
}
