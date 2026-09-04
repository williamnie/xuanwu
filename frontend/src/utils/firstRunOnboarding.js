export const FIRST_RUN_ONBOARDING_KEY = 'xuanwu-first-run-onboarding-v1';

const STORED_STATES = new Set(['active', 'completed', 'dismissed']);

export function readFirstRunOnboardingState(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem(FIRST_RUN_ONBOARDING_KEY) || '';
    return STORED_STATES.has(value) ? value : '';
  } catch {
    return '';
  }
}

export function resolveFirstRunOnboarding(state, totalWorks) {
  if (state === 'active') return 'active';
  if (state === 'completed' || state === 'dismissed') return 'hidden';
  return Number(totalWorks) === 0 ? 'active' : 'hidden';
}

export function writeFirstRunOnboardingState(state, storage = globalThis.localStorage) {
  if (!STORED_STATES.has(state)) throw new TypeError('invalid first-run onboarding state');
  try {
    storage?.setItem(FIRST_RUN_ONBOARDING_KEY, state);
  } catch {
    // 加固浏览器可能禁用 Storage；App 内存态仍可继续当前流程。
  }
}
