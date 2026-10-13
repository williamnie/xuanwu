import assert from 'node:assert/strict';
import test from 'node:test';
import { workStatusActions, workBlockReason } from './workActions.js';
import { WORK_BOARD_STATUSES, workDropOperation } from '../workBoardModel.js';
import { workAvailableActions } from '../workDetailModel.js';

test('every allowed board movement has exactly one corresponding explicit list action', () => {
  for (const status of WORK_BOARD_STATUSES) {
    const actions = workStatusActions(status);
    for (const target of WORK_BOARD_STATUSES) {
      const expected = workDropOperation(status, target);
      const matches = actions.filter(action => action.targets.includes(target));
      assert.equal(matches.length, ['none','blocked'].includes(expected) ? 0 : 1, `${status} -> ${target}`);
      if (matches.length) assert.equal(matches[0].operation,expected);
    }
    const available = workAvailableActions(status);
    assert.equal(available.start,actions.some(action=>action.operation==='enqueue'));
    assert.equal(available.retry,actions.some(action=>action.operation==='retry'));
    assert.equal(available.cancel,actions.some(action=>action.operation==='cancel'));
  }
});
test('blockers use explicit facts; unknown readiness does not invent schedulability', () => {
  assert.equal(workBlockReason({status:'todo',effective_provider:'codex',scheduling:{tool:{submittable:null},dependency:{ready:true,readiness:{status:'not_required'}}}},{auto_run:1}), '');
  assert.equal(workBlockReason({status:'todo',scheduling:{dependency:{ready:false,waiting_reason:'等待任务 #4'}}},{}),'等待任务 #4');
  assert.equal(workBlockReason({scheduling:{tool:{submittable:false,readiness_reason:'未登录'}}},{}),'编程工具未就绪：未登录');
  assert.equal(workBlockReason({}, {hold:{message:'额度耗尽'}}),'项目已暂停：额度耗尽');
});
