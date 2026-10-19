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
    duration: { median_ms: null }, execution_cost: { known_works: 0, by_currency: [] } };
  assert.equal(effectivenessFacts(data)[1].value, '—');
  assert.equal(effectivenessFacts(data).at(-1).value, '—');
  data.execution_cost.by_currency = [{ currency: 'USD', amount_micros: 0 }, { currency: 'CNY', amount_micros: 1000000 }];
  assert.equal(effectivenessFacts(data).at(-1).value, 'USD 0.00 / CNY 1.00');
});
