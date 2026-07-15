import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pageSource = readFileSync(new URL('./AttentionInbox.jsx', import.meta.url), 'utf8');
const assistantSource = readFileSync(new URL('../api/assistant.js', import.meta.url), 'utf8');
const styleSource = readFileSync(new URL('./AttentionInbox.css', import.meta.url), 'utf8');

test('Attention Inbox shows approval UI for action proposals with editable reply drafts', () => {
  assert.match(assistantSource, /getPiActionProposals/);
  assert.match(assistantSource, /approvePiActionProposal/);
  assert.match(assistantSource, /rejectPiActionProposal/);
  assert.match(pageSource, /function ProposalPanel/);
  assert.match(pageSource, /Action proposal/);
  assert.match(pageSource, /Reply draft/);
  assert.match(pageSource, /<textarea[\s\S]*draftText/);
  assert.match(pageSource, /action_edits/);
  assert.match(pageSource, /approvePiActionProposal/);
  assert.match(pageSource, /rejectPiActionProposal/);
  assert.match(styleSource, /\.proposal-card/);
  assert.doesNotMatch(pageSource, /window\.confirm|window\.alert/);
});

test('Inbox shows a clear coming soon state when attention API is missing', () => {
  assert.match(pageSource, /<h1>Inbox<\/h1>/);
  assert.match(pageSource, /runtime 尚未启用 Inbox API/);
  assert.match(pageSource, /Inbox API coming soon/);
});
