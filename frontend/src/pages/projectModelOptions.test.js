import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProviderModelOptions } from './projectModelOptions.js';

test('model dropdown preserves custom and historical values when discovery fails or hides a model', () => {
  const models = [{ id: 'available', displayName: 'Available' }, { id: 'retired', hidden: true }];
  const options = buildProviderModelOptions('codex', models, ['retired', 'custom', 'available']);
  assert.deepEqual(options.map(option => option.value), ['codex-default', 'available', 'retired', 'custom']);
  assert.match(options.find(option => option.value === 'retired').label, /当前值（自定义）/);
  assert.equal(options.find(option => option.value === 'available').label, 'Available');
  assert.deepEqual(buildProviderModelOptions('qoder', [], ['account-model']).map(option => option.value), ['', 'account-model']);
  assert.match(buildProviderModelOptions('claude', [], ['historical'], 'en-US')[1].label, /Current value \(custom\)/);
});
