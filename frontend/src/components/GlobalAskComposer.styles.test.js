import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('./GlobalAskComposer.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('./GlobalAskComposer.jsx', import.meta.url), 'utf8');

test('global composer uses the verified editor keyboard and upload surface', () => {
  assert.match(source, /<SessionComposer/);
  assert.match(source, /onSubmit=\{handleSubmit\}/);
  assert.match(source, /suggestions=\{suggestions\}/);
  assert.match(source, /referenceDetails=\{referenceDetails\}/);
  assert.match(source, /requirePrompt/);
  assert.doesNotMatch(source, /window\.alert|window\.confirm/);
});

test('global Work suggestions use one bounded page instead of a full ledger fan-out', () => {
  assert.match(source, /workApi\.getWorks\(\)/);
  assert.doesNotMatch(source, /workApi\.getAllWorks\(\)/);
});

test('global composer remains reachable on mobile and respects safe areas', () => {
  assert.match(css, /@media \(max-width: 768px\)/);
  assert.match(css, /bottom:\s*max\(8px, env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /\.sidebar-collapsed \.global-ask-composer-shell/);
  assert.match(css, /\.main-content\.has-global-ask-composer/);
});
