import assert from 'node:assert/strict';
import test from 'node:test';
import { translate } from '../../i18n/translations.js';
import { inboxFailure, taskRequestCards } from './taskRequestsModel.js';

const work = (id, extra = {}) => ({ id: `xw:work:issues:${id}`, title: `Task ${id}`, ...extra });
const t = key => translate('zh-CN', key);
const review = (id, extra = {}) => ({ key: `human_review:req-${id}`, source: 'human_review', actionable: true, work: work(id), request: { id: `req-${id}`, kind: 'decision', status: 'open', revision: 2 }, review_request_id: `req-${id}`, review_revision: 2, ...extra });

test('only open human review entries become answerable cards and preparation stays read-only', () => {
  const cards = taskRequestCards([
    review(1), { key: 'preparing:2', source: 'preparing', work: work(2), actionable: false },
    review(3, { request: { status: 'answered' } }), review(4, { request: null }),
  ], t);
  assert.deepEqual(cards.map(card => card.kind), ['review', 'preparing', 'preparing', 'preparing']);
  assert.equal(cards[0].key, 'human_review:req-1');
  assert.deepEqual({ id: cards[0].request.id, revision: cards[0].request.revision }, { id: 'req-1', revision: 2 });
  assert.match(cards[1].detail, /玄武正在整理问题/);
  assert.match(cards[3].detail, /玄武正在整理问题/);
  assert.ok(cards.slice(1).every(card => !card.retry && !card.request));
});

test('failed tasks use the existing action table, with independent source keys and server ordering', () => {
  const failed = work(1, { status: 'failed', revision: 3 });
  const cards = taskRequestCards([
    review(1), { key: 'failed_work:1', source: 'failed_work', work: failed },
    { key: 'attention:1', source: 'attention', attention: { id: '1' } },
    { key: 'failed_work:5', source: 'failed_work', work: work(5, { status: 'done' }) },
  ], t);
  assert.deepEqual(cards.map(card => card.kind), ['review', 'failed', 'attention', 'failed']);
  assert.equal(new Set(cards.map(card => card.key)).size, cards.length);
  assert.equal(cards[1].tone, 'error'); assert.equal(cards[1].work, failed);
  assert.equal(cards[1].retry.id, 'retry'); assert.equal(cards[1].retry.target, 'in_progress');
  assert.equal(cards[3].retry, undefined);
});

test('each command source distinguishes stale, handled and expired results in both languages', () => {
  for (const language of ['zh-CN', 'en-US']) for (const source of ['review', 'task', 'attention', 'approval']) {
    const localize = key => translate(language, key);
    for (const [error, reason] of [[{ status: 409 }, 'changed'], [{ status: 404 }, 'handled'], [{ status: 409, message: 'already handled' }, 'handled'], [{ status: 410 }, 'expired'], [{ status: 409, message: 'approval expired' }, 'expired']]) {
      const result = inboxFailure(source, error, localize);
      assert.equal(result.invalidated, true);
      assert.equal(result.message, localize(`inbox.${source}.${reason}`));
      assert.ok(!result.message.startsWith('inbox.'));
    }
    assert.equal(inboxFailure(source, { status: 500 }, localize).invalidated, false);
  }
});
