import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

function ruleFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test('sidebar project list fills remaining menu height', () => {
  const rule = ruleFor('.sidebar-project-list');

  assert.match(rule, /flex:\s*1\s+1\s+0/);
  assert.match(rule, /min-height:\s*0/);
  assert.doesNotMatch(rule, /max-height:\s*220px/);
});
