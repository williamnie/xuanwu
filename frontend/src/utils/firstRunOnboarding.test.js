import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FIRST_RUN_ONBOARDING_KEY,
  readFirstRunOnboardingState,
  resolveFirstRunOnboarding,
  writeFirstRunOnboardingState,
} from './firstRunOnboarding.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('a pristine installation opens onboarding while existing users stay in the app', () => {
  assert.equal(resolveFirstRunOnboarding('', 0), 'active');
  assert.equal(resolveFirstRunOnboarding('', 3), 'hidden');
});

test('active onboarding survives a reload after its first Work is created', () => {
  assert.equal(resolveFirstRunOnboarding('active', 1), 'active');
  assert.equal(resolveFirstRunOnboarding('completed', 0), 'hidden');
  assert.equal(resolveFirstRunOnboarding('dismissed', 0), 'hidden');
});

test('stored first-run state is narrow and validated', () => {
  const storage = memoryStorage();
  writeFirstRunOnboardingState('active', storage);
  assert.equal(storage.getItem(FIRST_RUN_ONBOARDING_KEY), 'active');
  assert.equal(readFirstRunOnboardingState(storage), 'active');
  assert.throws(() => writeFirstRunOnboardingState('other', storage), /invalid/);
});
