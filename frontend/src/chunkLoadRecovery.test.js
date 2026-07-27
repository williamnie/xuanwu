import assert from 'node:assert/strict';
import test from 'node:test';
import { installChunkLoadRecovery } from './chunkLoadRecovery.js';

test('reloads the current shell when a Vite lazy chunk is no longer available', () => {
  const listeners = new Map();
  let reloads = 0;
  const runtime = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    location: {
      reload() {
        reloads += 1;
      },
    },
  };
  const event = {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };

  installChunkLoadRecovery(runtime);
  listeners.get('vite:preloadError')(event);

  assert.equal(event.defaultPrevented, true);
  assert.equal(reloads, 1);
});
