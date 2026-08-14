import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./CodeAgentsPanel.jsx', import.meta.url), 'utf8');

test('Qoder Code Agent card exposes runtime, authentication, and version diagnostics', () => {
  assert.match(source, /qoder:\s*'Qoder Agent SDK \/ qodercli 执行器'/);
  assert.match(source, /<QoderDiagnostics runtime=\{agent\.runtime\}/);
  for (const label of ['CLI', 'SDK', '认证', '协议']) assert.match(source, new RegExp(`\\['${label}'`));
  assert.match(source, /auth_configured/);
  assert.match(source, /cli_version/);
  assert.match(source, /protocol_version/);
});
