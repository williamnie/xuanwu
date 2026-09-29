import assert from 'node:assert/strict';
import test from 'node:test';
import { GITHUB_OPERATIONS, githubApplicationLabel, githubConnectionLabel, githubDraftDirty, githubPhaseLabel, githubSettingsReducer as reduce, initialGitHubSettings, newGitHubRepository } from './githubSettingsModel.js';
const remote = revision => ({ revision, settings: { enabled: false, repositories: [newGitHubRepository('fixture')] }, application: { status: 'pending' } });

test('new repository never implicitly enables writes, merge or deploy', () => {
  const repo = newGitHubRepository('fixture');
  for (const [key] of GITHUB_OPERATIONS) assert.equal(repo[key], false);
  assert.equal(repo.allowMerge, undefined);
  assert.equal(repo.allowDeploy, undefined);
});
test('refresh preserves edited draft and stale revision until deliberate conflict resolution', () => {
  let state = reduce(initialGitHubSettings(), { type: 'loaded', remote: remote('one') });
  state = reduce(state, { type: 'edit', draft: { ...state.draft, enabled: true } });
  state = reduce(state, { type: 'loaded', remote: remote('two') });
  assert.equal(state.draft.enabled, true);
  assert.equal(state.revision, 'one');
  assert.equal(state.conflict, true);
  state = reduce(state, { type: 'rebase' });
  assert.equal(state.revision, 'two');
  assert.equal(state.draft.enabled, true);
  assert.equal(state.conflict, false);
  assert.equal(githubDraftDirty(state), true);
  state = reduce(state, { type: 'use-server' });
  assert.equal(githubDraftDirty(state), false);
});
test('save and reload failures keep draft and application evidence, editing invalidates connectivity result', () => {
  let state = reduce(initialGitHubSettings(), { type: 'loaded', remote: remote('one') });
  const draft = { ...state.draft, enabled: true };
  state = reduce(state, { type: 'edit', draft });
  state = reduce(state, { type: 'error', status: 409, message: 'config_conflict' });
  assert.deepEqual(state.draft, draft);
  assert.equal(state.remote.application.status, 'pending');
  state = reduce(state, { type: 'tested', result: { status: 'connected' } });
  state = reduce(state, { type: 'edit', draft });
  assert.equal(state.testResult, null);
  state = reduce(state, { type: 'saved', remote: { ...remote('two'), settings: draft } });
  assert.equal(githubDraftDirty(state), false);
  state = reduce(state, { type: 'error', status: 409, message: 'reload_failed' });
  assert.equal(state.remote.application.status, 'pending');
});
test('connection, application and workflow labels explain supported scenarios', () => {
  for (const status of ['connected', 'permission_denied', 'label_mismatch', 'repository_unavailable', 'authentication_failed', 'credential_unavailable']) assert.notEqual(githubConnectionLabel(status), status);
  for (const status of ['pending', 'applied', 'unavailable']) assert.notEqual(githubApplicationLabel(status), status);
  for (const stage of ['intake', 'investigate', 'repair', 'needs_user', 'review', 'paused', 'resolved']) assert.notEqual(githubPhaseLabel(stage), stage);
});
