import { readAppSource } from '../../test-support/readAppSource.js';
import { readStylesheet } from '../../test-support/readStylesheet.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readStylesheet(new URL('../index.css', import.meta.url));
const workbenchCss = readFileSync(new URL('../GeekWorkbench.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('./AppSidebar.jsx', import.meta.url), 'utf8');
const appSource = readAppSource();

function ruleFor(selector, stylesheet = css) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = stylesheet.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test('collapsed sidebar navigation keeps accessible names when labels are visually hidden', () => {
  assert.match(source, /aria-label=\{navLabel\(item\)\}/);
  assert.match(source, /aria-label=\{theme === 'dark' \? t\('sidebar\.lightTheme'\) : t\('sidebar\.darkTheme'\)\}/);
});

test('sidebar API indicator only shows the connection state', () => {
  assert.match(source, /connectionState === 'reconnecting' \? 'RECONNECTING'/);
  assert.match(css, /\.api-status\.reconnecting\s*\{[^}]*color:\s*var\(--warning\)/);
  assert.doesNotMatch(source, /LOCAL API/);
});

test('sidebar footer keeps settings and theme as compact horizontal icons', () => {
  const actionsRule = ruleFor('.sidebar-footer-actions');
  const actionRule = ruleFor('.sidebar-footer-actions .nav-item');
  const workbenchActionRule = ruleFor('.sidebar-footer-actions .nav-item', workbenchCss);

  assert.match(actionsRule, /flex-direction:\s*row/);
  assert.match(actionRule, /flex:\s*0\s+0\s+34px/);
  assert.match(actionRule, /justify-content:\s*center/);
  assert.match(actionRule, /width:\s*34px/);
  assert.doesNotMatch(source, /sidebar-language-row|sidebar-version/);
  assert.match(source, /function FooterIcon/);
  assert.match(workbenchActionRule, /border-color:\s*transparent/);
});

test('mobile navigation uses an accessible off-canvas drawer instead of an unlabeled icon rail', () => {
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /max-width:\s*320px/);
  assert.match(css, /transform:\s*translateX\(-100%\)/);
  assert.match(css, /width:\s*88vw/);
  assert.match(css, /\.app-container\.mobile-sidebar-open \.sidebar\s*\{[^}]*transform:\s*translateX\(0\)/);
  assert.doesNotMatch(css, /\.sidebar \{ width: 84px/);
  assert.match(appSource, /useState\(false\)/);
  assert.match(appSource, /aria-controls="app-sidebar"/);
  assert.match(appSource, /event\.key === 'Escape'/);
  assert.match(appSource, /document\.body\.style\.overflow = 'hidden'/);
  assert.match(source, /aria-modal=\{isMobileViewport && mobileSidebarOpen/);
  assert.match(source, /inert=\{isMobileViewport && !mobileSidebarOpen/);
});

test('sidebar footer never shrinks under a long session list', () => {
  const sidebarCss = readFileSync(new URL('./AppSidebar.css', import.meta.url), 'utf8');
  assert.match(ruleFor('.sidebar-footer', sidebarCss), /flex-shrink:\s*0/);
  assert.doesNotMatch(sidebarCss, /nav-item-analytics/);
});

test('session list bleed stays inside the sidebar padding so no horizontal scrollbar covers the footer', () => {
  // 侧栏内边距 10px = 插槽外伸 4px + 滚动区外伸 6px；超出即出现横向滚动条压住底部设置
  const sessionsCss = readStylesheet(new URL('../pages/sessions/SessionsClient.css', import.meta.url));
  const piChatCss = readFileSync(new URL('../pages/PiChatSidebar.css', import.meta.url), 'utf8');
  assert.match(ruleFor('.sidebar', workbenchCss), /padding:\s*var\(--space-4\)\s+var\(--space-2-5\)/);
  assert.match(ruleFor('.sessions-app-sidebar-slot', sessionsCss), /margin:\s*var\(--space-5\)\s+calc\(var\(--space-1\)\s*\*\s*-1\)\s+0/);
  assert.match(ruleFor('.sessions-app-sidebar-panel .sidebar-scroll-area', sessionsCss), /margin-right:\s*calc\(var\(--space-1-5\)\s*\*\s*-1\)/);
  assert.match(ruleFor('.pi-chat-app-sidebar-panel .sidebar-scroll-area', piChatCss), /margin-right:\s*calc\(var\(--space-1-5\)\s*\*\s*-1\)/);
});
