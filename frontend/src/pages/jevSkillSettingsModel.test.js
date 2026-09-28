import assert from 'node:assert/strict';
import test from 'node:test';
import { initialJevState, jevAvailabilityLabel, jevDraft, jevDraftError, jevPayload, jevSettingsReducer } from './jevSkillSettingsModel.js';

const settings = {
  skill_id: 'jev-assist', installed: true, enabled: false, mode: 'shadow',
  model: 'jev-1.13.0', scopes: ['github'], timeout_ms: 3000, min_confidence: 0.8,
  api_key_configured: true, credential_source: 'secret', availability: 'disabled', recent_calls: [],
};
const reduce = jevSettingsReducer;
const loaded = () => reduce(initialJevState(), { type: 'loaded', settings });

test('late settings refresh preserves manual selections and updates untouched status fields', () => {
  let state = reduce(loaded(), { type: 'load-start' });
  state = reduce(state, { type: 'edit', patch: { enabled: true, mode: 'assist', scopes: ['web'], api_key: 'new-secret' } });
  state = reduce(state, { type: 'loaded', settings: { ...settings, model: 'jev-2', availability: 'cooldown' } });
  assert.equal(state.draft.enabled, true);
  assert.equal(state.draft.mode, 'assist');
  assert.deepEqual(state.draft.scopes, ['web']);
  assert.equal(state.draft.api_key, 'new-secret');
  assert.equal(state.draft.model, 'jev-2');
  assert.equal(state.remote.availability, 'cooldown');
  assert.equal(state.loading, false);
});

test('save response cannot overwrite edits made after submission or clear a newly typed key', () => {
  let state = reduce(loaded(), { type: 'edit', patch: { mode: 'assist', api_key: 'submitted-secret' } });
  const revisions = state.revisions;
  state = reduce(state, { type: 'save-start' });
  assert.equal(state.saving, true);
  state = reduce(state, { type: 'edit', patch: { mode: 'shadow', api_key: 'next-secret' } });
  state = reduce(state, { type: 'saved', settings: { ...settings, mode: 'assist' }, revisions });
  assert.equal(state.draft.mode, 'shadow');
  assert.equal(state.draft.api_key, 'next-secret');
  assert.equal(state.dirty.mode, true);
  assert.equal(state.dirty.api_key, true);
  assert.equal(state.remote.mode, 'assist');
  assert.equal(state.saving, false);
});

test('saved key is cleared from the draft and remote key material is never copied into inputs', () => {
  let state = reduce(loaded(), { type: 'edit', patch: { api_key: 'submitted-secret' } });
  state = reduce(state, { type: 'saved', settings: { ...settings, api_key: 'must-not-echo' }, revisions: state.revisions });
  assert.equal(state.draft.api_key, '');
  assert.deepEqual(state.dirty, {});
  assert.equal(jevDraft({ api_key: 'must-not-echo' }).api_key, '');
});

test('empty keys preserve credentials; explicit removal excludes replacement credentials', () => {
  const draft = jevDraft(settings);
  assert.equal('api_key' in jevPayload(draft), false);
  assert.equal('clear_api_key' in jevPayload(draft), false);
  assert.deepEqual(jevPayload({ ...draft, api_key: '  ' }), jevPayload(draft));
  assert.equal(jevPayload({ ...draft, api_key: ' next-secret ' }).api_key, 'next-secret');
  let state = reduce(loaded(), { type: 'edit', patch: { api_key: 'next-secret' } });
  state = reduce(state, { type: 'edit', patch: { clear_api_key: true } });
  assert.equal(state.draft.api_key, '');
  assert.equal(jevPayload(state.draft).clear_api_key, true);
  assert.equal('api_key' in jevPayload(state.draft), false);
  state = reduce(state, { type: 'edit', patch: { api_key: 'replacement' } });
  assert.equal(state.draft.clear_api_key, false);
});

test('connection tests give immediate busy state, retain actual failure and mark outdated results', () => {
  let state = reduce(loaded(), { type: 'test-start' });
  assert.equal(state.testing, true);
  assert.equal(state.testResult, null);
  const revision = state.revision;
  state = reduce(state, { type: 'edit', patch: { model: 'jev-2' } });
  const result = { ok: false, status: 'fallback', reason: 'timeout', duration_ms: 3000 };
  state = reduce(state, { type: 'tested', result, revision });
  assert.equal(state.testing, false);
  assert.equal(state.testResult.ok, false);
  assert.equal(state.testResult.reason, 'timeout');
  assert.equal(state.testStale, true);
  assert.equal(state.remote, settings);
});

test('saved removal resets checkbox while retaining the server unconfigured state', () => {
  let state = reduce(loaded(), { type: 'edit', patch: { clear_api_key: true } });
  state = reduce(state, {
    type: 'saved', revisions: state.revisions,
    settings: { ...settings, api_key_configured: false, credential_source: 'none', availability: 'unconfigured' },
  });
  assert.equal(state.draft.clear_api_key, false);
  assert.equal(state.remote.api_key_configured, false);
  assert.deepEqual(state.dirty, {});
});

test('validation rejects empty and non-finite limits but permits disabled or empty-scope configurations', () => {
  const draft = jevDraft(settings);
  assert.equal(jevDraftError({ ...draft, enabled: false, scopes: [] }), '');
  for (const min_confidence of ['', 'NaN', '-1', '0.49', '1.1']) assert.ok(jevDraftError({ ...draft, min_confidence }));
  for (const timeout_ms of ['', 'NaN', '0', '-1', '1.5', '499', '30001']) assert.ok(jevDraftError({ ...draft, timeout_ms }));
  for (const timeout_ms of ['500', '30000']) assert.equal(jevDraftError({ ...draft, timeout_ms, min_confidence: '0.5' }), '');
  assert.ok(jevDraftError({ ...draft, model: 'not-a-jev-model' }));
});

test('ready describes configuration instead of claiming a verified network connection', () => {
  assert.equal(jevAvailabilityLabel('ready'), '已配置');
});
