import assert from 'node:assert/strict';
import test from 'node:test';

import { providerLabel, providerOptionsFromCatalog, sessionSettingsForProject, sessionSettingsForProvider } from './sessionOptions.js';

test('provider catalog drives selector labels and readiness', () => {
  const catalog = [
    { id: 'codex', label: 'Codex', state: 'ready', submittable: true },
    { id: 'pi', label: 'Pi Coding Agent', state: 'not_ready', submittable: false },
  ];

  assert.deepEqual(providerOptionsFromCatalog(catalog), [
    { value: 'codex', label: 'Codex', enabled: true, state: 'ready' },
  ]);
  assert.equal(providerLabel('pi', catalog), 'Pi Coding Agent');
});

test('switching providers clears provider-scoped model and service tier', () => {
  assert.deepEqual(sessionSettingsForProvider({
    provider: 'codex',
    model: 'codex-default',
    serviceTier: 'priority',
    sandbox: 'danger-full-access',
  }, 'pi-coding-agent'), {
    provider: 'pi-coding-agent',
    model: '',
    serviceTier: '',
    sandbox: 'danger-full-access',
  });
});

test('an explicitly selected provider survives a later project selection', () => {
  const settings = sessionSettingsForProject(
    { provider: 'pi-coding-agent', model: 'deepseek/deepseek-v4-flash', approval_policy: 'never', sandbox: 'workspace-write' },
    { provider: 'claude', model: 'claude-sonnet', serviceTier: 'priority' },
    true,
  );

  assert.equal(settings.provider, 'claude');
  assert.equal(settings.model, '');
  assert.equal(settings.serviceTier, '');
});
