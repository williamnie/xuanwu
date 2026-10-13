import assert from 'node:assert/strict';
import test from 'node:test';

import { WORK_BOARD_STATUSES, workDropOperation } from '../workBoardModel.js';
import { workRowActions } from './workActions.js';

test('every list row action is a drag the board already allows', () => {
  for (const status of WORK_BOARD_STATUSES) {
    for (const action of workRowActions(status)) {
      const operation = workDropOperation(status, action.target);
      assert.notEqual(operation, 'blocked', `${status} -> ${action.target}`);
      assert.notEqual(operation, 'none', `${status} -> ${action.target}`);
    }
  }
});

test('list rows expose the same gated operations as board drags', () => {
  const operations = status => workRowActions(status).map(action => workDropOperation(status, action.target));
  assert.deepEqual(operations('triage'), ['enqueue', 'cancel']);
  assert.deepEqual(operations('todo'), ['enqueue', 'update', 'cancel']);
  assert.deepEqual(operations('in_progress'), ['retry', 'cancel']);
  assert.deepEqual(operations('needs_user'), ['cancel']);
  assert.deepEqual(operations('failed'), ['retry', 'update', 'cancel']);
  assert.deepEqual(workRowActions('done'), []);
  assert.deepEqual(workRowActions('cancelled'), []);
});

test('destructive and interrupting actions require confirmation', () => {
  for (const status of WORK_BOARD_STATUSES) {
    for (const action of workRowActions(status)) {
      if (action.target === 'cancelled' || status === 'in_progress') assert.equal(action.confirm, true, `${status}:${action.id}`);
    }
  }
});
