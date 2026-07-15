import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pageSource = readFileSync(new URL('../Sessions.jsx', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('./SessionSidebar.jsx', import.meta.url), 'utf8');
const workspaceSource = readFileSync(new URL('./SessionWorkspace.jsx', import.meta.url), 'utf8');
const chatSource = readFileSync(new URL('./SessionChatWorkspace.jsx', import.meta.url), 'utf8');
const newSessionSource = readFileSync(new URL('./NewSessionWorkspace.jsx', import.meta.url), 'utf8');
const transcriptSource = readFileSync(new URL('./SessionTranscript.jsx', import.meta.url), 'utf8');
const infoSource = readFileSync(new URL('./SessionInfoPanel.jsx', import.meta.url), 'utf8');
const selectorsSource = readFileSync(new URL('./useSessionPageSelectors.js', import.meta.url), 'utf8');

test('Sessions stays an orchestration container below half of the original monolith size', () => {
  const lineCount = pageSource.split('\n').length;
  assert.ok(lineCount < 1_000, `Sessions.jsx should stay below 1000 lines, received ${lineCount}`);
  assert.match(pageSource, /import SessionSidebar from '.\/sessions\/SessionSidebar'/);
  assert.match(pageSource, /import SessionWorkspace from '.\/sessions\/SessionWorkspace'/);
  assert.match(pageSource, /useSessionPageSelectors\(/);
  assert.doesNotMatch(pageSource, /function SessionDetail\(/);
  assert.doesNotMatch(pageSource, /function SessionSidebarContent\(/);
});

test('list workspace transcript composer and info areas have explicit component owners', () => {
  assert.match(sidebarSource, /<VirtualSessionList/);
  assert.match(workspaceSource, /<SessionChatWorkspace/);
  assert.match(workspaceSource, /<NewSessionWorkspace/);
  assert.match(chatSource, /<SessionTranscript/);
  assert.match(chatSource, /<SessionComposer/);
  assert.match(newSessionSource, /<PromptEditor/);
  assert.match(transcriptSource, /<SessionInfoPopover/);
  assert.match(infoSource, /className="session-info-panel"/);
});

test('local portal persistence selectors and reference search effects live below the page container', () => {
  assert.match(sidebarSource, /useState\(\(\) =>[\s\S]*PINNED_SESSIONS_STORAGE_KEY/);
  assert.match(sidebarSource, /document\.getElementById\(SESSION_APP_SIDEBAR_SLOT_ID\)/);
  assert.match(selectorsSource, /projectsApi\.searchProjectReferences/);
  assert.match(selectorsSource, /buildSessionComposerSuggestions/);
  assert.doesNotMatch(pageSource, /searchProjectReferences/);
  assert.doesNotMatch(pageSource, /codex-pinned-sessions/);
});
