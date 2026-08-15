import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../../App.jsx', import.meta.url), 'utf8');
const appCss = readFileSync(new URL('../../App.css', import.meta.url), 'utf8');
const clientCss = readFileSync(new URL('./SessionsClient.css', import.meta.url), 'utf8');

test('Sessions layout overrides stay scoped to the Runs page', () => {
  assert.match(appSource, /currentPage === 'runs' \? 'runs-page' : ''/);
  assert.match(clientCss, /\.in-sessions-page\.runs-page \.main-content\s*\{/);
  assert.match(clientCss, /\.in-sessions-page\.runs-page\.sidebar-collapsed \.main-content\s*\{/);
  assert.match(clientCss, /\.in-sessions-page\.runs-page\.sidebar-collapsed \.sidebar\s*\{/);
  assert.doesNotMatch(clientCss, /\.in-sessions-page \.main-content\s*\{/);
  assert.doesNotMatch(clientCss, /\.in-sessions-page\.sidebar-collapsed \.main-content\s*\{/);
});

test('Ask Xuanwu removes only the main workspace left gutter', () => {
  assert.match(appSource, /currentPage === 'ask-xuanwu' \? 'ask-xuanwu-page' : ''/);
  assert.match(appCss, /\.ask-xuanwu-page \.main-content\s*\{[^}]*padding-left:\s*0/);
  assert.doesNotMatch(appCss, /\.ask-xuanwu-page \.main-content\s*\{[^}]*padding:\s*0/);
});
