import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { releaseStatus } from './releaseUpdateModel.js';

const panel = readFileSync(new URL('./ReleaseUpdatePanel.jsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('./ReleaseUpdatePanel.css', import.meta.url), 'utf8');
const sections = readFileSync(new URL('./AssistantSettingsSections.jsx', import.meta.url), 'utf8');

test('general settings exposes a non-blocking safe release upgrade flow', () => {
  assert.match(sections, /<ReleaseUpdatePanel \/>/);
  assert.match(panel, /getReleaseUpdate/);
  assert.match(panel, /startReleaseUpdate/);
  assert.match(panel, /确认升级/);
  assert.match(panel, /备份.*恢复演练/);
  assert.match(panel, /setInterval/);
  assert.doesNotMatch(panel, /window\.(?:alert|confirm|prompt)/);
});

test('rollback invalidates a stale succeeded upgrade projection', () => {
  const job = { from_version: 'v0.2.5', state: 'succeeded', target_version: 'v0.2.6' };
  assert.equal(releaseStatus({ current: 'v0.2.6', latest: 'v0.2.6', supported: true, update_available: false }, job), 'succeeded');
  assert.equal(releaseStatus({ current: 'v0.2.5', latest: 'v0.2.6', supported: true, update_available: true }, job), 'available');
});

test('release update panel uses design-system tokens and responsive geometry', () => {
  assert.match(styles, /var\(--bg-card\)/);
  assert.match(styles, /var\(--radius-md\)/);
  assert.match(styles, /font-family: var\(--font-mono\)/);
  assert.match(styles, /@media \(max-width: 760px\)/);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}|rgba?\(/i);
  assert.doesNotMatch(styles, /border-radius:\s*(?:[1-9][1-9]|[1-9]\d{2,})px/);
});
