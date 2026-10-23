import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { appHashForRoute, appRouteFromHash } from '../appRouteModel.js';
import { PRODUCT_NAV_ITEMS } from './assistantModules.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('analytics can be opened, bookmarked and restored without falling back to home', () => {
  assert.equal(appRouteFromHash('#/analytics').currentPage, 'analytics');
  assert.equal(appHashForRoute({ currentPage: 'analytics' }), '#/analytics');
  assert.ok(PRODUCT_NAV_ITEMS.some(item => item.page === 'analytics'));
});

test('home prioritizes action and progress without querying diagnostic or usage feeds', () => {
  const home = read('./Dashboard.jsx');
  assert.match(home, /<TaskRequestsSection/);
  assert.match(home, /<AttentionSection/);
  assert.match(home, /<ActiveWorkSection/);
  assert.match(home, /<RecentDeliveriesSection/);
  assert.doesNotMatch(home, /DeliveryEffectivenessSection|CodexUsagePanel|eventsApi|JSON\.stringify/);
  assert.ok(home.indexOf('<TaskRequestsSection') < home.indexOf('<AttentionSection'));
  assert.ok(home.indexOf('<AttentionSection') < home.indexOf('<ActiveWorkSection'));
  // 方案 5.3：删除顶部 4 个统计数字和底部 4 个跳转链接；“交给玄武”改为新建任务。
  assert.doesNotMatch(home, /dashboard-facts|dashboard-links|交给玄武/);
  assert.match(home, /<WorkEditorDialog/);
});

test('page changes keep the revealed Suspense content and do not replay entry motion', () => {
  assert.match(read('../App.jsx'), /startPageTransition\(\(\) => updateAppState/);
  assert.match(read('../App.jsx'), /mainContentRef\.current\.scrollTop = 0/);
  assert.match(read('../App.css'), /\.main-content > \.animate-fade-in\s*\{\s*animation: none;/);
});
