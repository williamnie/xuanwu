import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
const workbenchCss = readFileSync(new URL('../GeekWorkbench.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('./AppSidebar.jsx', import.meta.url), 'utf8');

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
  for (const label of ['Dashboard', 'Sessions', 'Issues', 'Cron', 'Projects']) {
    assert.match(source, new RegExp(`aria-label="${label}"`));
  }
  assert.match(source, /aria-label=\{module\.label\}/);
  assert.match(source, /aria-label=\{PI_ASSISTANT_SETTINGS_ITEM\.label\}/);
  assert.match(source, /aria-label=\{theme === 'dark' \? 'Light theme' : 'Dark theme'\}/);
});

test('sidebar API indicator only shows the connection state', () => {
  assert.match(source, /backendOnline \? 'ONLINE' : 'OFFLINE'/);
  assert.doesNotMatch(source, /LOCAL API/);
});

test('sidebar footer tools use unobtrusive full-width navigation rows', () => {
  const actionsRule = ruleFor('.sidebar-footer-actions');
  const actionRule = ruleFor('.sidebar-footer-actions .nav-item');
  const workbenchActionRule = ruleFor('.sidebar-footer-actions .nav-item', workbenchCss);

  assert.match(actionsRule, /flex-direction:\s*column/);
  assert.match(actionRule, /justify-content:\s*flex-start/);
  assert.doesNotMatch(actionRule, /flex:\s*1\s+1\s+0/);
  assert.doesNotMatch(actionRule, /padding-left|padding-right/);
  assert.match(workbenchActionRule, /border-color:\s*transparent/);
});
