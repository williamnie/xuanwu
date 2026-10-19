import test from 'node:test';
import assert from 'node:assert/strict';
import { effectivenessFacts, diagnosticFacts, currencySubtotal, metricDuration, deliveryRange } from './deliveryEffectivenessModel.js';

test('missing numbers render as a dash while measured zero survives', () => {
  assert.equal(metricDuration(null), '—');
  assert.equal(metricDuration(0), '0 分钟');
  assert.equal(metricDuration(90 * 60000), '1.5 小时');
  assert.equal(metricDuration(72 * 3600000), '3.0 天');
  assert.ok(effectivenessFacts({}).every(fact => fact.value === '—'));
  assert.equal(effectivenessFacts({ help_requested_works: 0 })[2].value, 0);
  assert.equal(diagnosticFacts({}).find(fact => fact.label === '复盘费用').value, '—');
  assert.equal(diagnosticFacts({ supervisor: { reflection: { known_cost_usd: 0 } } }).find(fact => fact.label === '复盘费用').value, 'USD 0.00');
});

test('overview reports the whole range with delivery rate and counts', () => {
  const facts = effectivenessFacts({ sampled_works: 4, completed_works: 3, delivered_works: 2, delivery_rate: 0.5 });
  assert.deepEqual(facts.map(fact => fact.label), ['结束任务', '交付通过率', '请求协助', '完成用时中位数', '执行费用']);
  assert.equal(facts[0].value, 4);
  assert.match(facts[0].detail, /3 个已完成/);
  assert.equal(facts[1].value, '50%');
  assert.match(facts[1].detail, /2 \/ 4/);
});

test('currency subtotals keep currencies separate', () => {
  assert.equal(currencySubtotal(null), '—');
  assert.equal(currencySubtotal({ by_currency: [{ currency: 'USD', amount_micros: 0 }, { currency: 'CNY', amount_micros: 1500000 }] }), 'USD 0.00 / CNY 1.50');
});

test('ranges cover whole local days and never exceed the API window', () => {
  const now = new Date(2026, 8, 29, 15, 30);
  for (const days of [7, 30, 90]) {
    const { from, to } = deliveryRange(days, now);
    assert.equal(new Date(to).getTime(), new Date(2026, 8, 30).getTime() - 1);
    assert.ok(Date.parse(to) - Date.parse(from) < days * 86400000);
    assert.ok(new Date(from) <= new Date(2026, 8, 29 - days + 1, 1));
  }
});
