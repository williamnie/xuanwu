import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('./AppSidebar.jsx', import.meta.url), 'utf8');

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

test('collapsed sidebar navigation keeps accessible names when labels are visually hidden', () => {
  for (const label of ['Dashboard', 'Sessions', 'Issues', 'Cron', 'Projects']) {
    assert.match(source, new RegExp(`aria-label="${label}"`));
  }
  assert.match(source, /aria-label=\{module\.label\}/);
  assert.match(source, /aria-label=\{PI_ASSISTANT_SETTINGS_ITEM\.label\}/);
  assert.match(source, /aria-label=\{theme === 'dark' \? 'Light theme' : 'Dark theme'\}/);
});
