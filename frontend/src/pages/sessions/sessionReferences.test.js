import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addSessionReference,
  buildReferenceDetails,
  hasComposerContent,
  referenceValidation,
  removeSessionReference,
  sessionPayloadWithReferences,
} from './sessionReferences.js';

test('adds and removes structured references without reading prompt text', () => {
  const issue = { type: 'issue', id: '95', label: 'Composer chips' };
  const refs = addSessionReference([], issue);

  assert.deepEqual(refs, [{ ...issue, source: 'composer', required: true }]);
  assert.deepEqual(addSessionReference(refs, issue), refs);
  assert.deepEqual(removeSessionReference(refs, 'issue:95'), []);
});

test('payload uses supported structured references as source of truth', () => {
  const payload = sessionPayloadWithReferences('hello #95', { model: 'gpt-5.5' }, [
    { type: 'file', path: 'frontend/src/pages/Sessions.jsx', label: 'Sessions.jsx' },
    { type: 'project', id: 'runner', label: 'Runner' },
  ]);

  assert.deepEqual(payload, {
    prompt: 'hello #95',
    model: 'gpt-5.5',
    references: [{ type: 'file', path: 'frontend/src/pages/Sessions.jsx', label: 'Sessions.jsx', source: 'composer', required: true }],
  });
  assert.deepEqual(sessionPayloadWithReferences('plain #95', {}), { prompt: 'plain #95' });
});

test('reference details expose ready warning and error states for supported refs only', () => {
  const details = buildReferenceDetails([
    { type: 'issue', id: '95' },
    { type: 'project', id: 'other' },
    { type: 'file', path: '' },
    { type: 'folder', path: 'big', metadata: { file_count: 800 } },
  ], {
    currentProjectId: 'runner',
    issues: [{ id: 95, title: 'Composer chips', status: 'todo', project_id: 'runner' }],
    projects: [{ id: 'other', name: 'Other project', cwd: '/repo/other' }],
  });

  assert.equal(details.length, 3);
  assert.equal(details[0].status, 'ready');
  assert.match(details[0].summary, /todo/);
  assert.equal(details[1].status, 'error');
  assert.equal(details[2].status, 'warning');

  const validation = referenceValidation(details);
  assert.equal(validation.hasErrors, true);
  assert.match(validation.message, /移除 invalid reference/);
});

test('composer content can be prompt text or attached references', () => {
  assert.equal(hasComposerContent('', []), false);
  assert.equal(hasComposerContent(' hello ', []), true);
  assert.equal(hasComposerContent('', [{ type: 'issue', id: '95' }]), true);
});

test('issue references remain sendable before the global issue list is loaded', () => {
  const details = buildReferenceDetails([
    { type: 'issue', id: '95', label: 'Composer chips' },
  ], { issues: [], projects: [] });

  assert.equal(details[0].status, 'ready');
  assert.match(details[0].summary, /#95/);
  assert.equal(referenceValidation(details).hasErrors, false);
});
