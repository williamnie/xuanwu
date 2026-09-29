import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const css = readFileSync(new URL('./GitHubSettingsPanel.css', import.meta.url), 'utf8');
const tokens = readFileSync(new URL('../../../docs/design-system/tokens.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('./GitHubSettingsPanel.jsx', import.meta.url), 'utf8');
test('GitHub settings share light/dark design tokens, compact buttons and readable metadata', () => {
  assert.doesNotMatch(css, /#[a-f0-9]{3,8}\b|rgba?\(|backdrop-filter|linear-gradient|var\(--radius-(?:lg|xl)\)/i);
  for (const [, token] of css.matchAll(/var\((--[\w-]+)\)/g)) assert.ok(tokens.includes(`${token}:`), token);
  assert.match(tokens, /\[data-theme='dark'\]/);
  assert.match(css, /border-radius: var\(--button-radius\)/);
  assert.match(css, /font-family: var\(--font-mono\)/);
  assert.match(css, /text-transform: uppercase/);
});
test('fields collapse at 760px and status text wraps at narrow widths', () => {
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /flex-wrap: wrap/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /min-width: 0/);
  assert.match(css, /white-space: pre-wrap/);
  assert.doesNotMatch(source, /window\.confirm|window\.alert/);
});
