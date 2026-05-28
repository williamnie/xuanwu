import assert from 'node:assert/strict';
import test from 'node:test';

import { clearAuthToken, getAuthToken, setAuthToken } from './authToken.js';

test('getAuthToken falls back to cookie when localStorage is empty', () => {
  const restore = installBrowserAuthGlobals({
    cookie: 'codex_runner_token=cookie-token',
    storage: new MemoryStorage(),
  });
  try {
    assert.equal(getAuthToken(), 'cookie-token');
  } finally {
    restore();
  }
});

test('setAuthToken writes storage and same-origin cookie', () => {
  const storage = new MemoryStorage();
  const restore = installBrowserAuthGlobals({ storage });
  try {
    setAuthToken(' saved-token ');

    assert.equal(storage.getItem('codex-runner-auth-token'), 'saved-token');
    assert.match(globalThis.document.cookie, /codex_runner_token=saved-token/);
  } finally {
    restore();
  }
});

test('clearAuthToken removes storage and expires cookie', () => {
  const storage = new MemoryStorage();
  const restore = installBrowserAuthGlobals({
    cookie: 'codex_runner_token=old-token',
    storage,
  });
  try {
    storage.setItem('codex-runner-auth-token', 'old-token');

    clearAuthToken();

    assert.equal(storage.getItem('codex-runner-auth-token'), null);
    assert.match(globalThis.document.cookie, /Max-Age=0/);
  } finally {
    restore();
  }
});

class MemoryStorage {
  constructor() {
    this.items = new Map();
  }

  getItem(key) {
    return this.items.has(key) ? this.items.get(key) : null;
  }

  setItem(key, value) {
    this.items.set(key, String(value));
  }

  removeItem(key) {
    this.items.delete(key);
  }
}

function installBrowserAuthGlobals({ cookie = '', storage }) {
  const previousDocument = globalThis.document;
  const previousStorage = globalThis.localStorage;

  globalThis.document = { cookie };
  globalThis.localStorage = storage;

  return () => {
    restoreGlobal('document', previousDocument);
    restoreGlobal('localStorage', previousStorage);
  };
}

function restoreGlobal(key, value) {
  if (value === undefined) {
    delete globalThis[key];
    return;
  }
  globalThis[key] = value;
}
