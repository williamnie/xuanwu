import test from 'node:test';
import assert from 'node:assert/strict';
import { canOperateTaskRun } from './taskRunAuthority.js';
test('execution operations require exact task/run ownership and the current attempt', () => {
  const run={ id:'r1',work_id:'w1',attempts:[{id:'a1'},{id:'a2'}] };
  assert.equal(canOperateTaskRun(run,'w1','r1',{id:'a2'}),true);
  assert.equal(canOperateTaskRun(run,'w1','r1',{id:'a1'}),false);
  assert.equal(canOperateTaskRun(run,'w2','r1',{id:'a2'}),false);
  assert.equal(canOperateTaskRun(run,'w1','r2',{id:'a2'}),false);
  assert.equal(canOperateTaskRun(run,'','r1',{id:'a2'}),false);
});
