import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./CodexUsagePanel.jsx', import.meta.url), 'utf8');

test('Codex usage dashboard prioritizes limits and keeps diagnostics collapsed', () => {
  const limitsPosition = source.indexOf('<LimitGrid');
  const detailsPosition = source.indexOf('<UsageDetails');

  assert.ok(limitsPosition >= 0, 'missing primary rate limit summary');
  assert.ok(detailsPosition > limitsPosition, 'usage diagnostics should follow rate limits');
  assert.match(source, /查看用量详情/);
  assert.doesNotMatch(source, /USAGE_LIMITS/);
  assert.doesNotMatch(source, /最近 50 条/);
  assert.doesNotMatch(source, /统计源：/);
});

test('refresh icon visibly spins while usage is loading', () => {
  assert.match(source, /<RefreshCw[^>]*className=\{loading \? 'animate-spin' : ''\}/);
  assert.match(source, /loading \? '刷新中' : '刷新'/);
});

test('dashboard separates PI daily usage from the global Codex session total', () => {
  assert.match(source, /PI 今日消耗/);
  assert.match(source, /PI 每日 Token（最近 7 天）/);
  assert.match(source, /PI 最近 7 天/);
  assert.match(source, /piUsage\?\.summary\?\.today\?\.total_tokens/);
});
