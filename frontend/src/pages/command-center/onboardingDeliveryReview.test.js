import test from 'node:test';
import assert from 'node:assert/strict';
import { openDeliveryReview } from './onboardingDeliveryReview.js';
import { effectivenessFacts } from './deliveryEffectivenessModel.js';
const work = { id: 'xw:work:issues:1', owner: { project_id: 'demo' } };

test('review binds the original Work and reopens persisted conversation without replaying a message', async () => {
  let stored = null;
  const sent = [];
  const opened = [];
  const api = {
    getPiConversations: async () => stored ? [stored] : [],
    createPiConversation: async value => (stored = { ...value, id: 'review-1' }),
    sendPiConversationMessage: async (id, body) => { sent.push({ id, body }); throw new Error('stream interrupted'); },
  };
  await assert.rejects(openDeliveryReview(work, api, id => opened.push(id)), /interrupted/);
  await openDeliveryReview(work, api, id => opened.push(id));
  assert.equal(sent.length, 1);
  assert.deepEqual(opened, ['review-1', 'review-1']);
  assert.equal(sent[0].body.target_project_id, 'demo');
  assert.match(sent[0].body.prompt, /xw:work:issues:1/);
  assert.match(sent[0].body.prompt, /不修改项目文件/);
});

test('metrics preserve unknown costs and do not add currencies together', () => {
  const data = { sampled_works: 0, delivered_works: 0, help_requested_works: 0, delivery_rate: null,
    duration: { median_ms: null }, cost: { unknown_works: 2 } };
  assert.equal(effectivenessFacts(data)[0].value, '—');
  assert.equal(effectivenessFacts(data).at(-1).value, '未知');
  data.cost.by_currency = [{ currency: 'USD', mean_micros: 0 }, { currency: 'CNY', mean_micros: 1000000 }];
  assert.equal(effectivenessFacts(data).at(-1).value, 'USD 0.0000 / CNY 1.0000');
});
