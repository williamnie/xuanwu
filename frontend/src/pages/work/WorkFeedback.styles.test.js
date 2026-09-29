import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const feedback = read('./WorkFeedback.css');
const evidence = read('./WorkDeliveryEvidence.css');
const tokens = read('../../../../docs/design-system/tokens.css');

test('feedback and evidence use the shared light/dark tokens and compact geometry', () => {
  for (const css of [feedback, evidence]) {
    assert.doesNotMatch(css, /#[a-f0-9]{3,8}\b|rgba?\(|backdrop-filter|linear-gradient|var\(--radius-(?:lg|xl)\)/i);
    for (const [, token] of css.matchAll(/var\((--[\w-]+)\)/g)) assert.ok(tokens.includes(`${token}:`), token);
    assert.match(css, /overflow-wrap: anywhere/);
    assert.match(css, /min-width: 0/);
    assert.match(css, /white-space: pre-wrap/);
  }
  assert.match(tokens, /\[data-theme='dark'\]/);
  assert.match(evidence, /border-radius: var\(--button-radius\)/);
  assert.match(feedback, /font-family: var\(--font-mono\)/);
  assert.match(feedback, /text-transform: uppercase/);
  assert.match(feedback, /@media \(max-width: 760px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
});
