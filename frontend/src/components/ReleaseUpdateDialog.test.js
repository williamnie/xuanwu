import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
const dialog = readFileSync(new URL('./ReleaseUpdateDialog.jsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('./ReleaseUpdateDialog.css', import.meta.url), 'utf8');

test('the app checks globally and shows one actionable release dialog', () => {
  assert.match(app, /<ReleaseUpdateDialog/);
  assert.match(dialog, /getReleaseUpdate/);
  assert.match(dialog, /CHECK_INTERVAL_MS = 6 \* 60 \* 60 \* 1000/);
  assert.match(dialog, /startReleaseUpdate/);
  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /稍后提醒/);
  assert.doesNotMatch(dialog, /window\.(?:alert|confirm|prompt)/);
});

test('release dialog follows the shared design tokens at desktop and mobile breakpoints', () => {
  assert.match(styles, /var\(--surface-overlay\)/);
  assert.match(styles, /var\(--radius-md\)/);
  assert.match(styles, /font-family: var\(--font-mono\)/);
  assert.match(styles, /@media \(max-width: 760px\)/);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}|rgba?\(/i);
});
