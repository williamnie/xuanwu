import test from 'node:test';
import assert from 'node:assert/strict';
import { inboxRefreshDecision } from './inboxRefreshModel.js';
test('provider logs and agent streams never refetch the complete inbox',()=>{
 for(const type of ['issue.log','issue.progress','pi.conversation.delta','pi.tool_call.completed']) assert.equal(inboxRefreshDecision(type,{loading:false,paged:false}),'ignore');
});
test('state changes notify while paging or loading instead of aborting or resetting the snapshot',()=>{
 for(const type of ['issue.status_changed','issue.human_review.requested.v1','pi.needs_user','pi.action_pending','approval.resolved']){
  assert.equal(inboxRefreshDecision(type,{loading:false,paged:false}),'refresh');
  assert.equal(inboxRefreshDecision(type,{loading:true,paged:false}),'notify');
  assert.equal(inboxRefreshDecision(type,{loading:false,paged:true}),'notify');
 }
});
