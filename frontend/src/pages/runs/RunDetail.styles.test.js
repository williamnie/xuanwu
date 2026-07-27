import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const runsCss = readFileSync(new URL('./Runs.css', import.meta.url), 'utf8');

function ruleFor(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test('embedded Provider session constrains the transcript to the Run viewport', () => {
  const providerContentRule = ruleFor(runsCss, '.run-detail-content.provider-active');
  const drilldownRule = ruleFor(runsCss, '.run-provider-drilldown');

  assert.match(providerContentRule, /display:\s*flex/);
  assert.match(providerContentRule, /flex-direction:\s*column/);
  assert.match(providerContentRule, /overflow:\s*hidden/);
  assert.match(drilldownRule, /flex:\s*1/);
  assert.match(drilldownRule, /min-height:\s*0/);
});
