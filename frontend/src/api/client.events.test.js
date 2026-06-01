import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const clientSource = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

test('api events client shares one EventSource across subscribers', () => {
  assert.match(clientSource, /let sharedEventSource = null/);
  assert.match(clientSource, /const eventSubscribers = new Set\(\)/);
  assert.match(clientSource, /function ensureSharedEventSource\(\)/);
  assert.match(clientSource, /eventSubscribers\.size === 0[\s\S]*sharedEventSource\?\.close\(\)/);
});
