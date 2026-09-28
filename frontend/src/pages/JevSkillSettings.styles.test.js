import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('./JevSkillSettings.css', import.meta.url), 'utf8');
const panelCss = readFileSync(new URL('./SkillsRuntimePanel.css', import.meta.url), 'utf8');
const tokens = readFileSync(new URL('../../../docs/design-system/tokens.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('./JevSkillSettings.jsx', import.meta.url), 'utf8');
const panel = readFileSync(new URL('./SkillsRuntimePanel.jsx', import.meta.url), 'utf8');

test('Jev settings and skills layout share defined theme tokens and compact geometry', () => {
  for (const stylesheet of [css, panelCss]) {
    assert.doesNotMatch(stylesheet, /#[a-f0-9]{3,8}\b|rgba?\(/i);
    assert.doesNotMatch(stylesheet, /var\(--radius-(?:lg|xl)\)|backdrop-filter|linear-gradient/);
    for (const [, token] of stylesheet.matchAll(/var\((--[\w-]+)\)/g)) {
      assert.ok(tokens.includes(`${token}:`), `${token} must exist in design tokens`);
    }
  }
  assert.match(tokens, /\[data-theme='dark'\]/);
  assert.match(css, /font-family: var\(--font-mono\)/);
  assert.match(css, /text-transform: uppercase/);
  assert.match(panelCss, /border-radius: var\(--button-radius\)/);
});

test('Jev fields and the skills split view become one column at the shared mobile breakpoint', () => {
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(panelCss, /@media \(max-width: 760px\)[\s\S]*grid-template-columns: 1fr/);
  assert.match(css, /flex-wrap: wrap/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(panelCss, /min-width: 0/);
});

test('optional skills use their own settings without intake or domain manual-run controls', () => {
  assert.match(panel, /skill\.optional === true \|\| skill\.kind === 'intake'/);
  assert.match(panel, /selected\.optional \? \([\s\S]*<JevSkillSettings[\s\S]*\) : \([\s\S]*<ManualRunControls/);
  assert.match(source, /type="password" autoComplete="new-password"/);
  assert.match(source, /aria-busy=\{state\.testing\}/);
  assert.match(source, /aria-busy=\{state\.saving\}/);
  assert.match(source, /result\.ok \? '连接测试通过' : '连接测试未通过'/);
  assert.match(source, /技能包缺失/);
  assert.doesNotMatch(source, /window\.alert|window\.confirm/);
});
