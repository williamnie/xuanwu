import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRunnerCommandRequest,
  clearSessionCommandState,
  commandRequiresConfirmation,
  commandTargetSummary,
  createSessionCommandState,
  validateSessionCommand,
} from './sessionCommands.js';

test('selects slash command into structured command state', () => {
  const state = createSessionCommandState({ name: 'status', args: { issue_id: 86 } });

  assert.deepEqual(state, { name: 'status', args: { issue_id: 86 }, target: null });
  assert.equal(clearSessionCommandState(), null);
});

test('builds status command payload from attached issue reference', () => {
  const state = createSessionCommandState({ name: 'status' });
  const payload = buildRunnerCommandRequest(state, {
    prompt: '',
    references: [{ type: 'issue', id: '86', label: 'Composer v2' }],
  });

  assert.deepEqual(payload.command, { name: 'status', args: { issue_id: 86 } });
  assert.equal(commandTargetSummary(state, { references: [{ type: 'issue', id: '86', label: 'Composer v2' }] }), '#86 Composer v2');
});

test('run command requires confirmation and cancel keeps null command state', () => {
  const state = createSessionCommandState({ name: 'run' });
  const context = { prompt: '#93', references: [] };

  assert.equal(commandRequiresConfirmation(state), true);
  assert.equal(validateSessionCommand(state, context), '');
  assert.deepEqual(buildRunnerCommandRequest(state, context).command, { name: 'run', args: { issue_id: 93 } });
  assert.deepEqual(buildRunnerCommandRequest(state, context, { confirmed: true }).command, { name: 'run', args: { issue_id: 93, confirmed: true } });
  assert.equal(clearSessionCommandState(), null);
});

test('command payload preserves structured references for backend execution', () => {
  const state = createSessionCommandState({ name: 'issue' });
  const payload = buildRunnerCommandRequest(state, {
    prompt: '请根据附件创建 issue',
    projectId: 'runner',
    references: [
      { type: 'file', path: 'frontend/src/pages/Sessions.jsx', label: 'Sessions.jsx' },
      { type: 'issue', id: '91', label: '@file support' },
    ],
  });

  assert.deepEqual(payload.references, [
    { type: 'file', path: 'frontend/src/pages/Sessions.jsx', label: 'Sessions.jsx' },
    { type: 'issue', id: '91', label: '@file support' },
  ]);
  assert.equal(payload.command.args.project_id, 'runner');
  assert.equal(payload.command.args.prompt, '请根据附件创建 issue');
});

test('issue command creates triage draft payload with project and source session', () => {
  const state = createSessionCommandState({ name: 'issue' });
  const payload = buildRunnerCommandRequest(state, {
    prompt: '修复 slash command',
    projectId: 'runner',
    sessionId: 'codex:thread-1',
    references: [{ type: 'issue', id: '86' }],
  });

  assert.equal(validateSessionCommand(state, { prompt: 'draft', projectId: 'runner' }), '');
  assert.equal(payload.command.name, 'issue');
  assert.equal(payload.command.args.project_id, 'runner');
  assert.equal(payload.command.args.source_session_id, 'codex:thread-1');
  assert.equal(payload.command.args.prompt, '修复 slash command');
  assert.equal(payload.references[0].id, '86');
});
