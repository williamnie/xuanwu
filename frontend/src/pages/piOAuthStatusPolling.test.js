import assert from 'node:assert/strict';
import test from 'node:test';
import { watchPiOAuthStatus } from './piOAuthStatusPolling.js';

function fixture(readStatus) {
  const timers = new Map();
  const statuses = [];
  let next = 0;
  const stop = watchPiOAuthStatus({
    readStatus, onStatus: status => statuses.push(status),
    setTimer: fn => { timers.set(++next, fn); return next; },
    clearTimer: id => timers.delete(id),
  });
  const tick = async () => {
    const [id, fn] = timers.entries().next().value;
    timers.delete(id);
    await fn();
  };
  return { stop, tick, timers, statuses };
}

test('browser authorization reaches the UI without a manual refresh and stops at success', async () => {
  const results = [{ status: 'pending' }, { status: 'authenticated', pi_oauth: { configured: true } }];
  const f = fixture(async () => results.shift());
  await f.tick();
  assert.equal(f.timers.size, 1);
  await f.tick();
  assert.equal(f.statuses[1].pi_oauth.configured, true);
  assert.equal(f.timers.size, 0);
});

test('failure reaches the UI and stops polling', async () => {
  const f = fixture(async () => ({ status: 'error', message: '登录失败' }));
  await f.tick();
  assert.equal(f.statuses[0].message, '登录失败');
  assert.equal(f.timers.size, 0);
});

test('cleanup ignores an in-flight response from a previous login or unmounted page', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.tick();
  assert.equal(f.timers.size, 0);
  f.stop();
  finish({ status: 'authenticated' });
  await pending;
  assert.deepEqual(f.statuses, []);
  assert.equal(f.timers.size, 0);
});

test('a transient status request failure retries without turning the OAuth attempt into a failure', async () => {
  const f = fixture(async () => { throw new Error('offline'); });
  await f.tick();
  assert.deepEqual(f.statuses, []);
  assert.equal(f.timers.size, 1);
  f.stop();
  assert.equal(f.timers.size, 0);
});
