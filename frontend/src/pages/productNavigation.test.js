import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { PRODUCT_NAV_LABELS } from '../brand.js';
import {
  PRODUCT_COMPAT_ROUTE_REDIRECTS,
  PRODUCT_NAV_ITEMS,
  productNavigationItems,
  productNavPageForRoute,
  resolveProductPage,
} from './assistantModules.js';

const appSource = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../components/AppSidebar.jsx', import.meta.url), 'utf8');

const EXPECTED_PAGES = [
  'command-center',
  'ask-xuanwu',
  'work',
  'runs',
  'handoffs',
  'automations',
  'projects',
  'connections',
  'settings',
];

test('product navigation has one ordered Xuanwu identity and centralized labels', () => {
  assert.deepEqual(PRODUCT_NAV_ITEMS.map(item => item.page), EXPECTED_PAGES);
  assert.deepEqual(PRODUCT_NAV_ITEMS.map(item => item.label), Object.values(PRODUCT_NAV_LABELS));
  assert.equal(new Set(PRODUCT_NAV_ITEMS.map(item => item.page)).size, PRODUCT_NAV_ITEMS.length);
  assert.equal(new Set(PRODUCT_NAV_ITEMS.map(item => item.label)).size, PRODUCT_NAV_ITEMS.length);
  assert.deepEqual(new Set(PRODUCT_NAV_ITEMS.map(item => item.availability)), new Set(['available', 'compatibility']));
  assert.equal(PRODUCT_NAV_ITEMS.find(item => item.page === 'settings')?.placement, 'footer');
  assert.doesNotMatch(sidebarSource, /PI_ASSISTANT_NAV_ITEMS|PRODUCT_TERMS\.supervisor|pi-assistant-nav/);
});

test('feature availability hides Work when its existing compatibility flag is disabled', () => {
  assert.deepEqual(productNavigationItems({ workBoardEnabled: false }).map(item => item.page), EXPECTED_PAGES.filter(page => page !== 'work'));
  assert.equal(resolveProductPage('work', { workBoardEnabled: false }), 'issues');
  assert.equal(resolveProductPage('work', { workBoardEnabled: true }), 'work');
});

test('legacy page ids redirect into canonical product routes without replacing hidden detail routes', () => {
  assert.deepEqual(PRODUCT_COMPAT_ROUTE_REDIRECTS, {
    dashboard: 'command-center',
    'pi-chat': 'ask-xuanwu',
    sessions: 'runs',
    cron: 'automations',
    'pi-automations': 'automations',
    'pi-approvals': 'command-center',
    'pi-connectors': 'connections',
  });
  for (const [legacyPage, canonicalPage] of Object.entries(PRODUCT_COMPAT_ROUTE_REDIRECTS)) {
    assert.equal(resolveProductPage(legacyPage), canonicalPage);
  }
  assert.equal(resolveProductPage('issues'), 'issues');
  assert.equal(resolveProductPage('pi-inbox'), 'pi-inbox');
  assert.equal(productNavPageForRoute('issues'), 'work');
  assert.equal(productNavPageForRoute('pi-inbox'), 'command-center');
  assert.equal(productNavPageForRoute('pi-memory'), 'settings');
});

test('App routes canonical pages to the currently verified compatibility surfaces', () => {
  assert.match(appSource, /currentPage: initialHandoffRoute\?\.page \|\| 'command-center'/);
  assert.match(appSource, /resolveProductPage\(page, \{ workBoardEnabled: WORK_BOARD_ENABLED \}\)/);
  assert.match(appSource, /currentPage === 'command-center'[\s\S]*<Dashboard navigateTo=\{navigateTo\} \/>/);
  assert.match(appSource, /currentPage === 'ask-xuanwu'[\s\S]*<PiChat navigateTo=\{navigateTo\} initialConversationId=\{selectedPiConversationId\} \/>/);
  assert.match(appSource, /currentPage === 'automations'[\s\S]*<Automations \/>/);
  assert.match(appSource, /currentPage === 'connections'[\s\S]*initialTab="connectors"/);
});
