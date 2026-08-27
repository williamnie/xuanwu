import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
const workbenchCss = readFileSync(new URL('../GeekWorkbench.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('./AppSidebar.jsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');

function ruleFor(selector, stylesheet = css) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = stylesheet.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test('sidebar project list fills remaining menu height', () => {
  const rule = ruleFor('.sidebar-project-list');

  assert.match(rule, /flex:\s*1\s+1\s+0/);
  assert.match(rule, /min-height:\s*0/);
  assert.doesNotMatch(rule, /max-height:\s*220px/);
});

test('collapsed sidebar navigation keeps accessible names when labels are visually hidden', () => {
  assert.match(source, /aria-label=\{navLabel\(item\)\}/);
  assert.match(source, /productNavigationItems\(\{ workBoardEnabled: WORK_BOARD_ENABLED \}\)/);
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
