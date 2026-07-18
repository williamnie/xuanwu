import assert from 'node:assert/strict';
import test from 'node:test';

import { setAuthToken } from './authToken.js';
import { request } from './base.js';
import { ApiError } from './errors.js';

test('base request preserves bearer auth, JSON headers, and response parsing', async () => {
  const restore = installRequestGlobals(async (url, options) => {
    assert.equal(url, '/api/example');
    const headers = new Headers(options.headers);
    assert.equal(headers.get('Authorization'), 'Bearer test-token');
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.equal(headers.get('X-Codex-Client'), 'xuanwu-web');
    assert.equal(headers.get('X-Request-ID'), 'request-1');
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  try {
    setAuthToken('test-token');
    assert.deepEqual(await request('/api/example', {
      headers: { 'X-Request-ID': 'request-1' },
    }), { ok: true });
  } finally {
    restore();
  }
});

test('base request preserves error message and status semantics', async () => {
  const restore = installRequestGlobals(async () => new Response(
    JSON.stringify({ message: 'permission denied' }),
    { status: 403 },
  ));

  try {
    await assert.rejects(request('/api/forbidden'), (error) => {
      assert.ok(error instanceof Error);
      assert.ok(error instanceof ApiError);
      assert.equal(error.name, 'Error');
      assert.equal(error.message, 'permission denied');
      assert.equal(error.status, 403);
      return true;
    });
  } finally {
    restore();
  }
});

test('base request preserves empty 204 response semantics', async () => {
  const restore = installRequestGlobals(async () => new Response(null, { status: 204 }));
  try {
    assert.equal(await request('/api/no-content'), null);
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

function installRequestGlobals(fetchImpl) {
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const previousStorage = globalThis.localStorage;
  globalThis.document = { cookie: '' };
  globalThis.fetch = fetchImpl;
  globalThis.localStorage = new MemoryStorage();

  return () => {
    restoreGlobal('document', previousDocument);
    restoreGlobal('fetch', previousFetch);
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
