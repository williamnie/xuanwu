import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./CodexUsagePanel.jsx', import.meta.url), 'utf8');

test('AI usage dashboard keeps one provider compact and diagnostics collapsed', () => {
  const providerPosition = source.indexOf('<ProviderUsageRow');
  const detailsPosition = source.indexOf('<UsageDetails');

  assert.ok(providerPosition >= 0, 'missing selected provider summary');
  assert.ok(detailsPosition > providerPosition, 'usage diagnostics should follow provider summary');
  assert.match(source, /AI 用量/);
  assert.match(source, /查看用量详情/);
  assert.match(source, /providers\.length > 1/);
  assert.match(source, /selectedUsageProvider/);
  assert.doesNotMatch(source, /USAGE_LIMITS/);
  assert.doesNotMatch(source, /最近 50 条/);
  assert.doesNotMatch(source, /统计源：/);
});

test('refresh icon visibly spins while usage is loading', () => {
  assert.match(source, /<RefreshCw[^>]*className=\{loading \? 'animate-spin' : ''\}/);
  assert.match(source, /loading \? '刷新中' : '刷新'/);
});

test('dashboard keeps PI total separate and removes seven-day charts', () => {
  assert.match(source, /PI 今日总消耗/);
  assert.match(source, /Runner PI 会话/);
  assert.doesNotMatch(source, /最近 7 天|DailyBars|UsageBar/);
});
