import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../components/AppSidebar.jsx', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../api/client.js', import.meta.url), 'utf8');
const pageUrl = new URL('./PurchaseCredits.jsx', import.meta.url);
const cssUrl = new URL('./PurchaseCredits.css', import.meta.url);
const pageSource = existsSync(pageUrl) ? readFileSync(pageUrl, 'utf8') : '';
const cssSource = existsSync(cssUrl) ? readFileSync(cssUrl, 'utf8') : '';

test('More Credits is routed from the personal sidebar area', () => {
  assert.ok(existsSync(pageUrl), 'PurchaseCredits.jsx should exist');
  assert.match(appSource, /import PurchaseCredits from '\.\/pages\/PurchaseCredits'/);
  assert.match(appSource, /currentPage === 'purchase-credits'/);
  assert.match(sidebarSource, /More Credits/);
  assert.match(sidebarSource, /navigateTo\('purchase-credits'\)/);
  assert.match(sidebarSource, /sidebar-profile-links/);
  assert.ok(sidebarSource.indexOf('More Credits') < sidebarSource.indexOf('Archived Chats'));
});

test('Purchase Credits client reserves movo-web payment endpoints', () => {
  assert.match(clientSource, /getPaymentCatalog/);
  assert.match(clientSource, /createPaymentPurchase/);
  assert.match(clientSource, /\/api\/v1\/payments\/catalog/);
  assert.match(clientSource, /\/api\/v1\/payments\/purchases/);
  assert.match(clientSource, /Idempotency-Key/);
});

test('Purchase Credits page lists packs and keeps checkout placeholder safe', () => {
  assert.match(pageSource, /function PurchaseCredits/);
  assert.match(pageSource, /DEFAULT_CREDIT_PACKS/);
  assert.match(pageSource, /api\.getPaymentCatalog/);
  assert.match(pageSource, /api\.createPaymentPurchase/);
  assert.match(pageSource, /checkout_url/);
  assert.match(pageSource, /Apple Pay/);
  assert.match(pageSource, /pending_purchase_attempt_id/);
  assert.match(pageSource, /window\.history\.pushState/);
  assert.doesNotMatch(pageSource, /window\.confirm|window\.alert/);
});

test('Purchase Credits page follows the account modal credit CTA treatment', () => {
  assert.match(cssSource, /\.purchase-credits-shell/);
  assert.match(cssSource, /background:\s*linear-gradient\(90deg,\s*#1be164,\s*#4ade80\)/);
  assert.match(cssSource, /\.purchase-credit-card/);
  assert.match(cssSource, /background:\s*#17171d/);
  assert.match(cssSource, /border-radius:\s*18px/);
  assert.match(cssSource, /\.purchase-credit-buy/);
});
