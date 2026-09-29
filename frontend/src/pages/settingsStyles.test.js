import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const styles = readFileSync(new URL('./Settings.css', import.meta.url), 'utf8');
const tokens = readFileSync(new URL('../../../docs/design-system/tokens.css', import.meta.url), 'utf8');
const aliases = readFileSync(new URL('../GeekWorkbench.css', import.meta.url), 'utf8');

test('Settings shares theme tokens and keeps square controls without page-entry motion', () => {
  assert.doesNotMatch(styles, /#[a-f0-9]{3,8}\b|rgba?\(|backdrop-filter|linear-gradient|var\(--radius-(?:lg|xl)\)/i);
  assert.doesNotMatch(styles, /(?:^|[;\n])\s*transform:/i);
  for (const [, token] of styles.matchAll(/var\((--[\w-]+)\)/g)) {
    assert.ok(`${tokens}\n${aliases}`.includes(`${token}:`), `Undefined settings token ${token}`);
  }
  assert.match(styles, /border-radius: var\(--button-radius\)/);
  assert.match(styles, /\.settings-page \.animate-fade-in \{\s*animation: none;/);
  assert.match(styles, /\.settings-directory-link:focus-visible/);
});

test('Settings keeps scroll ownership stable and forms fit beside the desktop directory', () => {
  assert.match(styles, /\.settings-tab-content \{[^}]*min-height: 0;[^}]*min-width: 0;[^}]*overflow-y: auto;[^}]*scrollbar-gutter: stable;/);
  assert.match(styles, /\.settings-permission-table \{[^}]*overflow-x: auto;/);
  assert.match(styles, /grid-template-columns: repeat\(auto-fit, minmax\(min\(260px, 100%\), 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.settings-directory \{ display: none; \}/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.settings-page \.projects-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(styles, /\.settings-mobile-directory select \{[^}]*min-width: 0;/);
});
