import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../../App.jsx', import.meta.url), 'utf8');
const appCss = readFileSync(new URL('../../App.css', import.meta.url), 'utf8');
const clientCss = readFileSync(new URL('./SessionsClient.css', import.meta.url), 'utf8');
const piChatCss = readFileSync(new URL('../PiChat.css', import.meta.url), 'utf8');

test('Sessions layout overrides stay scoped to the Runs page', () => {
  assert.match(appSource, /currentPage === 'runs' \? 'runs-page' : ''/);
  assert.match(clientCss, /\.in-sessions-page\.runs-page \.main-content\s*\{/);
  assert.match(clientCss, /\.in-sessions-page\.runs-page\.sidebar-collapsed \.main-content\s*\{/);
  assert.match(clientCss, /\.in-sessions-page\.runs-page\.sidebar-collapsed \.sidebar\s*\{/);
  assert.doesNotMatch(clientCss, /\.in-sessions-page \.main-content\s*\{/);
  assert.doesNotMatch(clientCss, /\.in-sessions-page\.sidebar-collapsed \.main-content\s*\{/);
});

test('Ask Xuanwu has no outer workspace gutter or card chrome', () => {
  assert.match(appSource, /currentPage === 'ask-xuanwu' \? 'ask-xuanwu-page' : ''/);
  assert.match(appCss, /\.ask-xuanwu-page \.main-content\s*\{[^}]*padding:\s*0/);
  assert.match(piChatCss, /\.pi-chat-page\s*\{[^}]*padding:\s*0/);
  assert.match(piChatCss, /\.pi-chat-main\.glass-card,[\s\S]*?\{[^}]*border:\s*0/);
  assert.match(piChatCss, /\.pi-chat-main\.glass-card,[\s\S]*?\{[^}]*border-radius:\s*0/);
  assert.match(piChatCss, /\.pi-chat-main\.glass-card,[\s\S]*?\{[^}]*box-shadow:\s*none/);
});
