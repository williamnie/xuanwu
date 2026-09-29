import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const css = readFileSync(new URL('./DeliveryEffectivenessSection.css', import.meta.url), 'utf8');
const tokens = readFileSync(new URL('../../../../docs/design-system/tokens.css', import.meta.url), 'utf8');
test('delivery statistics inherits both themes and confines wide tables at standard breakpoints', () => {
  assert.doesNotMatch(css, /#[a-f0-9]{3,8}\b|rgba?\(|backdrop-filter|linear-gradient/i);
  for (const [, token] of css.matchAll(/var\((--[\w-]+)\)/g)) assert.ok(tokens.includes(`${token}:`), token);
  assert.match(tokens, /data-theme="dark"/);
  assert.match(css, /border-radius: var\(--button-radius\)/);
  assert.match(css, /@media \(max-width: 980px\)/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /delivery-table-scroll \{ overflow-x: auto/);
  assert.match(css, /overflow-wrap: anywhere/);
});
