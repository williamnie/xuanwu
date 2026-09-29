import test from 'node:test';
import assert from 'node:assert/strict';
import { effectivenessFacts, costFacts, overheadFacts, currencySubtotal, metricMoney, metricMinutes, deliveryRange } from './deliveryEffectivenessModel.js';
test('missing numbers stay unknown, measured zero survives and SDK estimates remain separate', () => {
  assert.equal(metricMoney(null), '未知');
  assert.equal(metricMoney({ status: 'unknown', amount_micros: 0 }), '未知');
  assert.equal(metricMoney({ status: 'known', currency: 'USD', amount_micros: 0 }), 'USD 0.0000');
  assert.equal(metricMinutes(null), '未知');
  assert.equal(metricMinutes(0), '0 分钟');
  assert.match(effectivenessFacts({})[2].detail, /未知/);
  assert.equal(overheadFacts({})[4].value, '未知');
  const facts = overheadFacts({ supervisor: { reflection: { known_cost_usd: 0, cost_known_attempts: 1, partial_attempts: 1 } } });
  assert.equal(facts[4].value, 'USD 0.0000');
  assert.match(facts[4].detail, /1 条部分回执/);
  assert.equal(facts[5].value, '未知');
  assert.deepEqual(deliveryRange(7, new Date('2026-09-29T00:00:00.000Z')), { from: '2026-09-23T00:00:00.000Z', to: '2026-09-29T23:59:59.999Z' });
});

test('help coverage uses the API intervention record without implying unattended delivery', () => {
  const missing = effectivenessFacts({}).find(fact => fact.label === '请求协助的任务');
  assert.equal(missing.value, '未知');
  assert.match(missing.detail, /任务数未知/);
  assert.doesNotMatch(missing.detail, /未知 个/);
  const measured = effectivenessFacts({ help_requested_works: 0, intervention: { no_help_record_works: 25 } })
    .find(fact => fact.label === '请求协助的任务');
  assert.equal(measured.value, 0);
  assert.match(measured.detail, /25 个任务无求助记录/);
  assert.match(measured.detail, /不代表没有人工介入/);
});

test('delivery facts describe recorded verification rather than human acceptance', () => {
  const facts = effectivenessFacts({ delivery_rate: 0.5, delivered_works: 1, sampled_works: 2 });
  assert.equal(facts[0].label, '交付验证通过率');
  assert.equal(facts[0].value, '50%');
  assert.match(facts[0].detail, /1 \/ 2 个结束任务已完成且交付、验证记录齐全/);
  assert.doesNotMatch(facts.map(fact => `${fact.label} ${fact.detail}`).join(' '), /验收通过/);
});

test('execution subtotal includes separate currencies and preserves unknown versus recorded zero', () => {
  assert.equal(currencySubtotal(null), '未知');
  assert.equal(currencySubtotal({ by_currency: [] }), '未知');
  const execution_cost = { known_works: 2, by_currency: [{ currency: 'USD', amount_micros: 0 }, { currency: 'CNY', amount_micros: 1500000 }] };
  assert.equal(currencySubtotal(execution_cost), 'USD 0.0000 / CNY 1.5000');
  const facts = costFacts({ sampled_works: 3, execution_cost, cost: { known_works: 1, unknown_works: 1, by_currency: [{ currency: 'USD', mean_micros: 0 }] } });
  assert.equal(facts[0].value, 'USD 0.0000 / CNY 1.5000');
  assert.match(facts[0].detail, /2 \/ 3 个结束任务/);
  assert.equal(facts[1].value, 'USD 0.0000');
  assert.match(facts[1].detail, /1 个未知/);
});
