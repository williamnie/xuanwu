import test from 'node:test';
import assert from 'node:assert/strict';
import { effectivenessFacts, overheadFacts, metricMoney, metricMinutes, deliveryRange } from './deliveryEffectivenessModel.js';
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
