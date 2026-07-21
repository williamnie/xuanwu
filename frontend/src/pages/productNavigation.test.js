import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
    issues: 'work',
    sessions: 'runs',
    cron: 'automations',
    'pi-automations': 'automations',
    'pi-approvals': 'command-center',
    'pi-connectors': 'connections',
    'attention-inbox': 'command-center',
    'pi-inbox': 'command-center',
  });
  for (const [legacyPage, canonicalPage] of Object.entries(PRODUCT_COMPAT_ROUTE_REDIRECTS)) {
    assert.equal(resolveProductPage(legacyPage), canonicalPage);
  }
  assert.equal(resolveProductPage('issues'), 'work');
  assert.equal(resolveProductPage('attention-inbox'), 'command-center');
  assert.equal(resolveProductPage('pi-inbox'), 'command-center');
  assert.equal(productNavPageForRoute('issues'), 'work');
  assert.equal(productNavPageForRoute('pi-inbox'), 'command-center');
  assert.equal(productNavPageForRoute('pi-memory'), 'settings');
});

test('App routes canonical pages to the currently verified compatibility surfaces', () => {
  assert.match(appSource, /currentPage: initialHandoffRoute\?\.page \|\| 'command-center'/);
  assert.match(appSource, /resolveProductPage\(page, \{ workBoardEnabled: WORK_BOARD_ENABLED \}\)/);
  assert.match(appSource, /recordLegacyRoute\(\{ family: page, target: resolvedPage \}\)/);
  assert.match(appSource, /workIdFromIssueId\(issueId\)/);
  assert.match(appSource, /currentPage === 'command-center'[\s\S]*<Dashboard navigateTo=\{navigateTo\} \/>/);
  assert.match(appSource, /currentPage === 'ask-xuanwu'[\s\S]*<PiChat navigateTo=\{navigateTo\} initialConversationId=\{selectedPiConversationId\} \/>/);
  assert.match(appSource, /currentPage === 'automations'[\s\S]*<Automations \/>/);
  assert.match(appSource, /const Connections = lazy\(\(\) => import\('\.\/pages\/Connections'\)\)/);
  assert.match(appSource, /currentPage === 'connections'[\s\S]*<Connections \/>/);
  assert.doesNotMatch(appSource, /AttentionInbox|currentPage === 'attention-inbox'|currentPage === 'pi-inbox'/);
});

test('retired Inbox and Settings placeholders have no remaining frontend consumer', () => {
  for (const path of [
    './AttentionInbox.jsx',
    './AttentionInbox.css',
    './AssistantSettingsPlaceholders.jsx',
  ]) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false);
  }

  const sectionsSource = readFileSync(new URL('./AssistantSettingsSections.jsx', import.meta.url), 'utf8');
  const workDetailSource = readFileSync(new URL('./WorkDetail.jsx', import.meta.url), 'utf8');
  const assistantApiSource = readFileSync(new URL('../api/assistant.js', import.meta.url), 'utf8');
  assert.doesNotMatch(sectionsSource, /SettingsPlaceholderPanel|AssistantSettingsPlaceholders/);
  assert.match(workDetailSource, /navigateTo\('command-center'\)/);
  assert.doesNotMatch(workDetailSource, /navigateTo\('attention-inbox'\)/);
  for (const retiredMutation of [
    'updatePiAttentionItem',
    'ignorePiAttentionItem',
    'reintakePiAttentionItem',
    'startPiAttentionDomainSkill',
    'approvePiActionProposal',
    'rejectPiActionProposal',
  ]) {
    assert.doesNotMatch(assistantApiSource, new RegExp(retiredMutation));
  }
});
