import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../components/AppSidebar.jsx', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../api/client.js', import.meta.url), 'utf8');
const pageUrl = new URL('./ArchivedChats.jsx', import.meta.url);
const cssUrl = new URL('./ArchivedChats.css', import.meta.url);
const pageSource = existsSync(pageUrl) ? readFileSync(pageUrl, 'utf8') : '';
const cssSource = existsSync(cssUrl) ? readFileSync(cssUrl, 'utf8') : '';

test('Archived Chats is routed from the personal sidebar area', () => {
  assert.ok(existsSync(pageUrl), 'ArchivedChats.jsx should exist');
  assert.match(appSource, /import ArchivedChats from '\.\/pages\/ArchivedChats'/);
  assert.match(appSource, /currentPage === 'archived-chats'/);
  assert.match(sidebarSource, /Archived Chats/);
  assert.match(sidebarSource, /navigateTo\('archived-chats'\)/);
  assert.match(sidebarSource, /sidebar-profile-link/);
  assert.ok(sidebarSource.indexOf('sidebar-profile-link') < sidebarSource.indexOf("currentPage === 'dashboard'"));
});

test('Archived Chats client uses cursor pagination and restore endpoint', () => {
  assert.match(clientSource, /getArchivedPiConversations/);
  assert.match(clientSource, /page_size/);
  assert.match(clientSource, /cursor/);
  assert.match(clientSource, /restorePiConversation/);
  assert.match(clientSource, /\/api\/pi\/conversations\/archived/);
  assert.match(clientSource, /\/api\/pi\/conversations\/\$\{encodeURIComponent\(id\)\}\/restore/);
});

test('Archived Chats page performs scroll loading without window alerts', () => {
  assert.match(pageSource, /function ArchivedChats/);
  assert.match(pageSource, /useArchivedScrollLoader/);
  assert.match(pageSource, /requestAnimationFrame/);
  assert.match(pageSource, /nextCursor/);
  assert.match(pageSource, /PAGE_SIZE/);
  assert.match(pageSource, /Unarchive/);
  assert.match(pageSource, /api\.restorePiConversation/);
  assert.doesNotMatch(pageSource, /window\.confirm|window\.alert/);
});

test('Archived Chats page follows the compact Figma row treatment', () => {
  assert.match(cssSource, /\.archived-chat-list/);
  assert.match(cssSource, /gap:\s*20px/);
  assert.match(cssSource, /\.archived-chat-row/);
  assert.match(cssSource, /background:\s*#17171d/);
  assert.match(cssSource, /border-radius:\s*12px/);
  assert.match(cssSource, /\.archived-chat-unarchive/);
});
