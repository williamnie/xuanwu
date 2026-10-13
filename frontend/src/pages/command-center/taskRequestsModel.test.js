import assert from 'node:assert/strict';
import test from 'node:test';

import { taskRequestCards } from './taskRequestsModel.js';

const work = (id, extra = {}) => ({ id: `xw:work:issues:${id}`, title: `Task ${id}`, ...extra });

test('only open human-owned requests become answerable review cards', () => {
  const decisions = new Map([
    [work(1).id, { owner: 'human', request: { id: 'req-1', kind: 'decision', status: 'open' } }],
    [work(2).id, { owner: 'pi', phase: 'pi_deciding' }],
    [work(3).id, { owner: 'human', request: { id: 'req-3', kind: 'acceptance', status: 'answered' } }],
  ]);
  const cards = taskRequestCards({ decisions, needsUser: [work(1), work(2), work(3), work(4)] });
  assert.deepEqual(cards.map(card => card.kind), ['review', 'preparing', 'preparing', 'preparing']);
  assert.equal(cards[0].key, 'review:req-1');
  assert.match(cards[1].detail, /玄武正在整理/);
  assert.match(cards[3].detail, /暂时读不到请求详情/);
});

test('failed tasks become retry cards and keys never collide across sources', () => {
  const cards = taskRequestCards({
    decisions: new Map([[work(1).id, { owner: 'human', request: { id: 'req-1', kind: 'decision', status: 'open' } }]]),
    failed: [work(1, { revision: 3 }), work(5, { revision: 1 })],
    needsUser: [work(1)],
  });
  assert.deepEqual(cards.map(card => card.kind), ['review', 'failed', 'failed']);
  assert.equal(new Set(cards.map(card => card.key)).size, cards.length);
  assert.equal(cards[1].tone, 'error');
});
