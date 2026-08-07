import assert from 'node:assert/strict';
import test from 'node:test';
import { codexBackendChoices, codexBackendUpdatePayload } from './codexBackends.js';

test('Codex backend choices distinguish CLI and App app-servers', () => {
  const choices = codexBackendChoices({
    codex_app_status: { installed: true, native_host_configured: true, path: '/Applications/Codex.app/codex', running: true },
    codex_cli_status: { available: true, path: '/opt/bin/codex', version: 'codex-cli 1.0.0' },
    codex_server_mode: 'app',
  });

  assert.deepEqual(choices.map(choice => [choice.id, choice.active, choice.status.ready]), [
    ['cli', false, true],
    ['app', true, true],
  ]);
  assert.match(choices[0].status.detail, /codex-cli 1\.0\.0/);
  assert.match(choices[1].status.detail, /App 集成已配置/);
});

test('Codex backend update changes only the selected server mode', () => {
  assert.deepEqual(codexBackendUpdatePayload('cli'), { codex_server_mode: 'cli' });
  assert.deepEqual(codexBackendUpdatePayload('app'), { codex_server_mode: 'app' });
  assert.throws(() => codexBackendUpdatePayload('other'), /cli or app/);
});
