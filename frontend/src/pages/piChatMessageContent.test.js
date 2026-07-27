import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parsePiChatMessageContent,
  runnerContextModeLabel,
  runnerContextReferenceLabel,
} from './piChatMessageContent.js';
import { translate } from '../i18n/translations.js';

test('runner_ui_context is separated from the visible user request', () => {
  const segments = parsePiChatMessageContent(`<runner_ui_context>
source: runner_ui_global_composer
permission_mode: controlled
permission_note: runtime gates still apply
reference: type=page_context page_id="runs" route_ref="runs/run:769" run_id="xw:run:issue_runs:issue-769-attempt-1"
</runner_ui_context>

做完了么`);

  assert.equal(segments.length, 2);
  assert.equal(segments[0].type, 'runner_ui_context');
  assert.equal(segments[0].context.fields.permission_mode, 'controlled');
  assert.deepEqual(segments[0].context.references[0], {
    fields: {
      page_id: 'runs',
      route_ref: 'runs/run:769',
      run_id: 'xw:run:issue_runs:issue-769-attempt-1',
      type: 'page_context',
    },
    type: 'page_context',
  });
  assert.deepEqual(segments[1], { text: '做完了么', type: 'markdown' });
});

test('runner context labels turn internal fields into user-facing copy', () => {
  assert.equal(runnerContextModeLabel('controlled'), '受控操作');
  assert.equal(runnerContextModeLabel('read_only'), '只读上下文');
  assert.equal(runnerContextReferenceLabel({
    fields: { page_id: 'runs', run_id: 'xw:run:issue_runs:issue-769-attempt-1' },
    type: 'page_context',
  }), 'Runs · Run #769 / Attempt 1');
  assert.equal(runnerContextReferenceLabel({ fields: { id: 'xw:work:issues:769' }, type: 'work' }), 'Work #769');
});

test('runner context labels can render in English', () => {
  const t = (key, variables) => translate('en-US', key, variables);
  assert.equal(runnerContextModeLabel('controlled', t), 'Controlled action');
  assert.equal(runnerContextReferenceLabel({ fields: { id: 'demo' }, type: 'project' }, t), 'Project @demo');
});

test('plain Markdown remains a single untouched segment', () => {
  assert.deepEqual(parsePiChatMessageContent('**完成**\n\n- Evidence ready'), [
    { text: '**完成**\n\n- Evidence ready', type: 'markdown' },
  ]);
});
