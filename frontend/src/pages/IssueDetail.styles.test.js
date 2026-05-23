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

test('issue detail error and terminal blocks constrain long unbroken text', () => {
  const gridRule = ruleFor('.issue-detail-grid');
  assert.match(gridRule, /grid-template-columns:\s*minmax\(0,\s*2fr\)\s+minmax\(0,\s*1fr\)/);

  for (const selector of ['.issue-detail-page,\n.issue-detail-grid,\n.issue-detail-main,\n.issue-detail-side', '.issue-error-card', '.terminal-view']) {
    assert.match(ruleFor(selector), /min-width:\s*0/);
  }

  assert.match(ruleFor('.issue-error-text'), /overflow-wrap:\s*anywhere/);
  assert.match(ruleFor('.issue-error-text'), /white-space:\s*pre-wrap/);
  assert.match(ruleFor('.terminal-line'), /overflow-wrap:\s*anywhere/);
  assert.match(ruleFor('.terminal-line'), /white-space:\s*pre-wrap/);
  assert.match(ruleFor('.diff-line'), /overflow-wrap:\s*anywhere/);
});
