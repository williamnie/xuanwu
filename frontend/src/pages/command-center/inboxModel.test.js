import assert from 'node:assert/strict';
import test from 'node:test';
import { humanReviewPayload, providerApprovalPayload, proposalDecisionPayload, piActionDecisionPayload, mergeInboxPages, reviewConflictMessage } from './inboxModel.js';

test('human review keeps request id, revision and verbatim comment on its own contract',()=>{
  const comment='  请保留缩进\n\n修改第二点  ';const request={id:'review-1',revision:4};
  assert.equal(humanReviewPayload(request,'request_changes',comment).comment,comment);
  assert.equal(humanReviewPayload(request,'accept').review_request_id,'review-1');
  assert.equal(humanReviewPayload(request,'accept').review_revision,4);
  assert.throws(()=>humanReviewPayload(request,'reject','  '));assert.throws(()=>humanReviewPayload(request,'approve'));
});
test('attention adapters do not invent uniform revisions or broaden provider approval scope',()=>{
  const provider=providerApprovalPayload({kind:'provider_approval',ref:'approval:a'});assert.equal(provider.scope,'turn');assert.equal(provider.expected_revision,undefined);
  const proposal=proposalDecisionPayload({kind:'proposal',ref:'proposal:p'});assert.equal(proposal.scope,undefined);assert.equal(proposal.review_request_id,undefined);
  const action=piActionDecisionPayload({kind:'pi_action',ref:'pi_action:x'},'拒绝');assert.equal(action.comment,'拒绝');assert.equal(action.expected_revision,undefined);
  assert.throws(()=>proposalDecisionPayload({kind:'pi_action',ref:'x'}));
});
test('pagination deduplicates original request references without merging by work id',()=>{
  const a={key:'human:r1',work_id:'same'},b={key:'attention:proposal:p',work_id:'same'};
  assert.equal(mergeInboxPages([a],[b,a]).length,2);
});
test('review conflicts distinguish updated content and retired requests',()=>{
  const before={id:'a',revision:2};assert.match(reviewConflictMessage(before,{decision:{owner:'human',request:{id:'a',revision:3,status:'open'}}}),/内容已更新/);assert.match(reviewConflictMessage(before,{decision:{owner:'pi',request:null}}),/已处理或失效/);
});
