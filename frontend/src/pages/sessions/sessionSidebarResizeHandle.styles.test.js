import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('./SessionsClient.css', import.meta.url), 'utf8');

function ruleFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test('session sidebar resize boundary renders one visible divider line', () => {
  const sidebarRule = ruleFor('.sessions-client-sidebar');
  const darkSidebarRule = ruleFor('[data-theme="dark"] .sessions-client-sidebar');
  const handleRule = ruleFor('.sessions-sidebar-resize-handle');
  const lineRule = ruleFor('.sessions-sidebar-resize-handle::after');

  assert.match(sidebarRule, /border-right:\s*0/);
  assert.match(darkSidebarRule, /border-right:\s*0/);
  assert.match(handleRule, /width:\s*8px/);
  assert.match(lineRule, /width:\s*1px/);
  assert.doesNotMatch(lineRule, /width:\s*2px/);
});
