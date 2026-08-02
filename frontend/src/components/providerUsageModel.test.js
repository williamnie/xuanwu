import assert from 'node:assert/strict';
import test from 'node:test';

import {
  availableUsageProviders,
  providerUsageReport,
  readSelectedUsageProvider,
  selectedUsageProvider,
  writeSelectedUsageProvider,
} from './providerUsageModel.js';

const usage = {
  providers: [
    { provider: { id: 'codex' }, summary: { today: { total_tokens: 10 } } },
    { provider: { id: 'claude' }, summary: { today: { total_tokens: 20 } } },
  ],
};

test('usage selector only offers currently available providers', () => {
  const providers = availableUsageProviders({
    providers: [
      { available: true, enabled: true, id: 'codex', label: 'Codex', role: 'executor' },
      { available: false, enabled: true, id: 'claude', label: 'Claude Agent SDK', role: 'executor' },
    ],
  }, usage);

  assert.deepEqual(providers.map(provider => provider.id), ['codex']);
  assert.equal(selectedUsageProvider(providers, 'claude').id, 'codex');
});

test('usage selector keeps the chosen provider when multiple are available', () => {
  const providers = availableUsageProviders({
    providers: [
      { available: true, enabled: true, id: 'codex', label: 'Codex', role: 'executor' },
      { available: true, enabled: true, id: 'claude', label: 'Claude Agent SDK', role: 'executor' },
    ],
  }, usage);

  assert.equal(selectedUsageProvider(providers, 'claude').id, 'claude');
  assert.equal(providerUsageReport(usage, 'claude').summary.today.total_tokens, 20);
});

test('selected provider storage is optional and failure tolerant', () => {
  const storage = new MemoryStorage();
  writeSelectedUsageProvider('claude', storage);
  assert.equal(readSelectedUsageProvider(storage), 'claude');
  assert.doesNotThrow(() => writeSelectedUsageProvider('codex', { setItem() { throw new Error('full'); } }));
});

class MemoryStorage {
  value = '';

  getItem() {
    return this.value;
  }

  setItem(_key, value) {
    this.value = value;
  }
}
