import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('./SessionsClient.css', import.meta.url), 'utf8');
const appSidebar = readFileSync(new URL('../../components/AppSidebar.jsx', import.meta.url), 'utf8');
const sessionsPage = readFileSync(new URL('../Sessions.jsx', import.meta.url), 'utf8');
const sessionSidebar = readFileSync(new URL('./SessionSidebar.jsx', import.meta.url), 'utf8');
const piChatSidebarCss = readFileSync(new URL('../PiChatSidebar.css', import.meta.url), 'utf8');

function ruleFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test('sessions list is hosted in the app sidebar slot', () => {
  const slotRule = ruleFor('.sessions-app-sidebar-slot');
  const panelRule = ruleFor('.sessions-app-sidebar-panel');

  assert.match(appSidebar, /id="sessions-app-sidebar-slot"/);
  assert.match(sessionsPage, /<SessionSidebar/);
  assert.match(sessionSidebar, /return createPortal\(/);
  assert.match(sessionSidebar, /document\.getElementById\(SESSION_APP_SIDEBAR_SLOT_ID\)/);
  assert.match(slotRule, /flex:\s*1 1 auto/);
  assert.match(slotRule, /min-height:\s*0/);
  assert.match(panelRule, /flex-direction:\s*column/);
});

test('sessions no longer renders an inner resizable sidebar divider', () => {
  assert.doesNotMatch(sessionsPage, /sessions-client-sidebar/);
  assert.doesNotMatch(sessionsPage, /sessions-sidebar-resize-handle/);
  assert.doesNotMatch(sessionSidebar, /sessions-client-sidebar/);
  assert.doesNotMatch(sessionSidebar, /sessions-sidebar-resize-handle/);
  assert.doesNotMatch(css, /sessions-sidebar-resize-handle/);
  assert.doesNotMatch(css, /resizing-session-sidebar/);
});

test('mobile drawer keeps session and conversation lists reachable', () => {
  assert.match(css, /@media \(min-width: 761px\) and \(max-width: 960px\) \{[\s\S]*?\.sessions-app-sidebar-slot\s*\{[\s\S]*?display:\s*none/);
  assert.match(piChatSidebarCss, /@media \(min-width: 761px\) and \(max-width: 980px\) \{[\s\S]*?\.sessions-app-sidebar-slot\s*\{[\s\S]*?display:\s*none/);
  assert.doesNotMatch(css, /@media \(max-width: 960px\) \{\s*\.sessions-app-sidebar-slot\s*\{\s*display:\s*none/);
  assert.doesNotMatch(piChatSidebarCss, /@media \(max-width: 980px\) \{\s*\.sessions-app-sidebar-slot\s*\{\s*display:\s*none/);
});
