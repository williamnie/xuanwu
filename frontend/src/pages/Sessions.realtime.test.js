import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sessionsSource = readFileSync(new URL('./Sessions.jsx', import.meta.url), 'utf8');
const transcriptSource = readFileSync(new URL('./sessions/SessionTranscript.jsx', import.meta.url), 'utf8');
const chatWorkspaceSource = readFileSync(new URL('./sessions/SessionChatWorkspace.jsx', import.meta.url), 'utf8');

test('session detail keeps a low-frequency reconcile timer while selected', () => {
  assert.match(sessionsSource, /SESSION_DETAIL_RECONCILE_INTERVAL_MS\s*=\s*30_000/);
  assert.match(
    sessionsSource,
    /setInterval\(\(\)\s*=>\s*loadSelected\(false\),\s*SESSION_DETAIL_RECONCILE_INTERVAL_MS\)/,
  );
  assert.match(sessionsSource, /window\.clearInterval\(interval\)/);
});

test('session list keeps a low-frequency reconcile timer while page stays open', () => {
  assert.match(sessionsSource, /SESSION_LIST_RECONCILE_INTERVAL_MS\s*=\s*30_000/);
  assert.match(
    sessionsSource,
    /setInterval\(\(\)\s*=>\s*loadFirstPage\(\{\s*silent:\s*true,\s*preserveLoaded:\s*true,\s*reportErrors:\s*false,?\s*\}\),\s*SESSION_LIST_RECONCILE_INTERVAL_MS\)/,
  );
});

test('live thinking state avoids duplicate thinking labels', () => {
  assert.match(transcriptSource, /const showActivityBanner = shouldShowLiveActivityBanner\(parsed\);/);
  assert.match(transcriptSource, /\{showActivityBanner && \(\s*<LiveActivityBanner/);
  assert.doesNotMatch(
    transcriptSource,
    /<div className="chat-bubble-sender">Agent <span className="streaming-badge">Thinking\.\.\.<\/span><\/div>\s*<div className="chat-bubble-body thinking-placeholder">/,
  );
});

test('an in-flight send renders the optimistic user message before the existing working turn', () => {
  assert.match(chatWorkspaceSource, /<SessionTranscript[\s\S]*sending=\{sending\}/);
  assert.match(transcriptSource, /const working = Boolean\(running \|\| sending\);/);
  assert.match(transcriptSource, /shouldRenderLiveTurn\(liveEvents, working\)/);
  assert.match(
    transcriptSource,
    /localUserMessages\.map[\s\S]*<OptimisticUserMessageBubble[\s\S]*\{showLiveTurn && \([\s\S]*<LiveTurnItem/,
  );
});

test('issue execution start events immediately upsert and preserve a running session', () => {
  assert.match(
    sessionsSource,
    /setSessions\(\(prev\) => upsertRunningSessionFromEvent\(prev, event, projects\)\)/,
  );
  assert.match(sessionsSource, /preserveLoaded \? mergeRefreshedSessions\(current, data\) : data/);
});
