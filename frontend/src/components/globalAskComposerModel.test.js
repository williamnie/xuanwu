import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addGlobalComposerReference,
  buildGlobalComposerPageReference,
  buildGlobalComposerReferenceDetails,
  buildGlobalComposerSubmission,
  buildGlobalComposerSuggestions,
  isGlobalAskComposerVisible,
  syncGlobalComposerPageReference,
} from './globalAskComposerModel.js';

const projects = [
  { cwd: '/repo/alpha', id: 'alpha', name: 'Alpha' },
  { cwd: '/repo/beta', id: 'beta', name: 'Beta' },
];
const works = [
  { id: 'xw:work:issues:698', owner: { project_id: 'alpha' }, status: 'in_progress', title: 'Global composer' },
  { id: 'xw:work:issues:699', owner: { project_id: 'beta' }, status: 'todo', title: 'Simplify chat' },
];

test('global composer stays on product pages but does not duplicate the full Ask Xuanwu page', () => {
  assert.equal(isGlobalAskComposerVisible('command-center'), true);
  assert.equal(isGlobalAskComposerVisible('work'), true);
  assert.equal(isGlobalAskComposerVisible('runs'), true);
  assert.equal(isGlobalAskComposerVisible('runs', { interaction_surface: 'provider-session' }), false);
  assert.equal(isGlobalAskComposerVisible('ask-xuanwu'), false);
});

test('draft page context is frozen across navigation until the draft is empty', () => {
  const commandCenter = buildGlobalComposerPageReference({ currentPage: 'command-center' }, works);
  const run = buildGlobalComposerPageReference({
    currentPage: 'runs',
    pageContext: {
      page_id: 'runs',
      project_id: 'alpha',
      run_id: 'xw:run:698:1',
      work_id: 'xw:work:issues:698',
    },
  }, works);

  assert.deepEqual(syncGlobalComposerPageReference([commandCenter], 'keep this draft', run), [commandCenter]);
  assert.deepEqual(syncGlobalComposerPageReference([commandCenter], '', run), [run]);
});

test('embedded delivery keeps its Handoff attached to the Work page context', () => {
  const page = buildGlobalComposerPageReference({
    currentPage: 'work',
    pageContext: {
      handoff_id: 'xw:handoff:derived:698%40abc',
      page_id: 'work',
      project_id: 'alpha',
      work_id: 'xw:work:issues:698',
    },
    selectedHandoffId: 'xw:handoff:derived:stale',
  }, works);

  assert.match(page.id, /handoff:xw:handoff:derived:698%40abc/);
  assert.equal(page.metadata.work_id, 'xw:work:issues:698');
});

test('project and Work mentions attach canonical ids with visible provenance details', () => {
  const suggestions = buildGlobalComposerSuggestions(projects, works);
  const project = suggestions.find(item => item.reference?.type === 'project');
  const work = suggestions.find(item => item.reference?.type === 'work');
  const references = addGlobalComposerReference(addGlobalComposerReference([], project.reference), work.reference);
  const details = buildGlobalComposerReferenceDetails(references, projects, works);

  assert.equal(project.insertText, '@alpha');
  assert.equal(work.insertText, '#698');
  assert.deepEqual(references.map(item => item.type), ['project', 'work']);
  assert.deepEqual(details.map(item => item.status), ['ready', 'ready']);
});

test('submission reuses the conversation API and preserves context provenance without granting authority', () => {
  const page = buildGlobalComposerPageReference({
    currentPage: 'runs',
    pageContext: {
      page_id: 'runs',
      project_id: 'alpha',
      run_id: 'xw:run:698:1',
      work_id: 'xw:work:issues:698',
    },
  }, works);
  const submission = buildGlobalComposerSubmission({
    permissionMode: 'read_only',
    prompt: '分析失败原因',
    references: [page],
  });

  assert.deepEqual(submission.conversation, { project_id: 'alpha', title: 'New conversation' });
  assert.equal(submission.message.intent, 'review');
  assert.equal(submission.message.target_project_id, 'alpha');
  assert.equal(submission.message.target_project_source, 'request_project');
  assert.match(submission.message.prompt, /source: runner_ui_global_composer/);
  assert.match(submission.message.prompt, /provenance="runner_ui_page_context"/);
  assert.match(submission.message.prompt, /work_id="xw:work:issues:698"/);
  assert.match(submission.message.prompt, /never grants authority/);
  assert.match(submission.message.prompt, /分析失败原因$/);
});

test('conflicting mentions never choose an implicit project winner', () => {
  const suggestions = buildGlobalComposerSuggestions(projects, works);
  const alphaWork = suggestions.find(item => item.reference?.id === 'xw:work:issues:698').reference;
  const betaProject = suggestions.find(item => item.reference?.id === 'beta').reference;
  const submission = buildGlobalComposerSubmission({
    prompt: '比较这两个上下文',
    references: [alphaWork, betaProject],
  });

  assert.equal(submission.conversation.project_id, '');
  assert.equal('target_project_id' in submission.message, false);
  assert.match(submission.message.prompt, /id="xw:work:issues:698"/);
  assert.match(submission.message.prompt, /id="beta"/);
});
