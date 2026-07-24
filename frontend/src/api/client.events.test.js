import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const assistantSource = readFileSync(new URL('./assistant.js', import.meta.url), 'utf8');
const eventsSource = readFileSync(new URL('./events.js', import.meta.url), 'utf8');
const workSource = readFileSync(new URL('./work.js', import.meta.url), 'utf8');

test('api events client shares one EventSource across subscribers', () => {
  assert.match(eventsSource, /let sharedEventSource = null/);
  assert.match(eventsSource, /const eventSubscribers = new Set\(\)/);
  assert.match(eventsSource, /function ensureSharedEventSource\(\)/);
  assert.match(eventsSource, /eventSubscribers\.size === 0[\s\S]*sharedEventSource\?\.close\(\)/);
});

test('api client exposes PI conversation interrupt endpoint', () => {
  assert.match(assistantSource, /interruptPiConversation:\s*\(id\) => request/);
  assert.ok(assistantSource.includes('`/api/pi/conversations/${encodeURIComponent(id)}/interrupt`'));
});

test('api client sends PI messages through the dedicated POST SSE consumer', () => {
  assert.match(
    assistantSource,
    /sendPiConversationMessage:\s*\(id, message, options\) => streamPiConversationMessage\(id, message, options\)/,
  );
});

test('api client exposes global and issue-scoped event summary queries', () => {
  assert.match(eventsSource, /getEventSummaries:/);
  assert.match(eventsSource, /`\/api\/event-summaries\$\{query\}`/);
  assert.match(workSource, /getIssueEventSummaries:/);
  assert.match(workSource, /`\/api\/issues\/\$\{id\}\/event-summaries\$\{query\}`/);
});
